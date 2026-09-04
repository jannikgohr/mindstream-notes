//! Schema migrations.
//!
//! `MIGRATIONS` is the canonical list, ordered by target version. On
//! startup we read `PRAGMA user_version` and apply every migration whose
//! `to` is greater than the current version, inside one transaction each.
//! Bump the version + add an entry; never edit a shipped migration.

use rusqlite::{params, Connection};

use crate::error::{AppError, AppResult};

struct Migration {
    to: u32,
    sql: &'static str,
}

const MIGRATIONS: &[Migration] = &[
    Migration {
        to: 1,
        sql: r#"
            CREATE TABLE collections (
                id                   TEXT PRIMARY KEY,
                parent_collection_id TEXT REFERENCES collections(id) ON DELETE CASCADE,
                name                 TEXT NOT NULL,
                position             INTEGER NOT NULL DEFAULT 0,
                created              TEXT NOT NULL,
                modified             TEXT NOT NULL
            );
            CREATE INDEX idx_collections_parent ON collections(parent_collection_id);

            CREATE TABLE notes (
                id                   TEXT PRIMARY KEY,
                parent_collection_id TEXT REFERENCES collections(id) ON DELETE SET NULL,
                title                TEXT NOT NULL DEFAULT 'Untitled',
                body                 TEXT NOT NULL DEFAULT '',
                position             INTEGER NOT NULL DEFAULT 0,
                created              TEXT NOT NULL,
                modified             TEXT NOT NULL,
                trashed_at           TEXT
            );
            CREATE INDEX idx_notes_parent  ON notes(parent_collection_id);
            CREATE INDEX idx_notes_trashed ON notes(trashed_at);

            CREATE TABLE note_tags (
                note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
                tag     TEXT NOT NULL,
                PRIMARY KEY (note_id, tag)
            );
        "#,
    },
    Migration {
        to: 2,
        // Special "trash" collection that's always present. Notes/folders
        // moved here are considered soft-deleted from the user's POV. The
        // huge position sentinel keeps it at the bottom of position-ordered
        // listings; the file tree also pins it last visually regardless.
        sql: r#"
            INSERT OR IGNORE INTO collections(
                id, parent_collection_id, name, position, created, modified
            ) VALUES (
                'trash', NULL, 'Trash', 9999999,
                '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z'
            );
        "#,
    },
    Migration {
        to: 3,
        // notes.parent_collection_id was created with ON DELETE SET NULL,
        // which silently moved notes to the root when their folder was
        // deleted (the user observed this as a bug — they expected the
        // notes to go with the folder). SQLite can't ALTER an existing
        // FK constraint, so we rebuild the table:
        //   create notes_v2 with the right FK -> copy -> drop old -> rename.
        // foreign_keys is toggled off around the whole run() loop so
        // note_tags doesn't refuse the temporary orphan during the swap.
        sql: r#"
            CREATE TABLE notes_v2 (
                id                   TEXT PRIMARY KEY,
                parent_collection_id TEXT REFERENCES collections(id) ON DELETE CASCADE,
                title                TEXT NOT NULL DEFAULT 'Untitled',
                body                 TEXT NOT NULL DEFAULT '',
                position             INTEGER NOT NULL DEFAULT 0,
                created              TEXT NOT NULL,
                modified             TEXT NOT NULL,
                trashed_at           TEXT
            );
            INSERT INTO notes_v2(id, parent_collection_id, title, body,
                                 position, created, modified, trashed_at)
                SELECT id, parent_collection_id, title, body,
                       position, created, modified, trashed_at FROM notes;
            DROP TABLE notes;
            ALTER TABLE notes_v2 RENAME TO notes;
            CREATE INDEX idx_notes_parent  ON notes(parent_collection_id);
            CREATE INDEX idx_notes_trashed ON notes(trashed_at);
        "#,
    },
    Migration {
        to: 4,
        // Etebase sync state. Two parallel Etebase Collections back the
        // local SQLite (one of `ms-md-folder` items, one of `ms-md-note`
        // items); see src/sync/mod.rs. Per-row columns:
        //   etebase_uid   — server-assigned item UID, NULL until first push
        //   etebase_etag  — last server etag we observed (for transaction
        //                   optimistic-concurrency checks)
        //   yrs_state     — encoded yrs Doc state (notes only); the
        //                   markdown body remains the canonical local
        //                   read view, but yrs is what crosses the wire
        //   dirty         — 1 if local row has changes not yet pushed.
        //                   Defaulting to 1 means existing pre-sync rows
        //                   get pushed up the first time the user logs in.
        //
        // sync_state holds one row per kind ('folders' | 'notes') with
        // the Etebase Collection UID we created/found and the last
        // stoken we pulled to. Tombstones queue server-side deletes
        // for items that were purged locally after they'd already been
        // synced.
        sql: r#"
            ALTER TABLE notes ADD COLUMN etebase_uid  TEXT;
            ALTER TABLE notes ADD COLUMN etebase_etag TEXT;
            ALTER TABLE notes ADD COLUMN yrs_state    BLOB;
            ALTER TABLE notes ADD COLUMN dirty        INTEGER NOT NULL DEFAULT 1;

            ALTER TABLE collections ADD COLUMN etebase_uid  TEXT;
            ALTER TABLE collections ADD COLUMN etebase_etag TEXT;
            ALTER TABLE collections ADD COLUMN dirty        INTEGER NOT NULL DEFAULT 1;

            -- Built-in 'trash' folder is a local construct; never push it.
            UPDATE collections SET dirty = 0 WHERE id = 'trash';

            CREATE TABLE sync_state (
                kind                   TEXT PRIMARY KEY,
                etebase_collection_uid TEXT,
                stoken                 TEXT
            );

            CREATE TABLE tombstones (
                kind        TEXT NOT NULL,    -- 'note' | 'folder'
                etebase_uid TEXT NOT NULL,
                queued_at   TEXT NOT NULL,
                PRIMARY KEY (kind, etebase_uid)
            );

            CREATE INDEX idx_notes_dirty       ON notes(dirty)       WHERE dirty = 1;
            CREATE INDEX idx_collections_dirty ON collections(dirty) WHERE dirty = 1;
            CREATE INDEX idx_notes_etebase_uid       ON notes(etebase_uid)       WHERE etebase_uid IS NOT NULL;
            CREATE INDEX idx_collections_etebase_uid ON collections(etebase_uid) WHERE etebase_uid IS NOT NULL;
        "#,
    },
    Migration {
        to: 5,
        // Live-collab support, two columns:
        //   crypto_key      — 32-byte AES-GCM secret used when this note's
        //                     editor connects to the collab relay. Generated
        //                     on first push and shipped to other devices via
        //                     the v2 NotePayload (see sync/mod.rs). NULL means
        //                     "not yet generated" — note hasn't been pushed
        //                     or predates this migration; live collab is
        //                     unavailable until the next push fills it in.
        //   payload_schema  — which NotePayload format the local yrs_state
        //                     uses. 1 = legacy Y.Text "body" (Rust-side diff
        //                     path); 2 = y-prosemirror XmlFragment owned by
        //                     the live editor. The editor reads this on open
        //                     to decide whether to migrate the doc.
        sql: r#"
            ALTER TABLE notes ADD COLUMN crypto_key     BLOB;
            ALTER TABLE notes ADD COLUMN payload_schema INTEGER NOT NULL DEFAULT 1;
        "#,
    },
    Migration {
        to: 6,
        // Favourite flag, replacing the mobile shell's localStorage Set
        // that pre-dated this migration. Stored as a 0/1 INTEGER (SQLite
        // has no real bool) and pushed in the v2 NotePayload as a plain
        // bool field (serde-defaulted so older payloads decode as false).
        sql: r#"
            ALTER TABLE notes ADD COLUMN favourite INTEGER NOT NULL DEFAULT 0;
            CREATE INDEX idx_notes_favourite ON notes(favourite) WHERE favourite = 1;
        "#,
    },
    Migration {
        to: 7,
        // Drop the locally-cached per-note collab key. The source of
        // truth is etebase's NotePayload.crypto_key; the editor fetches
        // it on demand via note_room_info each time a note is opened.
        // Keeping it out of SQLite makes "logged out ⇒ can't join the
        // live room" a property of the data model rather than a guard
        // we have to remember to apply at every code path.
        sql: r#"
            ALTER TABLE notes DROP COLUMN crypto_key;
        "#,
    },
    Migration {
        to: 8,
        // note_kind discriminates between note variants the editor knows
        // how to render. Values currently in use:
        //   'markdown'  — Crepe / y-prosemirror editor (the existing default)
        //   'freeform'  — drawing canvas backed by a Y.Doc
        // Stored as TEXT (instead of an INTEGER enum) so future kinds can
        // be added without renumbering and so a quick `SELECT note_kind`
        // is self-documenting when inspecting the DB by hand.
        // Defaulted to 'markdown' so every existing row decodes correctly
        // without a backfill pass.
        sql: r#"
            ALTER TABLE notes ADD COLUMN note_kind TEXT NOT NULL DEFAULT 'markdown';
        "#,
    },
    Migration {
        to: 9,
        // Freeform notes briefly stored their content as a Y.Array of
        // hand-rolled StrokeRecord items (the first-cut canvas editor).
        // The editor now embeds a third-party drawing surface whose doc
        // shape is different from the first-cut StrokeRecord format.
        // The old state can't be decoded by newer canvas editors and would
        // surface as a corrupted / empty drawing on first open.
        //
        // Wipe yrs_state for every freeform row so the canvas initialises a
        // fresh store on next open. The body column was always empty
        // for freeform notes (no markdown rendering) so it's untouched.
        // Markdown notes are unaffected.
        sql: r#"
            UPDATE notes
            SET yrs_state = NULL, payload_schema = 1, dirty = 1
            WHERE note_kind = 'freeform';
        "#,
    },
    Migration {
        to: 10,
        // Assets table for freeform-note attachments (images today, any
        // file blob the user drops onto the canvas later).
        //
        // Schema mirrors the notes table's sync model so the same
        // dirty / etebase_uid / etebase_etag flow can later push these
        // through the existing sync engine (slice 2b). For this slice
        // assets live only on the device that created them — the sync
        // columns are reserved with `dirty = 1` defaults so when we
        // wire the push, every existing row gets uploaded automatically.
        //
        //   id              client-generated UUID (`asset_<uuid>`). The
        //                   Drawing records can store this as the asset's
        //                   src URL via `mindstream-asset://<id>`, so it's
        //                   the stable cross-device identifier.
        //
        //   owning_note_id  FK with ON DELETE CASCADE so purging a
        //                   freeform note also clears its assets. A
        //                   tombstone row for each removed asset is
        //                   created at the sync layer (slice 2b);
        //                   nothing depends on cascade triggers for now.
        //
        //   bytes           raw file content. Stored locally even after
        //                   Etebase push so we don't refetch over the
        //                   network on every canvas render.
        //
        //   mime_type       carried alongside bytes so resolve() can
        //                   set the Blob's type and the browser picks
        //                   the right decoder for image/video/etc.
        //
        //   size            cached byte length. Helps future quota
        //                   logic; redundant with `length(bytes)` but
        //                   indexable.
        sql: r#"
            CREATE TABLE assets (
                id               TEXT PRIMARY KEY,
                owning_note_id   TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
                mime_type        TEXT NOT NULL,
                bytes            BLOB NOT NULL,
                size             INTEGER NOT NULL,
                created          TEXT NOT NULL,
                modified         TEXT NOT NULL,
                etebase_uid      TEXT,
                etebase_etag     TEXT,
                dirty            INTEGER NOT NULL DEFAULT 1
            );
            CREATE INDEX idx_assets_owning_note ON assets(owning_note_id);
            CREATE INDEX idx_assets_dirty       ON assets(dirty)       WHERE dirty = 1;
            CREATE INDEX idx_assets_etebase_uid ON assets(etebase_uid) WHERE etebase_uid IS NOT NULL;
        "#,
    },
    Migration {
        to: 11,
        // Track when items enter the trash so the retention sweep can age
        // them out. Notes already had `trashed_at` from the soft-delete
        // path (see notes::trash); collections gain the equivalent so the
        // sweep can find direct-child trash items uniformly.
        //
        // Backfill: anything currently reparented under the 'trash'
        // collection got there before this migration without a recorded
        // timestamp. `modified` is the best guess we have — it's the
        // moment the parent move was persisted, which is correct for
        // every reparent except later in-place edits (rare for trash).
        //
        // The new column also unlocks a sync-side improvement later:
        // collection moves into trash can carry `trashed_at` across
        // devices the same way notes already do. Not wired into the
        // payload yet — that's a future slice.
        sql: r#"
            ALTER TABLE collections ADD COLUMN trashed_at TEXT;
            CREATE INDEX idx_collections_trashed ON collections(trashed_at);

            UPDATE collections
               SET trashed_at = modified
             WHERE parent_collection_id = 'trash'
               AND trashed_at IS NULL;

            UPDATE notes
               SET trashed_at = modified
             WHERE parent_collection_id = 'trash'
               AND trashed_at IS NULL;
        "#,
    },
    Migration {
        to: 12,
        // Reusable signature library, synced cross-device. Signatures used
        // to live in browser localStorage (per-origin, per-device); this
        // table gives them the same dirty / etebase_uid / etebase_etag sync
        // model as `assets` so the existing engine pushes/pulls them as
        // per-signature items in a new `mindstream.signatures` collection.
        //
        //   id        client-generated UUID, stable cross-device identifier.
        //   data      JSON blob: { width, height, strokes[] } — the drawn
        //             signature geometry. Kept as opaque TEXT so the schema
        //             doesn't have to track the stroke shape (owned by the
        //             frontend's PdfSignatureSnapshot type).
        //
        // Unlike assets there's no owning_note_id — signatures are
        // user-global, so no FK and no apply-ordering race on pull.
        sql: r#"
            CREATE TABLE signatures (
                id            TEXT PRIMARY KEY,
                data          TEXT NOT NULL,
                created       TEXT NOT NULL,
                modified      TEXT NOT NULL,
                etebase_uid   TEXT,
                etebase_etag  TEXT,
                dirty         INTEGER NOT NULL DEFAULT 1
            );
            CREATE INDEX idx_signatures_dirty       ON signatures(dirty)       WHERE dirty = 1;
            CREATE INDEX idx_signatures_etebase_uid ON signatures(etebase_uid) WHERE etebase_uid IS NOT NULL;
        "#,
    },
    Migration {
        to: 13,
        // Cached, searchable plain text for PDF notes. A PDF note's bytes are
        // immutable (editing means creating a new note), so the extracted text
        // is derived data that never needs invalidating — we compute it once
        // (frontend pdf.js) and store it here so the cross-note search can hit
        // PDF content the same way it hits a markdown body.
        //
        // NULL  = not yet indexed (drives the background backfill sweep).
        // ''    = indexed but empty (e.g. a scanned/image-only PDF).
        //
        // Deliberately LOCAL/derived: it is NOT part of the note sync payload
        // (see NotePayload in sync/mod.rs). Every device reproduces it from the
        // PDF bytes it already syncs, so populating it never dirties the note
        // and never triggers a push.
        sql: r#"
            ALTER TABLE notes ADD COLUMN pdf_text TEXT;
        "#,
    },
    Migration {
        to: 14,
        // Local, automatic note edit history (see src/history/mod.rs). Each
        // row is a point-in-time snapshot of a note's rendered markdown,
        // DEFLATE-compressed. Deliberately LOCAL/derived: no etebase columns,
        // never synced — every device keeps its own timeline, and a *restore*
        // converges across devices because it's applied as a normal CRDT edit
        // (not by replaying an old yrs_state, which would be a no-op).
        //
        //   action       why this version exists: 'created' | 'edited' |
        //                'reverted' (room for 'imported' | 'manual' later).
        //   label        reserved for future user-named bookmarks/tags.
        //   ref_version_id / ref_created
        //                for a 'reverted' version, the restore target's id and
        //                timestamp; the timestamp is denormalised so the
        //                "Reverted to {date}" label still renders after the
        //                target itself ages out of retention.
        //   words_added / words_removed
        //                magnitude vs the previous snapshot (computed at
        //                capture with `similar`), for the "+N / −M words" label.
        //   body         DEFLATE-compressed UTF-8 markdown snapshot.
        //   size         uncompressed markdown byte length (for stats/quota).
        //
        // `yrs_state` snapshots for non-markdown kinds are a future migration;
        // markdown is canonical content here (payload schema v2 `body`).
        sql: r#"
            CREATE TABLE note_versions (
                id             TEXT PRIMARY KEY,
                note_id        TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
                created        TEXT NOT NULL,
                note_kind      TEXT NOT NULL,
                action         TEXT NOT NULL DEFAULT 'edited',
                label          TEXT,
                ref_version_id TEXT,
                ref_created    TEXT,
                words_added    INTEGER NOT NULL DEFAULT 0,
                words_removed  INTEGER NOT NULL DEFAULT 0,
                body           BLOB NOT NULL,
                size           INTEGER NOT NULL
            );
            CREATE INDEX idx_note_versions_note ON note_versions(note_id, created DESC);
        "#,
    },
    Migration {
        to: 15,
        // Fallback "tokens" magnitude for note versions: the count of
        // non-whitespace characters added/removed vs the previous snapshot.
        // Edits that change no words (formatting, punctuation, code/URL/HTML)
        // still get an informative figure; whitespace-only edits leave these 0
        // and the UI shows a qualitative label instead. See content_stats.rs.
        sql: r#"
            ALTER TABLE note_versions ADD COLUMN tokens_added   INTEGER NOT NULL DEFAULT 0;
            ALTER TABLE note_versions ADD COLUMN tokens_removed INTEGER NOT NULL DEFAULT 0;
        "#,
    },
    Migration {
        to: 16,
        // CRDT-backed note tags. The existing note_tags table remains the
        // query/index-friendly projection used by list/search/export; this
        // blob is the mergeable source that crosses the sync payload.
        //
        // Backfilled lazily from note_tags on the next local tag edit or sync
        // apply so migration stays cheap even for large vaults.
        sql: r#"
            ALTER TABLE notes ADD COLUMN tags_state BLOB;
        "#,
    },
    Migration {
        to: 17,
        // Local projection of collection sharing state. Etebase sharing
        // operates on remote Collections, while Mindstream folders are local
        // rows that currently sync as Items inside a single folders
        // Collection. These fields give the UI a stable place to render
        // "shared with me" roots and "shared by me" indicators while the
        // sync layer grows true per-folder remote-collection support.
        sql: r#"
            ALTER TABLE collections ADD COLUMN share_id TEXT;
            ALTER TABLE collections ADD COLUMN shared_role TEXT;
            ALTER TABLE collections ADD COLUMN shared_owner TEXT;
            ALTER TABLE collections ADD COLUMN shared_by_me INTEGER NOT NULL DEFAULT 0;

            CREATE INDEX idx_collections_share_id ON collections(share_id) WHERE share_id IS NOT NULL;
            CREATE INDEX idx_collections_shared_role ON collections(shared_role) WHERE shared_role IS NOT NULL;
            CREATE INDEX idx_collections_shared_by_me ON collections(shared_by_me) WHERE shared_by_me = 1;
        "#,
    },
    Migration {
        to: 18,
        // Share-scope tag for manifest-backed collection sharing. Every folder,
        // note and asset row belonging to a shared scope carries the scope's
        // `share_scope_id` (matching the manifest's field). NULL = private/
        // vault-local, which is every existing row.
        //
        // The seam the sync layer routes on: a row with a non-NULL
        // `share_scope_id` pushes into that scope's dedicated folders/notes/
        // assets Etebase collection instead of the single vault-wide one. The
        // routing itself is a later slice; this migration only adds the column
        // so outgoing-share creation can stamp the shared subtree up front.
        sql: r#"
            ALTER TABLE collections ADD COLUMN share_scope_id TEXT;
            ALTER TABLE notes       ADD COLUMN share_scope_id TEXT;
            ALTER TABLE assets      ADD COLUMN share_scope_id TEXT;

            CREATE INDEX idx_collections_share_scope ON collections(share_scope_id) WHERE share_scope_id IS NOT NULL;
            CREATE INDEX idx_notes_share_scope       ON notes(share_scope_id)       WHERE share_scope_id IS NOT NULL;
            CREATE INDEX idx_assets_share_scope      ON assets(share_scope_id)      WHERE share_scope_id IS NOT NULL;
        "#,
    },
    Migration {
        to: 19,
        // Route a queued server-side delete to the right Etebase collection.
        // A tombstone for a row that belonged to a shared scope must be
        // applied against that scope's collection, not the vault-wide one, so
        // we record the row's `share_scope_id` (NULL = vault-wide, which is
        // every existing tombstone). See sync::queue_tombstone / drain_tombstones.
        sql: r#"
            ALTER TABLE tombstones ADD COLUMN share_scope_id TEXT;
        "#,
    },
    Migration {
        to: 20,
        // Bounded reconcile window for the vault singleton collections.
        //
        // Two brand-new devices on the same account auto-sync concurrently
        // on first launch. Both hit `ensure_collection`'s create path before
        // either has published, so each mints its OWN random-uid Etebase
        // collection for the same singleton (notes/folders/assets/signatures)
        // — a permanent split-brain the cache-first fast path can never
        // reconcile, because neither device ever re-lists.
        //
        // `reconcile_passes_left` arms a short window during which each sync
        // lists the account's collections of that type and converges on the
        // lexicographically-smallest live uid (a deterministic winner every
        // device agrees on), migrating its rows off any loser. The counter
        // decrements on a stable pass and re-arms on create/migrate, so once
        // devices agree for a few consecutive syncs we disarm and revert to
        // the cheap cache fast path. Default 3 covers the setup window for
        // rows that predate this migration.
        sql: r#"
            ALTER TABLE sync_state ADD COLUMN reconcile_passes_left INTEGER NOT NULL DEFAULT 3;
        "#,
    },
    Migration {
        to: 21,
        // Per-profile plugin registry (see src/plugins/mod.rs). The DB is
        // profile-local, so this table is naturally scoped to one vault.
        //
        // The frontend owns each plugin's manifest + contributions; this table
        // is the durable record of install/enable state and the integrity
        // seam:
        //   accepted_hash        canonical manifest checksum the user (or, for
        //                        bundled first-party plugins, the app) accepted.
        //                        A mismatch on the next load of an *installed*
        //                        plugin disables it pending re-approval.
        //   granted_permissions  JSON array of the permissions granted at
        //                        install/approval time.
        //   source               'builtin' (ships in the app bundle, trusted)
        //                        or 'installed' (third-party, subject to the
        //                        hash-change re-approval gate).
        //   last_load_error      why the plugin isn't contributing, if anything
        //                        (bad manifest, hash mismatch); surfaced in the
        //                        plugin settings UI.
        sql: r#"
            CREATE TABLE plugins (
                id                  TEXT PRIMARY KEY,
                version             TEXT NOT NULL,
                enabled             INTEGER NOT NULL DEFAULT 1,
                source              TEXT NOT NULL DEFAULT 'installed',
                source_path         TEXT,
                accepted_hash       TEXT NOT NULL,
                granted_permissions TEXT NOT NULL DEFAULT '[]',
                last_load_error     TEXT,
                installed_at        TEXT NOT NULL,
                updated_at          TEXT NOT NULL
            );
            CREATE INDEX idx_plugins_enabled ON plugins(enabled) WHERE enabled = 1;
        "#,
    },
    Migration {
        to: 22,
        // Plugin signature state (see src/plugins/signing.rs).
        //   signer            SHA-256 fingerprint of the accepted signer's
        //                     Ed25519 public key, pinned on approval. Only an
        //                     update signed by the SAME key auto-approves; a
        //                     signer change is treated as untrusted. NULL for
        //                     unsigned plugins.
        //   signature_status  last observed verification result of the on-disk
        //                     signature: 'unsigned' | 'valid' | 'invalid'. Info
        //                     for the management UI; refreshed on every discover.
        sql: r#"
            ALTER TABLE plugins ADD COLUMN signer TEXT;
            ALTER TABLE plugins ADD COLUMN signature_status TEXT NOT NULL DEFAULT 'unsigned';
        "#,
    },
    Migration {
        to: 23,
        // Words the user has personally accepted, checked before anything
        // reaches the dictionary engine (see src/spellcheck).
        //
        // Lives in the DB rather than in settings because settings are held
        // in the WebView's localStorage: device-local, and wiped by a
        // session reload. A personal dictionary the user has to rebuild
        // after every reload is worse than not having one.
        //
        // `word_folded` is the lowercase form and carries the uniqueness
        // constraint, so adding "Mindstream" after "mindstream" is a no-op
        // rather than a second row that can never be matched separately.
        sql: r#"
            CREATE TABLE custom_dictionary (
                word        TEXT NOT NULL,
                word_folded TEXT NOT NULL PRIMARY KEY,
                created     TEXT NOT NULL
            );
        "#,
    },
    Migration {
        to: 24,
        // Settings contributed by plugins (see src/plugins/settings.rs).
        //
        // Here rather than in the settings store for the same reason as the
        // custom dictionary above — settings live in the WebView's
        // localStorage — plus one specific to plugins: a scripted plugin
        // receives its settings as `ctx.settings`, and while those sat in
        // localStorage the frontend had to assemble the script context and
        // hand it down. That made a UI action the only thing that could ever
        // invoke a plugin, because nothing else could build the argument.
        //
        // `value` is JSON text, so a setting keeps its type on the way through
        // instead of everything arriving back as a string.
        sql: r#"
            CREATE TABLE plugin_settings (
                plugin_id  TEXT NOT NULL,
                key        TEXT NOT NULL,
                value      TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                PRIMARY KEY (plugin_id, key)
            );
        "#,
    },
];

pub fn run(conn: &mut Connection) -> AppResult<()> {
    let current: u32 = conn.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    log::info!("[db] current schema version = {current}");

    // Disable FK enforcement around the migration loop. Some migrations
    // (e.g. v3) rebuild a referenced table; SQLite would otherwise reject
    // the intermediate state. PRAGMA can't run inside a transaction, so
    // we toggle outside the per-migration tx.
    conn.pragma_update(None, "foreign_keys", "OFF")?;

    for m in MIGRATIONS {
        if m.to > current {
            log::info!("[db] applying migration to v{}", m.to);
            let tx = conn.transaction()?;
            tx.execute_batch(m.sql)?;
            tx.pragma_update(None, "user_version", m.to)?;
            tx.commit()?;
        }
    }

    conn.pragma_update(None, "foreign_keys", "ON")?;
    // Surface integrity violations early instead of letting them bite at
    // the next CRUD call.
    check_foreign_keys(conn)?;

    Ok(())
}

/// Fail if any row violates a foreign key, naming what broke.
///
/// `PRAGMA foreign_key_check` reports one row per violation. This used to be
/// `conn.execute(...)?`, which does detect them — rusqlite returns
/// `ExecuteReturnedResults` the moment a statement yields a row — but the
/// error that reached the user was the literal "Query returned results when
/// it was expected to not return any", with no table, no rowid and no
/// constraint. A database that failed to open told nobody why.
///
/// Reading the rows costs one query on a schema that is already correct
/// (zero rows) and turns the failure into something actionable.
fn check_foreign_keys(conn: &Connection) -> AppResult<()> {
    let mut stmt = conn.prepare("PRAGMA foreign_key_check")?;
    let violations = stmt
        .query_map([], |row| {
            // (child table, child rowid, parent table, index of the failing FK)
            let table: String = row.get(0)?;
            let rowid: Option<i64> = row.get(1)?;
            let parent: String = row.get(2)?;
            let fkid: i64 = row.get(3)?;
            Ok(format!(
                "{table}(rowid={}) -> {parent} [fk #{fkid}]",
                rowid.map(|r| r.to_string()).unwrap_or_else(|| "?".into())
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    if violations.is_empty() {
        return Ok(());
    }

    // Cap the detail: a broken cascade can produce thousands of rows, and the
    // first handful identify the relationship just as well as all of them.
    let shown = violations.len().min(10);
    let mut detail = violations[..shown].join(", ");
    if violations.len() > shown {
        detail.push_str(&format!(", … and {} more", violations.len() - shown));
    }
    Err(AppError::InvalidArg(format!(
        "database failed its foreign-key check after migration ({} violation(s)): {detail}",
        violations.len()
    )))
}

/// Did this DB just get its first schema applied (i.e. was empty before)?
pub fn was_freshly_created(conn: &Connection) -> AppResult<bool> {
    let coll_count: i64 = conn.query_row("SELECT COUNT(*) FROM collections", [], |r| r.get(0))?;
    let note_count: i64 = conn.query_row("SELECT COUNT(*) FROM notes", [], |r| r.get(0))?;
    Ok(coll_count <= 1 && note_count == 0)
}

/// Insert demo content so the app isn't empty on first launch.
///
/// Seed rows use *deterministic* ids (`seed_work`, `seed_welcome`, …) rather
/// than random uuids. Sync's join key is the app-level row id (embedded in the
/// encrypted payload), so two fresh devices on the same account must seed the
/// same ids or their identical demo content would sync as duplicate rows that
/// no reconcile can collapse. Fixed ids make the seeds merge by id on first
/// sync. Existing installs keep whatever random ids they already seeded.
pub fn seed(conn: &Connection) -> AppResult<()> {
    let now = chrono::Utc::now().to_rfc3339();
    let work_id = "seed_work";
    let personal_id = "seed_personal";
    conn.execute(
        "INSERT INTO collections(id, parent_collection_id, name, position, created, modified)
         VALUES (?1, NULL, ?2, 0, ?3, ?3)",
        params![work_id, "Work", now],
    )?;
    conn.execute(
        "INSERT INTO collections(id, parent_collection_id, name, position, created, modified)
         VALUES (?1, NULL, ?2, 1, ?3, ?3)",
        params![personal_id, "Personal", now],
    )?;

    insert_note(conn, "seed_welcome", "Welcome", WELCOME_BODY, None, 0, &now)?;
    insert_note(
        conn,
        "seed_sprint",
        "Sprint planning",
        "# Sprint planning\n\n## Agenda\n\n1. Carry-over from last sprint\n2. Capacity check\n3. Commit\n",
        Some(work_id),
        0,
        &now,
    )?;
    insert_note(
        conn,
        "seed_ideas",
        "Ideas",
        "# Ideas\n\n- Try a graph view\n- Backlinks panel\n- Daily notes\n",
        Some(personal_id),
        0,
        &now,
    )?;

    Ok(())
}

fn insert_note(
    conn: &Connection,
    id: &str,
    title: &str,
    body: &str,
    parent: Option<&str>,
    position: i64,
    now: &str,
) -> AppResult<()> {
    // Give every seeded note a DETERMINISTIC origin yrs_state (v1 Y.Text
    // "body", so payload_schema stays 1 — the column default). Because the
    // bytes are identical on every device, two fresh devices on the same
    // account share one origin op: a CRDT merge collapses the seed text
    // instead of stacking each device's own "insert seed text" into a
    // duplicated body. Later per-device edits still diverge normally (they
    // mint their own client id off the loaded doc) and merge on top of the
    // shared base. See crate::sync::yrs_doc::init_seed_state.
    let yrs_state = crate::sync::yrs_doc::init_seed_state(body);
    conn.execute(
        "INSERT INTO notes(id, parent_collection_id, title, body, position, created, modified, yrs_state)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6, ?7)",
        params![id, parent, title, body, position, now, yrs_state],
    )?;
    Ok(())
}

const WELCOME_BODY: &str = "# Welcome\n\nThis is a **local-first** note-taking boilerplate built on Tauri v2, SvelteKit\n(SPA mode), Svelte 5 runes, dockview, and Milkdown's Crepe editor.\n\n- The left sidebar is the file tree\n- The right sidebar shows metadata for the active note\n- The middle area is a `dockview` instance — drag tabs to split panes\n\n> Notes now live in a SQLite database under your app data folder.\n";

#[cfg(test)]
mod fk_check_tests {
    use super::*;

    /// A clean, migrated database has no violations.
    #[test]
    fn passes_on_a_freshly_migrated_database() {
        let mut conn = Connection::open_in_memory().unwrap();
        run(&mut conn).expect("migrations + fk check");
        check_foreign_keys(&conn).expect("no violations");
    }

    /// The point of the change: the error has to say what actually broke.
    /// Previously this surfaced as rusqlite's "Query returned results when
    /// it was expected to not return any", which named nothing.
    #[test]
    fn reports_the_offending_table_and_parent() {
        let mut conn = Connection::open_in_memory().unwrap();
        run(&mut conn).unwrap();

        // Insert an orphan behind SQLite's back: enforcement off, so the row
        // lands, exactly like a migration that rebuilds a referenced table
        // and leaves a dangling child.
        conn.pragma_update(None, "foreign_keys", "OFF").unwrap();
        conn.execute(
            "INSERT INTO notes (id, parent_collection_id, title, body, position, created, modified)
             VALUES ('orphan', 'no-such-folder', 'T', '', 0, '2025-01-01', '2025-01-01')",
            [],
        )
        .unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();

        let err = check_foreign_keys(&conn).expect_err("must reject the orphan");
        let message = err.to_string();
        assert!(
            message.contains("notes"),
            "names the child table, got: {message}"
        );
        assert!(
            message.contains("collections"),
            "names the parent table, got: {message}"
        );
        assert!(
            message.contains("1 violation"),
            "counts the violations, got: {message}"
        );
    }
}

#[cfg(test)]
mod seed_tests {
    use super::*;
    use rusqlite::Connection;

    fn seeded_conn() -> Connection {
        let mut conn = Connection::open_in_memory().expect("in-memory db");
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        run(&mut conn).expect("migrations");
        seed(&conn).expect("seed");
        conn
    }

    #[test]
    fn seeded_notes_carry_a_deterministic_origin_yrs_state() {
        let conn = seeded_conn();
        // Every seeded note gets a v1 origin state whose bytes are exactly what
        // init_seed_state(body) produces — i.e. deterministic across devices.
        let mut stmt = conn
            .prepare("SELECT body, yrs_state, payload_schema FROM notes")
            .unwrap();
        let rows: Vec<(String, Option<Vec<u8>>, i64)> = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .unwrap()
            .map(|r| r.unwrap())
            .collect();
        assert!(!rows.is_empty(), "seed should insert notes");
        for (body, yrs_state, schema) in rows {
            let state = yrs_state.expect("seeded note has yrs_state");
            assert!(!state.is_empty(), "seeded yrs_state is non-empty");
            // Deterministic: recomputing from the body yields identical bytes.
            assert_eq!(
                state,
                crate::sync::yrs_doc::init_seed_state(&body),
                "seeded yrs_state must equal the deterministic origin"
            );
            // v1 Y.Text "body" doc → the state renders back to the body.
            assert_eq!(crate::sync::yrs_doc::to_markdown(&state), body);
            // Stays on the v1 payload schema (column default).
            assert_eq!(schema, 1);
        }
    }

    #[test]
    fn two_devices_seed_identical_bytes_so_a_merge_keeps_content_once() {
        // Simulate two fresh devices seeding the same account: identical origin
        // bytes mean a CRDT merge is a no-op — the seed content stays single.
        let device_a = seeded_conn();
        let device_b = seeded_conn();

        let welcome = |conn: &Connection| -> Vec<u8> {
            conn.query_row(
                "SELECT yrs_state FROM notes WHERE id = 'seed_welcome'",
                [],
                |r| r.get::<_, Option<Vec<u8>>>(0),
            )
            .unwrap()
            .unwrap()
        };
        let a = welcome(&device_a);
        let b = welcome(&device_b);
        assert_eq!(a, b, "two devices seed byte-identical origin state");

        let merged = crate::sync::yrs_doc::merge_remote(&a, &b);
        assert_eq!(
            crate::sync::yrs_doc::to_markdown(&merged),
            crate::sync::yrs_doc::to_markdown(&a),
            "merging two identical seed origins must not duplicate content"
        );
    }
}
