//! Pull half of the sync loop: fetch remote items by stoken.
//!
//! Each `pull_*` entry point wraps a `pull_*_once` pass so a `bad_stoken`
//! can be retried from scratch after resetting the cursor. Deciding what
//! a pulled item means for the local row is [`super::apply`]'s job.

use super::*;

// ---------- Pull ----------

pub(super) fn pull_folders(db: &Db, im: &ItemManager, report: &mut SyncReport) -> AppResult<()> {
    // Outer retry handles `bad_stoken`: if the etebase server rejects
    // our cached cursor (because the user logged into a different
    // account, or the collection was rebuilt server-side), clear the
    // stoken and replay the whole pull from scratch. One retry is
    // enough — if it still fails after we've reset to None, the
    // server is unhappy about something else and we bubble it up.
    let mut already_retried = false;
    loop {
        match pull_folders_once(db, im, report) {
            Ok(()) => return Ok(()),
            Err(err) if !already_retried && is_bad_stoken_error(&err) => {
                log::warn!(
                    "[sync] bad_stoken on folders pull — resetting cursor and retrying ({err})"
                );
                save_stoken(db, KIND_FOLDERS, None)?;
                already_retried = true;
                continue;
            }
            Err(err) => return Err(err),
        }
    }
}

pub(super) fn pull_folders_once(
    db: &Db,
    im: &ItemManager,
    report: &mut SyncReport,
) -> AppResult<()> {
    let stoken = load_stoken(db, KIND_FOLDERS)?;
    let mut new_stoken = stoken.clone();
    let mut iter_token: Option<String> = None;
    // Buffer of payloads we applied this pull so the repair pass below
    // can re-link any folder we had to orphan to root because its
    // parent hadn't been pulled yet. Etebase doesn't guarantee
    // parent-before-child ordering in the list response, so this is
    // the common case for nested hierarchies on a fresh install.
    let mut applied: Vec<FolderPayload> = Vec::new();
    loop {
        let mut opts = FetchOptions::new();
        opts = opts.stoken(new_stoken.as_deref());
        if let Some(it) = &iter_token {
            opts = opts.iterator(Some(it.as_str()));
        }
        let resp = im
            .list(Some(&opts))
            .map_err(|e| AppError::InvalidArg(format!("list folders: {e}")))?;
        for item in resp.data() {
            match apply_folder(db, item, None, true) {
                Ok(Some(payload)) => applied.push(payload),
                Ok(None) => {}
                Err(err) if is_corrupt_remote_content(&err) => {
                    if mark_local_by_remote_uid_dirty(db, KIND_FOLDERS, item.uid())? {
                        log::warn!(
                            "[sync] marked local folder item {} dirty for remote repair",
                            item.uid()
                        );
                    } else {
                        log::error!(
                            "[sync] corrupt remote folder item {} has no local copy — manual recovery required",
                            item.uid()
                        );
                    }
                    log::error!(
                        "[sync] skipping corrupt remote folder item {}: {err}",
                        item.uid()
                    );
                }
                Err(err) => return Err(err),
            }
            report.folders_pulled += 1;
        }
        new_stoken = resp.stoken().map(str::to_string).or(new_stoken);
        if resp.done() {
            break;
        }
        iter_token = None; // server uses stoken paging via response
    }
    repair_folder_parents(db, &applied)?;
    if new_stoken != stoken {
        save_stoken(db, KIND_FOLDERS, new_stoken.as_deref())?;
    }
    Ok(())
}

pub(super) fn pull_notes(
    db: &Db,
    im: &ItemManager,
    report: &mut SyncReport,
    applied_ids: &mut Vec<String>,
) -> AppResult<()> {
    // Same bad_stoken self-heal pattern as pull_folders — see the
    // comment there.
    let mut already_retried = false;
    loop {
        match pull_notes_once(db, im, report, applied_ids) {
            Ok(()) => return Ok(()),
            Err(err) if !already_retried && is_bad_stoken_error(&err) => {
                log::warn!(
                    "[sync] bad_stoken on notes pull — resetting cursor and retrying ({err})"
                );
                save_stoken(db, KIND_NOTES, None)?;
                already_retried = true;
                continue;
            }
            Err(err) => return Err(err),
        }
    }
}

pub(super) fn pull_notes_once(
    db: &Db,
    im: &ItemManager,
    report: &mut SyncReport,
    applied_ids: &mut Vec<String>,
) -> AppResult<()> {
    let stoken = load_stoken(db, KIND_NOTES)?;
    let mut new_stoken = stoken.clone();
    loop {
        let mut opts = FetchOptions::new();
        opts = opts.stoken(new_stoken.as_deref());
        let resp = im
            .list(Some(&opts))
            .map_err(|e| AppError::InvalidArg(format!("list notes: {e}")))?;
        for item in resp.data() {
            match apply_note(db, item, None, true) {
                Ok(Some(id)) => applied_ids.push(id),
                Ok(None) => {}
                Err(err) if is_corrupt_remote_content(&err) => {
                    if mark_local_by_remote_uid_dirty(db, KIND_NOTES, item.uid())? {
                        log::warn!(
                            "[sync] marked local note item {} dirty for remote repair",
                            item.uid()
                        );
                    } else {
                        log::error!(
                            "[sync] corrupt remote note item {} has no local copy — manual recovery required",
                            item.uid()
                        );
                    }
                    log::error!(
                        "[sync] skipping corrupt remote note item {}: {err}",
                        item.uid()
                    );
                }
                Err(err) => return Err(err),
            }
            report.notes_pulled += 1;
        }
        new_stoken = resp.stoken().map(str::to_string).or(new_stoken);
        if resp.done() {
            break;
        }
    }
    if new_stoken != stoken {
        save_stoken(db, KIND_NOTES, new_stoken.as_deref())?;
    }
    Ok(())
}

/// Pull drawing-asset items from the assets collection into local SQLite.
///
/// Mirrors pull_notes: stoken-paged iteration, apply_asset per item. The
/// one extra wrinkle is that an asset row carries a FK to its owning
/// note — if the note isn't local yet (a race window where the note was
/// created on the remote between our notes pull and this assets pull),
/// apply_asset returns "orphaned" and we set `had_orphans` so we don't
/// advance the stoken. Next sync's notes pull picks up the missing
/// note, then this re-runs from the same stoken and the previously-
/// orphaned assets land cleanly.
pub(super) fn pull_assets(
    db: &Db,
    im: &ItemManager,
    report: &mut SyncReport,
    applied_ids: &mut Vec<String>,
) -> AppResult<()> {
    // Same bad_stoken self-heal pattern as pull_folders.
    let mut already_retried = false;
    loop {
        match pull_assets_once(db, im, report, applied_ids) {
            Ok(()) => return Ok(()),
            Err(err) if !already_retried && is_bad_stoken_error(&err) => {
                log::warn!(
                    "[sync] bad_stoken on assets pull — resetting cursor and retrying ({err})"
                );
                save_stoken(db, KIND_ASSETS, None)?;
                already_retried = true;
                continue;
            }
            Err(err) => return Err(err),
        }
    }
}

pub(super) fn pull_assets_once(
    db: &Db,
    im: &ItemManager,
    report: &mut SyncReport,
    applied_ids: &mut Vec<String>,
) -> AppResult<()> {
    let stoken = load_stoken(db, KIND_ASSETS)?;
    let mut new_stoken = stoken.clone();
    let mut had_orphans = false;
    loop {
        let mut opts = FetchOptions::new();
        opts = opts.stoken(new_stoken.as_deref());
        let resp = im
            .list(Some(&opts))
            .map_err(|e| AppError::InvalidArg(format!("list assets: {e}")))?;
        for item in resp.data() {
            match apply_asset(db, item, None) {
                Ok(ApplyAssetOutcome::Applied(id)) => {
                    report.assets_pulled += 1;
                    applied_ids.push(id);
                }
                Ok(ApplyAssetOutcome::Orphaned) => {
                    had_orphans = true;
                }
                Ok(ApplyAssetOutcome::Skipped) => {}
                Err(err) if is_corrupt_remote_content(&err) => {
                    if mark_local_by_remote_uid_dirty(db, KIND_ASSETS, item.uid())? {
                        log::warn!(
                            "[sync] marked local asset item {} dirty for remote repair",
                            item.uid()
                        );
                    } else {
                        log::error!(
                            "[sync] corrupt remote asset item {} has no local copy — manual recovery required",
                            item.uid()
                        );
                    }
                    log::error!(
                        "[sync] skipping corrupt remote asset item {}: {err}",
                        item.uid()
                    );
                }
                Err(err) => return Err(err),
            }
        }
        new_stoken = resp.stoken().map(str::to_string).or(new_stoken);
        if resp.done() {
            break;
        }
    }
    if !had_orphans && new_stoken != stoken {
        save_stoken(db, KIND_ASSETS, new_stoken.as_deref())?;
    }
    Ok(())
}

// ---------- Signatures pull ----------

pub(super) fn pull_signatures(db: &Db, im: &ItemManager, report: &mut SyncReport) -> AppResult<()> {
    // Same bad_stoken self-heal pattern as pull_folders / pull_assets.
    let mut already_retried = false;
    loop {
        match pull_signatures_once(db, im, report) {
            Ok(()) => return Ok(()),
            Err(err) if !already_retried && is_bad_stoken_error(&err) => {
                log::warn!(
                    "[sync] bad_stoken on signatures pull — resetting cursor and retrying ({err})"
                );
                save_stoken(db, KIND_SIGNATURES, None)?;
                already_retried = true;
                continue;
            }
            Err(err) => return Err(err),
        }
    }
}

pub(super) fn pull_signatures_once(
    db: &Db,
    im: &ItemManager,
    report: &mut SyncReport,
) -> AppResult<()> {
    let stoken = load_stoken(db, KIND_SIGNATURES)?;
    let mut new_stoken = stoken.clone();
    loop {
        let mut opts = FetchOptions::new();
        opts = opts.stoken(new_stoken.as_deref());
        let resp = im
            .list(Some(&opts))
            .map_err(|e| AppError::InvalidArg(format!("list signatures: {e}")))?;
        for item in resp.data() {
            match apply_signature(db, item) {
                Ok(true) => report.signatures_pulled += 1,
                Ok(false) => {}
                Err(err) if is_corrupt_remote_content(&err) => {
                    if mark_local_by_remote_uid_dirty(db, KIND_SIGNATURES, item.uid())? {
                        log::warn!(
                            "[sync] marked local signature item {} dirty for remote repair",
                            item.uid()
                        );
                    } else {
                        log::error!(
                            "[sync] corrupt remote signature item {} has no local copy — manual recovery required",
                            item.uid()
                        );
                    }
                    log::error!(
                        "[sync] skipping corrupt remote signature item {}: {err}",
                        item.uid()
                    );
                }
                Err(err) => return Err(err),
            }
        }
        new_stoken = resp.stoken().map(str::to_string).or(new_stoken);
        if resp.done() {
            break;
        }
    }
    if new_stoken != stoken {
        save_stoken(db, KIND_SIGNATURES, new_stoken.as_deref())?;
    }
    Ok(())
}
