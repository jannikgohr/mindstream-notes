//! Finding — and converging on — the Etebase Collection behind each
//! singleton kind.
//!
//! Two fresh devices can each create their own collection in the
//! first-sync race. The reconcile window makes every device deterministically
//! adopt the lexicographically smallest live uid, and the loser migrates its
//! rows over. Once stable, a cached uid short-circuits the listing.

use super::*;

/// How many consecutive stable syncs (winner == cached) we require before
/// disarming the reconcile window and reverting to the cache fast path. Each
/// create/migrate re-arms to this value. Three passes at the "live" 30s
/// cadence is ~90s — comfortably longer than the concurrent first-sync window
/// where two fresh devices could otherwise cement a split-brain.
pub(super) const RECONCILE_PASSES: i64 = 3;

/// Find the Etebase Collection of `collection_type` that we previously
/// created, or create one, keeping the account's devices converged on a
/// single collection per singleton `kind`.
///
/// Cache-first once *disarmed*: a cached uid that still fetches is returned
/// without listing, so steady-state sync stays cheap.
///
/// While *armed* (`reconcile_passes_left > 0`) — the window after any
/// create/migrate, and the few syncs after this migration lands — we list the
/// account's collections of this type and converge on the lexicographically
/// smallest live uid. That min is a deterministic winner every device computes
/// identically, so two fresh devices that each created their own collection in
/// the first-sync race both adopt the same one; the loser migrates its rows
/// over (see `switch_to_collection`) and the abandoned collection is simply
/// left orphaned server-side. A stable pass decrements the counter; reaching
/// zero disarms.
pub(super) fn ensure_collection(
    db: &Db,
    cm: &CollectionManager,
    kind: &str,
    collection_type: &str,
    share_scope_part_uids: &HashSet<String>,
) -> AppResult<Collection> {
    let (cached_uid, passes_left) = load_collection_state(db, kind)?;

    // Disarmed fast path: trust the cache exactly like before. Only fall
    // through to the (re)listing path if the cached collection can't be
    // fetched — a cache miss must not silently mint a duplicate.
    if passes_left == 0 {
        if let Some(uid) = &cached_uid {
            match cm.fetch(uid, None) {
                Ok(col) => {
                    let candidate = VaultCollectionCandidate::from(&col);
                    if usable_vault_collection(&candidate, share_scope_part_uids) {
                        return Ok(col);
                    }
                    log::warn!(
                        "[sync] cached collection {} for {kind} is not usable as a vault singleton; reconciling",
                        col.uid()
                    );
                }
                Err(e) => log::warn!("[sync] cached collection {uid} for {kind} unfetchable: {e}"),
            }
        }
    }

    let list = cm
        .list(collection_type, None)
        .map_err(|e| AppError::InvalidArg(format!("list {collection_type}: {e}")))?;
    let winner_uid = list
        .data()
        .iter()
        .map(VaultCollectionCandidate::from)
        .filter(|candidate| usable_vault_collection(candidate, share_scope_part_uids))
        .map(|candidate| candidate.uid.to_string())
        .min();

    if let Some(winner) = winner_uid {
        if cached_uid.as_deref() == Some(winner.as_str()) {
            // Stable this pass — count down toward disarm.
            set_reconcile_passes(db, kind, passes_left.saturating_sub(1))?;
        } else {
            // Adopt/migrate onto the winner and re-arm the window. On a fresh
            // device this is the harmless "adopt existing" case (rows are
            // already dirty with NULL item uids); on a loser it re-homes rows
            // off the duplicate collection.
            switch_to_collection(db, kind, &winner)?;
        }
        return cm
            .fetch(&winner, None)
            .map_err(|e| AppError::InvalidArg(format!("fetch {collection_type}: {e}")));
    }

    // None exist yet — create, upload, arm the window.
    let mut meta = ItemMetadata::new();
    meta.set_name(Some(match kind {
        KIND_NOTES => "Mindstream Notes",
        KIND_FOLDERS => "Mindstream Folders",
        KIND_ASSETS => "Mindstream Assets",
        KIND_SIGNATURES => "Mindstream Signatures",
        _ => "Mindstream",
    }))
    .set_mtime(Some(now_unix_ms()));
    let col = cm
        .create(collection_type, &meta, &[])
        .map_err(|e| AppError::InvalidArg(format!("create {collection_type}: {e}")))?;
    cm.upload(&col, None)
        .map_err(|e| AppError::InvalidArg(format!("upload {collection_type}: {e}")))?;
    save_collection_uid(db, kind, col.uid())?;
    Ok(col)
}

/// Read the cached collection uid and remaining reconcile passes for `kind`.
/// A missing row means "never synced this kind" → armed (RECONCILE_PASSES) so
/// the first sync goes through the listing/converge path.
pub(super) fn load_collection_state(db: &Db, kind: &str) -> AppResult<(Option<String>, i64)> {
    db.with_conn(|c| {
        Ok(c.query_row(
            "SELECT etebase_collection_uid, reconcile_passes_left
             FROM sync_state WHERE kind = ?1",
            params![kind],
            |r| Ok((r.get::<_, Option<String>>(0)?, r.get::<_, i64>(1)?)),
        )
        .optional()?
        .unwrap_or((None, RECONCILE_PASSES)))
    })
}

pub(super) fn set_reconcile_passes(db: &Db, kind: &str, passes: i64) -> AppResult<()> {
    db.with_conn(|c| {
        c.execute(
            "UPDATE sync_state SET reconcile_passes_left = ?1 WHERE kind = ?2",
            params![passes, kind],
        )?;
        Ok(())
    })
}

/// Point `kind`'s cache at a newly created collection and arm the reconcile
/// window. Resets stoken because a new collection uid invalidates the old
/// pull cursor.
pub(super) fn save_collection_uid(db: &Db, kind: &str, uid: &str) -> AppResult<()> {
    db.with_conn(|c| {
        c.execute(
            "INSERT INTO sync_state (kind, etebase_collection_uid, stoken, reconcile_passes_left)
             VALUES (?1, ?2, NULL, ?3)
             ON CONFLICT(kind) DO UPDATE SET
                etebase_collection_uid = excluded.etebase_collection_uid,
                stoken = NULL,
                reconcile_passes_left = excluded.reconcile_passes_left",
            params![kind, uid, RECONCILE_PASSES],
        )?;
        Ok(())
    })
}

/// Migrate this device onto the reconcile winner for `kind`. Points the cache
/// at `winner_uid`, clears the stale pull cursor, re-arms the window, and
/// routes every vault row of this kind back through push's create path against
/// the winner by clearing its old collection-scoped item uid/etag and marking
/// it dirty. The winner already holds the surviving copies; rows converge by
/// their stable app id on the next pull, and rows only this device had are
/// re-created in the winner. Scoped (shared) rows keep their own routing and
/// the local-only 'trash' folder is never pushed.
pub(super) fn switch_to_collection(db: &Db, kind: &str, winner_uid: &str) -> AppResult<()> {
    db.with_conn(|c| {
        c.execute(
            "INSERT INTO sync_state (kind, etebase_collection_uid, stoken, reconcile_passes_left)
             VALUES (?1, ?2, NULL, ?3)
             ON CONFLICT(kind) DO UPDATE SET
                etebase_collection_uid = excluded.etebase_collection_uid,
                stoken = NULL,
                reconcile_passes_left = excluded.reconcile_passes_left",
            params![kind, winner_uid, RECONCILE_PASSES],
        )?;
        let sql = match kind {
            KIND_NOTES => {
                "UPDATE notes SET dirty = 1, etebase_uid = NULL, etebase_etag = NULL
                 WHERE share_scope_id IS NULL"
            }
            KIND_FOLDERS => {
                "UPDATE collections SET dirty = 1, etebase_uid = NULL, etebase_etag = NULL
                 WHERE share_scope_id IS NULL AND id != 'trash'"
            }
            KIND_ASSETS => {
                "UPDATE assets SET dirty = 1, etebase_uid = NULL, etebase_etag = NULL
                 WHERE share_scope_id IS NULL"
            }
            KIND_SIGNATURES => {
                "UPDATE signatures SET dirty = 1, etebase_uid = NULL, etebase_etag = NULL"
            }
            _ => return Ok(()),
        };
        c.execute(sql, [])?;
        Ok(())
    })?;
    log::info!("[sync] {kind} reconciled onto collection {winner_uid}");
    Ok(())
}
