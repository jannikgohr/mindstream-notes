//! Browser save receipts participate in the note's own SQLite transaction.
use rusqlite::{Connection, OptionalExtension};

pub fn install(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS browser_write_receipts (
            note_id TEXT PRIMARY KEY REFERENCES notes(id) ON DELETE CASCADE,
            token TEXT NOT NULL
         );
         CREATE TEMP TABLE IF NOT EXISTS browser_write_context (note_id TEXT, token TEXT);
         INSERT INTO browser_write_context SELECT NULL, NULL
            WHERE NOT EXISTS (SELECT 1 FROM browser_write_context);
         CREATE TEMP TRIGGER IF NOT EXISTS browser_note_receipt
         AFTER UPDATE OF body, yrs_state ON main.notes BEGIN
            DELETE FROM browser_write_receipts WHERE note_id = NEW.id;
            INSERT INTO browser_write_receipts (note_id, token)
                SELECT NEW.id, token FROM browser_write_context
                WHERE note_id = NEW.id AND token IS NOT NULL;
         END;",
    )
}

pub fn context(conn: &Connection, write: Option<(&str, &str)>) -> rusqlite::Result<()> {
    let (id, token) = write.map_or((None, None), |(id, token)| (Some(id), Some(token)));
    conn.execute(
        "UPDATE browser_write_context SET note_id = ?1, token = ?2",
        rusqlite::params![id, token],
    )?;
    Ok(())
}

pub fn read(conn: &Connection, id: &str) -> rusqlite::Result<Option<String>> {
    conn.query_row(
        "SELECT token FROM browser_write_receipts WHERE note_id = ?1",
        [id],
        |row| row.get(0),
    )
    .optional()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn database() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "PRAGMA foreign_keys = ON;
             CREATE TABLE notes (id TEXT PRIMARY KEY, body TEXT, yrs_state BLOB, title TEXT);
             INSERT INTO notes VALUES ('note', 'original', X'01', 'Title');",
        )
        .unwrap();
        install(&conn).unwrap();
        conn
    }

    #[test]
    fn receipt_commits_with_normalized_content_and_survives_context_reinstallation() {
        let mut conn = database();
        context(&conn, Some(("note", "write-one"))).unwrap();
        let tx = conn.transaction().unwrap();
        tx.execute("UPDATE notes SET body = 'normalized' WHERE id = 'note'", [])
            .unwrap();
        tx.execute("UPDATE notes SET yrs_state = X'0203' WHERE id = 'note'", [])
            .unwrap();
        tx.commit().unwrap();
        context(&conn, None).unwrap();
        // A new connection would install the same persistent table and a fresh
        // temporary context. Reinstallation must not discard the committed token.
        conn.execute_batch("DROP TRIGGER browser_note_receipt; DROP TABLE browser_write_context;")
            .unwrap();
        install(&conn).unwrap();
        assert_eq!(read(&conn, "note").unwrap().as_deref(), Some("write-one"));
    }

    #[test]
    fn rollback_restores_the_previous_receipt() {
        let mut conn = database();
        context(&conn, Some(("note", "write-one"))).unwrap();
        conn.execute("UPDATE notes SET body = 'first' WHERE id = 'note'", [])
            .unwrap();
        context(&conn, Some(("note", "write-two"))).unwrap();
        let tx = conn.transaction().unwrap();
        tx.execute("UPDATE notes SET body = 'refused' WHERE id = 'note'", [])
            .unwrap();
        tx.rollback().unwrap();
        assert_eq!(read(&conn, "note").unwrap().as_deref(), Some("write-one"));
    }

    #[test]
    fn independent_content_writes_invalidate_even_identical_content() {
        let conn = database();
        context(&conn, Some(("note", "write-one"))).unwrap();
        conn.execute("UPDATE notes SET body = 'first' WHERE id = 'note'", [])
            .unwrap();
        context(&conn, None).unwrap();
        conn.execute("UPDATE notes SET title = 'Metadata' WHERE id = 'note'", [])
            .unwrap();
        assert_eq!(read(&conn, "note").unwrap().as_deref(), Some("write-one"));
        conn.execute("UPDATE notes SET body = 'first' WHERE id = 'note'", [])
            .unwrap();
        assert_eq!(read(&conn, "note").unwrap(), None);
    }

    #[test]
    fn receipts_are_specific_to_the_note_and_removed_on_purge() {
        let conn = database();
        context(&conn, Some(("other", "other-write"))).unwrap();
        conn.execute(
            "UPDATE notes SET body = 'independent' WHERE id = 'note'",
            [],
        )
        .unwrap();
        assert_eq!(read(&conn, "note").unwrap(), None);
        context(&conn, Some(("note", "write-one"))).unwrap();
        conn.execute("UPDATE notes SET yrs_state = X'02' WHERE id = 'note'", [])
            .unwrap();
        conn.execute("DELETE FROM notes WHERE id = 'note'", [])
            .unwrap();
        assert_eq!(read(&conn, "note").unwrap(), None);
    }
}
