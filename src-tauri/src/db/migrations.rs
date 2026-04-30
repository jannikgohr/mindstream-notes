//! Schema migrations.
//!
//! `MIGRATIONS` is the canonical list, ordered by target version. On
//! startup we read `PRAGMA user_version` and apply every migration whose
//! `to` is greater than the current version, inside one transaction each.
//! Bump the version + add an entry; never edit a shipped migration.

use rusqlite::{Connection, params};

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
];

pub fn run(conn: &mut Connection) -> AppResult<()> {
    let current: u32 =
        conn.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    log::info!("[db] current schema version = {current}");

    for m in MIGRATIONS {
        if m.to > current {
            log::info!("[db] applying migration to v{}", m.to);
            let tx = conn.transaction()?;
            tx.execute_batch(m.sql)?;
            tx.pragma_update(None, "user_version", m.to)?;
            tx.commit()?;
        }
    }

    Ok(())
}

/// Did this DB just get its first schema applied (i.e. was empty before)?
pub fn was_freshly_created(conn: &Connection) -> AppResult<bool> {
    let coll_count: i64 =
        conn.query_row("SELECT COUNT(*) FROM collections", [], |r| r.get(0))?;
    let note_count: i64 =
        conn.query_row("SELECT COUNT(*) FROM notes", [], |r| r.get(0))?;
    Ok(coll_count == 0 && note_count == 0)
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

    insert_note(
        conn,
        "Welcome",
        WELCOME_BODY,
        None,
        0,
        &now,
    )?;
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
