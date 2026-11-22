//! Links between notes, read from every Markdown body in one query, so the
//! link graph and backlinks don't load each note on its own.
use rusqlite::Connection;
use serde::Serialize;

use crate::error::AppResult;
use crate::import::links::percent_decode;

const PREFIX: &str = "](mindstream://note/";

#[derive(Debug, Serialize, PartialEq)]
pub struct NoteLinks {
    pub id: String,
    /// The `modified` the links were read at, so a caller can cache them.
    pub modified: String,
    /// Each linked note ID once, in order of first appearance.
    pub targets: Vec<String>,
}

/// The note IDs a Markdown body links to.
pub fn link_targets(body: &str) -> Vec<String> {
    let mut targets: Vec<String> = Vec::new();
    for (start, _) in body.match_indices(PREFIX) {
        let rest = &body[start + PREFIX.len()..];
        let end = rest
            .find(|c: char| c == ')' || c.is_whitespace())
            .unwrap_or(rest.len());
        if end == 0 || !rest[end..].starts_with(')') {
            continue;
        }
        let id = percent_decode(&rest[..end]);
        if !targets.contains(&id) {
            targets.push(id);
        }
    }
    targets
}

/// The links of every Markdown note outside the trash.
pub fn list(conn: &Connection) -> AppResult<Vec<NoteLinks>> {
    let mut stmt =
        conn.prepare("SELECT id, modified, body FROM active_notes WHERE note_kind = 'markdown'")?;
    let rows = stmt.query_map([], |row| {
        let body: String = row.get(2)?;
        Ok(NoteLinks {
            id: row.get(0)?,
            modified: row.get(1)?,
            targets: link_targets(&body),
        })
    })?;
    Ok(rows.collect::<Result<_, _>>()?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_note_links_once_each_and_skips_other_links() {
        assert_eq!(
            link_targets(
                "[A](mindstream://note/a) [B](mindstream://note/a%20b) [A again](mindstream://note/a) \
                 [web](https://x.y) [user](mindstream://user/u) [cut](mindstream://note/c d) \
                 [empty](mindstream://note/)"
            ),
            ["a", "a b"]
        );
    }
}
