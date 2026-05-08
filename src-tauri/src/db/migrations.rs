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
