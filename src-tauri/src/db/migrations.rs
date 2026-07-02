//! Schema migrations.
//!
//! `MIGRATIONS` is the canonical list, ordered by target version. On
//! startup we read `PRAGMA user_version` and apply every migration whose
//! `to` is greater than the current version, inside one transaction each.
//! Bump the version + add an entry; never edit a shipped migration.

use rusqlite::{params, Connection};

use crate::error::AppResult;

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
    conn.execute("PRAGMA foreign_key_check", [])?;

    Ok(())
}

/// Did this DB just get its first schema applied (i.e. was empty before)?
pub fn was_freshly_created(conn: &Connection) -> AppResult<bool> {
    let coll_count: i64 = conn.query_row("SELECT COUNT(*) FROM collections", [], |r| r.get(0))?;
    let note_count: i64 = conn.query_row("SELECT COUNT(*) FROM notes", [], |r| r.get(0))?;
    Ok(coll_count <= 1 && note_count == 0)
}

/// Insert demo content so the app isn't empty on first launch.
pub fn seed(conn: &Connection) -> AppResult<()> {
    let now = chrono::Utc::now().to_rfc3339();
    let work_id = format!("coll_{}", uuid::Uuid::new_v4());
    let personal_id = format!("coll_{}", uuid::Uuid::new_v4());
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

    insert_note(conn, "Welcome", WELCOME_BODY, None, 0, &now)?;
    insert_note(
        conn,
        "Sprint planning",
        "# Sprint planning\n\n## Agenda\n\n1. Carry-over from last sprint\n2. Capacity check\n3. Commit\n",
        Some(&work_id),
        0,
        &now,
    )?;
    insert_note(
        conn,
        "Ideas",
        "# Ideas\n\n- Try a graph view\n- Backlinks panel\n- Daily notes\n",
        Some(&personal_id),
        0,
        &now,
    )?;

    Ok(())
}

fn insert_note(
    conn: &Connection,
    title: &str,
    body: &str,
    parent: Option<&str>,
    position: i64,
    now: &str,
) -> AppResult<()> {
    let id = format!("note_{}", uuid::Uuid::new_v4());
    conn.execute(
        "INSERT INTO notes(id, parent_collection_id, title, body, position, created, modified)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
        params![id, parent, title, body, position, now],
    )?;
    Ok(())
}

const WELCOME_BODY: &str = "# Welcome\n\nThis is a **local-first** note-taking boilerplate built on Tauri v2, SvelteKit\n(SPA mode), Svelte 5 runes, dockview, and Milkdown's Crepe editor.\n\n- The left sidebar is the file tree\n- The right sidebar shows metadata for the active note\n- The middle area is a `dockview` instance — drag tabs to split panes\n\n> Notes now live in a SQLite database under your app data folder.\n";
