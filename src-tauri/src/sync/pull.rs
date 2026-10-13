//! Pull half of the sync loop: fetch a space's remote items and apply them.
//!
//! A space is one collection that holds every kind of item: folders, notes,
//! assets and, in the vault, signatures. The server hands items back in the
//! order they last changed, which is not an order they can be applied in. A
//! note needs its folder first and an asset needs its note, and a folder
//! renamed last week arrives after the notes it has held for a year.
//!
//! So nothing is applied in the order it arrives:
//!
//! * A change that fits one page is applied from that page, kind by kind.
//!   This is every sync but the first, near enough.
//! * Anything larger is listed without content first, which is cheap, and
//!   the content is then fetched kind by kind in batches. Memory stays at one
//!   batch, each item is downloaded once, and by the time a note is applied
//!   every folder of the space already has been.
//!
//! The server holds what one answer carries to a size. Past it, items come
//! back as the uids of their chunks. Those are asked for again, and an item
//! too large for any answer is fetched chunk by chunk.
//!
//! Deciding what a pulled item means for the local row is [`super::apply`]'s
//! job. Deciding whether it may touch that row at all is [`super::claim`]'s.
//! An item that may not is kept until every space has been pulled and tried
//! once more, see [`settle_held`].

use super::*;

use etebase::PrefetchOption;

/// How many items a listing without content asks for at a time. The server
/// caps what it will send.
const HEADER_PAGE: usize = 500;

/// One space as a pull sees it: the vault, or one shared folder.
pub(super) struct SpacePull<'a> {
    /// `None` for the vault, the share scope's id for a shared folder.
    pub(super) scope: Option<&'a str>,
    /// Where this space's cursor is kept in `sync_state`.
    pub(super) stoken_key: &'a str,
    /// False for a share this account can only read. Its local rows give way
    /// to the remote ones, whatever state they are in.
    pub(super) preserve_dirty_local_edits: bool,
}

/// What an item is, read from the type in its metadata.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum ItemKind {
    Folder,
    Note,
    Asset,
    Signature,
}

impl ItemKind {
    /// The order items can be applied in: a note's folder before the note,
    /// an asset's note before the asset. Signatures depend on nothing.
    pub(super) const IN_ORDER: [ItemKind; 4] = [
        ItemKind::Folder,
        ItemKind::Note,
        ItemKind::Asset,
        ItemKind::Signature,
    ];

    pub(super) fn from_item_type(item_type: Option<&str>) -> Option<Self> {
        match item_type? {
            ITEM_TYPE_FOLDER => Some(ItemKind::Folder),
            ITEM_TYPE_NOTE => Some(ItemKind::Note),
            ITEM_TYPE_ASSET => Some(ItemKind::Asset),
            ITEM_TYPE_SIGNATURE => Some(ItemKind::Signature),
            _ => None,
        }
    }

    fn of(item: &Item) -> Option<Self> {
        Self::from_item_type(item_type(item).as_deref())
    }

    /// The name the rest of the sync knows this kind by: in tombstones, and
    /// when a local row is looked up by its remote uid.
    pub(super) fn kind(self) -> &'static str {
        match self {
            ItemKind::Folder => KIND_FOLDERS,
            ItemKind::Note => KIND_NOTES,
            ItemKind::Asset => KIND_ASSETS,
            ItemKind::Signature => KIND_SIGNATURES,
        }
    }

    /// How many items to ask for in one request when fetching content. The
    /// answer is not cut to a size by the server, so the kinds that can be
    /// large go a few at a time.
    pub(super) fn batch(self) -> usize {
        match self {
            ItemKind::Folder => 200,
            ItemKind::Note => 50,
            ItemKind::Asset => 5,
            ItemKind::Signature => 20,
        }
    }
}

/// Sort a listing into what can be applied, kind by kind. Items of no known
/// kind are left out: another app's, or a newer version's.
pub(super) fn by_kind<T>(items: impl IntoIterator<Item = (Option<ItemKind>, T)>) -> [Vec<T>; 4] {
    let mut sorted: [Vec<T>; 4] = [Vec::new(), Vec::new(), Vec::new(), Vec::new()];
    for (kind, item) in items {
        if let Some(kind) = kind {
            sorted[kind as usize].push(item);
        }
    }
    sorted
}

/// A space whose pull brought items it could not apply yet, because the
/// rows they name were at home in another space. Its cursor is not saved
/// until [`settle_held`] has dealt with them.
pub(super) struct Held {
    scope: Option<String>,
    stoken_key: String,
    preserve_dirty_local_edits: bool,
    /// The cursor the pull reached.
    stoken: Option<String>,
    items: Vec<(ItemKind, Item)>,
}

/// How many syncs in a row a space's cursor may wait for an item that
/// cannot be applied. A row that is moving between spaces is settled by the
/// next sync at the latest. An item that is still refused after this many
/// is not one of those: somebody put it there to take over a row that is
/// not theirs, and it is dropped.
pub(super) const MAX_HOLDS: u32 = 3;

/// Whether a space that still holds refused items waits another sync, given
/// how many it has waited already. `Some(n)` is the count to remember.
pub(super) fn hold_again(held_before: u32) -> Option<u32> {
    (held_before + 1 < MAX_HOLDS).then_some(held_before + 1)
}

/// Where the number of syncs a space's cursor has waited is kept.
pub(crate) fn held_key(stoken_key: &str) -> String {
    format!("held:{stoken_key}")
}

fn load_holds(db: &Db, stoken_key: &str) -> AppResult<u32> {
    Ok(load_stoken(db, &held_key(stoken_key))?
        .and_then(|count| count.parse().ok())
        .unwrap_or(0))
}

fn clear_holds(db: &Db, stoken_key: &str) -> AppResult<()> {
    let key = held_key(stoken_key);
    db.with_conn(|c| {
        c.execute("DELETE FROM sync_state WHERE kind = ?1", params![key])?;
        Ok(())
    })
}

/// Try the items that were refused once more, now that every space has been
/// pulled, and move each space's cursor on when nothing of it is left over.
///
/// What is still refused holds the cursor where it was, so the next sync
/// pulls the same items again and tries again. That covers a second device
/// that pulled the space a row moved into before the space it moved out of
/// had deleted it. It is bounded by [`MAX_HOLDS`].
pub(super) fn settle_held(db: &Db, held: Vec<Held>, delta: &mut SyncDelta) -> AppResult<()> {
    for space in held {
        let pull = SpacePull {
            scope: space.scope.as_deref(),
            stoken_key: &space.stoken_key,
            preserve_dirty_local_edits: space.preserve_dirty_local_edits,
        };
        let mut applier = Applier {
            db,
            space: &pull,
            delta: &mut *delta,
            folders: Vec::new(),
            refused: Vec::new(),
        };
        for kind in ItemKind::IN_ORDER {
            for (_, item) in space.items.iter().filter(|(of, _)| *of == kind) {
                applier.apply(kind, item)?;
            }
            applier.after(kind)?;
        }
        let refused = std::mem::take(&mut applier.refused);

        if !refused.is_empty() {
            let uids: Vec<&str> = refused.iter().map(|(_, item)| item.uid()).collect();
            match hold_again(load_holds(db, &space.stoken_key)?) {
                Some(count) => {
                    log::warn!(
                        "[sync] {}: {} item(s) name rows that live in another space ({}); trying again next sync",
                        space.stoken_key,
                        uids.len(),
                        uids.join(", ")
                    );
                    save_stoken(db, &held_key(&space.stoken_key), Some(&count.to_string()))?;
                    continue;
                }
                None => log::error!(
                    "[sync] {}: dropping {} item(s) that name rows of another space ({})",
                    space.stoken_key,
                    uids.len(),
                    uids.join(", ")
                ),
            }
        }
        save_stoken(db, &space.stoken_key, space.stoken.as_deref())?;
        clear_holds(db, &space.stoken_key)?;
    }
    Ok(())
}

/// Pull everything that changed in a space since the last pull. Returns the
/// space when some of what came could not be applied yet, for
/// [`settle_held`]. Its cursor is not saved in that case.
pub(super) fn pull_space(
    db: &Db,
    im: &ItemManager,
    space: &SpacePull<'_>,
    delta: &mut SyncDelta,
) -> AppResult<Option<Held>> {
    // Outer retry handles `bad_stoken`: if the server rejects our cached
    // cursor (because the user logged into a different account, or the
    // collection was rebuilt server-side), clear it and replay the whole
    // pull from scratch. One retry is enough: if it still fails after we've
    // reset to None, the server is unhappy about something else and we
    // bubble it up.
    let mut already_retried = false;
    loop {
        match pull_space_once(db, im, space, delta) {
            Ok(held) => return Ok(held),
            Err(err) if !already_retried && is_bad_stoken_error(&err) => {
                log::warn!(
                    "[sync] bad_stoken on {} pull, resetting the cursor and retrying ({err})",
                    space.stoken_key
                );
                save_stoken(db, space.stoken_key, None)?;
                already_retried = true;
            }
            Err(err) => return Err(err),
        }
    }
}

fn pull_space_once(
    db: &Db,
    im: &ItemManager,
    space: &SpacePull<'_>,
    delta: &mut SyncDelta,
) -> AppResult<Option<Held>> {
    let stoken = load_stoken(db, space.stoken_key)?;
    let mut applier = Applier {
        db,
        space,
        delta,
        folders: Vec::new(),
        refused: Vec::new(),
    };

    let new_stoken = match stoken.as_deref() {
        // Nothing pulled yet, so everything is coming. Go by batches from
        // the start rather than download a first page only to drop it.
        None => applier.pull_in_batches(im, None)?,
        Some(since) => {
            let opts = FetchOptions::new().stoken(Some(since));
            let page = im
                .list(Some(&opts))
                .map_err(|e| AppError::InvalidArg(format!("list {}: {e}", space.stoken_key)))?;
            if page.done() {
                applier.apply_page(im, page.data())?;
                page.stoken().map(str::to_string).or_else(|| stoken.clone())
            } else {
                // More changed than one page holds, after a long time
                // offline for one. The page in hand cannot be applied on its
                // own, since what its items depend on may be on a later one.
                drop(page);
                applier.pull_in_batches(im, Some(since))?
            }
        }
    };

    let refused = std::mem::take(&mut applier.refused);
    if !refused.is_empty() {
        return Ok(Some(Held {
            scope: space.scope.map(str::to_string),
            stoken_key: space.stoken_key.to_string(),
            preserve_dirty_local_edits: space.preserve_dirty_local_edits,
            stoken: new_stoken,
            items: refused,
        }));
    }
    if new_stoken != stoken {
        save_stoken(db, space.stoken_key, new_stoken.as_deref())?;
    }
    Ok(None)
}

/// How an item came back in an answer that was asked for content.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Arrived {
    /// With its content.
    Whole,
    /// First in the answer and still without content, so no answer has room
    /// for it. Its chunks are fetched one at a time.
    TooLarge,
    /// Without content, behind others that used the room up. Asked for
    /// again it is nearer the front.
    Later,
}

impl Arrived {
    /// `place` counts from the front of the answer. The server gives content
    /// to as many items as fit, from the first, so every round of asking
    /// settles the first item at least and the asking ends.
    pub(super) fn at(place: usize, held_back: bool) -> Self {
        match (held_back, place) {
            (false, _) => Arrived::Whole,
            (true, 0) => Arrived::TooLarge,
            (true, _) => Arrived::Later,
        }
    }
}

/// Whether the server sent an item as the uids of its chunks, having no
/// room for the content. A deleted item has none to send.
pub(super) fn held_back(item: &Item) -> bool {
    !item.is_deleted() && item.is_missing_content()
}

/// The item with its content, fetched chunk by chunk.
pub(super) fn whole(im: &ItemManager, item: &Item) -> AppResult<Item> {
    let mut whole = item.clone();
    im.download_content(&mut whole)
        .map_err(|e| AppError::InvalidArg(format!("download item {}: {e}", item.uid())))?;
    Ok(whole)
}

/// Applies pulled items to the local store and keeps count.
struct Applier<'a> {
    db: &'a Db,
    space: &'a SpacePull<'a>,
    delta: &'a mut SyncDelta,
    /// Folders applied so far, for re-linking the ones whose parent had not
    /// arrived when they did.
    folders: Vec<FolderPayload>,
    /// Items that name a row whose home is another space.
    refused: Vec<(ItemKind, Item)>,
}

impl Applier<'_> {
    /// Apply one page that holds a whole change, kind by kind.
    fn apply_page(&mut self, im: &ItemManager, items: &[Item]) -> AppResult<()> {
        let sorted = by_kind(items.iter().map(|item| (ItemKind::of(item), item)));
        for kind in ItemKind::IN_ORDER {
            for item in &sorted[kind as usize] {
                if held_back(item) {
                    // The one item of a page that no page has room for.
                    self.apply(kind, &whole(im, item)?)?;
                } else {
                    self.apply(kind, item)?;
                }
            }
            self.after(kind)?;
        }
        Ok(())
    }

    /// Fetch these items of one kind with their content and apply them.
    ///
    /// The server answers with content for as many as fit its size limit,
    /// from the first, and the rest as the uids of their chunks. Those are
    /// asked for again, which puts one of them first. An item that comes
    /// back first and still without content is too large for any answer.
    fn apply_fetched(
        &mut self,
        im: &ItemManager,
        kind: ItemKind,
        uids: &[String],
    ) -> AppResult<()> {
        let mut wanted: Vec<String> = uids.to_vec();
        while !wanted.is_empty() {
            let fetched = im
                .fetch_multi(wanted.iter().map(String::as_str), None)
                .map_err(|e| {
                    AppError::InvalidArg(format!("fetch {} items: {e}", self.space.stoken_key))
                })?;
            let mut again = Vec::new();
            for (place, item) in fetched.data().iter().enumerate() {
                // Changed again since the listing, into something else or
                // into nothing: the next pull brings it.
                if ItemKind::of(item) != Some(kind) {
                    continue;
                }
                match Arrived::at(place, held_back(item)) {
                    Arrived::Whole => self.apply(kind, item)?,
                    Arrived::TooLarge => self.apply(kind, &whole(im, item)?)?,
                    Arrived::Later => again.push(item.uid().to_string()),
                }
            }
            wanted = again;
        }
        Ok(())
    }

    /// List what changed without its content, then fetch and apply the
    /// content kind by kind. Returns the cursor the listing ended on.
    fn pull_in_batches(
        &mut self,
        im: &ItemManager,
        since: Option<&str>,
    ) -> AppResult<Option<String>> {
        let what = self.space.stoken_key;
        let mut cursor = since.map(str::to_string);
        let mut wanted: [Vec<String>; 4] = [Vec::new(), Vec::new(), Vec::new(), Vec::new()];
        loop {
            let opts = FetchOptions::new()
                .stoken(cursor.as_deref())
                .prefetch(&PrefetchOption::Medium)
                .limit(HEADER_PAGE);
            let page = im
                .list(Some(&opts))
                .map_err(|e| AppError::InvalidArg(format!("list {what}: {e}")))?;
            for item in page.data() {
                let Some(kind) = ItemKind::of(item) else {
                    continue;
                };
                if item.is_deleted() {
                    // A deletion needs no content, and waits for nothing.
                    self.apply(kind, item)?;
                } else {
                    wanted[kind as usize].push(item.uid().to_string());
                }
            }
            cursor = page.stoken().map(str::to_string).or(cursor);
            if page.done() {
                break;
            }
        }

        for kind in ItemKind::IN_ORDER {
            for batch in wanted[kind as usize].chunks(kind.batch()) {
                self.apply_fetched(im, kind, batch)?;
            }
            self.after(kind)?;
        }
        Ok(cursor)
    }

    /// What has to happen once every item of a kind has been applied.
    fn after(&mut self, kind: ItemKind) -> AppResult<()> {
        if kind == ItemKind::Folder {
            // Reattach any child whose parent had not arrived yet. Folders
            // come in no order among themselves either.
            repair_folder_parents(self.db, &self.folders)?;
            self.folders.clear();
        }
        Ok(())
    }

    fn apply(&mut self, kind: ItemKind, item: &Item) -> AppResult<()> {
        let scope = self.space.scope;
        let preserve = self.space.preserve_dirty_local_edits;
        let report = &mut self.delta.report;
        let refused = &mut self.refused;
        let mut refuse = || refused.push((kind, item.clone()));
        let applied = match kind {
            ItemKind::Folder => {
                apply_folder(self.db, item, scope, preserve).map(|pulled| match pulled {
                    Pulled::Done(payload) => {
                        self.folders.extend(payload);
                        report.folders_pulled += 1;
                    }
                    Pulled::Refused => refuse(),
                })
            }
            ItemKind::Note => {
                apply_note(self.db, item, scope, preserve).map(|pulled| match pulled {
                    Pulled::Done(id) => {
                        self.delta.notes_pulled_ids.extend(id);
                        report.notes_pulled += 1;
                    }
                    Pulled::Refused => refuse(),
                })
            }
            ItemKind::Asset => apply_asset(self.db, item, scope).map(|pulled| match pulled {
                Pulled::Done(ApplyAssetOutcome::Applied(id)) => {
                    report.assets_pulled += 1;
                    self.delta.assets_pulled_ids.push(id);
                }
                // Its note is not in this space, or could not be read. The
                // note was applied before it if it was coming at all, so
                // waiting would not help.
                Pulled::Done(ApplyAssetOutcome::Orphaned) => log::warn!(
                    "[sync] asset item {} belongs to a note this device does not have; skipped",
                    item.uid()
                ),
                Pulled::Done(ApplyAssetOutcome::Skipped) => {}
                Pulled::Refused => refuse(),
            }),
            // Signatures are the account's own. A shared folder has none.
            ItemKind::Signature if scope.is_some() => Ok(()),
            ItemKind::Signature => apply_signature(self.db, item).map(|applied| {
                if applied {
                    report.signatures_pulled += 1;
                }
            }),
        };
        match applied {
            Ok(()) => Ok(()),
            Err(err) if is_corrupt_remote_content(&err) => self.note_corrupt(kind, item, &err),
            Err(err) => Err(err),
        }
    }

    /// An item whose content does not decode. One bad item must not stop a
    /// sync, so it is skipped. In the vault, where this device may hold a
    /// good copy and is allowed to write, that copy is marked for upload so
    /// the next push repairs the server's.
    fn note_corrupt(&self, kind: ItemKind, item: &Item, err: &AppError) -> AppResult<()> {
        let name = kind.kind();
        if self.space.scope.is_none() {
            if mark_local_by_remote_uid_dirty(self.db, name, item.uid())? {
                log::warn!(
                    "[sync] marked local {name} item {} dirty for remote repair",
                    item.uid()
                );
            } else {
                log::error!(
                    "[sync] corrupt remote {name} item {} has no local copy, manual recovery required",
                    item.uid()
                );
            }
        }
        log::error!(
            "[sync] skipping corrupt remote {name} item {}: {err}",
            item.uid()
        );
        Ok(())
    }
}
