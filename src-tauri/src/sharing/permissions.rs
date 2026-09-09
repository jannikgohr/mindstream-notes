//! Local write checks. Sync apply deliberately bypasses these user-mutation guards.
use super::*;

pub(crate) fn ensure_collection_writable(conn: &Connection, id: &str) -> AppResult<()> {
    let denied: bool = conn.query_row(
        "WITH RECURSIVE ancestors(id, parent_collection_id, share_scope_id, shared_role, shared_by_me) AS (
            SELECT id, parent_collection_id, share_scope_id, shared_role, shared_by_me FROM collections WHERE id = ?1
            UNION
            SELECT c.id, c.parent_collection_id, c.share_scope_id, c.shared_role, c.shared_by_me
            FROM collections c JOIN ancestors a ON a.parent_collection_id = c.id
        )
        SELECT EXISTS(SELECT 1 FROM ancestors a WHERE
            (a.shared_role = 'read_only' AND a.shared_by_me = 0)
            OR EXISTS(SELECT 1 FROM collections owner WHERE owner.share_scope_id = a.share_scope_id
                AND owner.shared_role = 'read_only' AND owner.shared_by_me = 0))",
        params![id], |r| r.get(0),
    )?;
    if denied {
        return Err(AppError::InvalidArg(
            "This shared folder is read-only".into(),
        ));
    }
    Ok(())
}

pub(crate) fn ensure_parent_writable(conn: &Connection, parent: Option<&str>) -> AppResult<()> {
    if let Some(id) = parent {
        ensure_collection_writable(conn, id)?;
    }
    Ok(())
}

pub(crate) fn ensure_note_writable(conn: &Connection, id: &str) -> AppResult<()> {
    let row: Option<(Option<String>, Option<String>)> = conn
        .query_row(
            "SELECT parent_collection_id, share_scope_id FROM notes WHERE id = ?1",
            params![id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    let Some((parent, scope)) = row else {
        return Ok(());
    };
    ensure_parent_writable(conn, parent.as_deref())?;
    if let Some(scope) = scope {
        let denied: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM collections WHERE share_scope_id = ?1 AND shared_role = 'read_only' AND shared_by_me = 0)",
            params![scope], |r| r.get(0),
        )?;
        if denied {
            return Err(AppError::InvalidArg("This shared note is read-only".into()));
        }
    }
    Ok(())
}

pub(crate) fn ensure_subtree_writable(conn: &Connection, id: &str) -> AppResult<()> {
    ensure_collection_writable(conn, id)?;
    let denied: bool = conn.query_row(
        "WITH RECURSIVE subtree(id) AS (
            SELECT id FROM collections WHERE id = ?1 UNION
            SELECT c.id FROM collections c JOIN subtree s ON c.parent_collection_id = s.id
        ) SELECT EXISTS(SELECT 1 FROM collections c JOIN subtree s ON c.id = s.id
            WHERE (c.shared_role = 'read_only' AND c.shared_by_me = 0)
            OR EXISTS(SELECT 1 FROM collections owner WHERE owner.share_scope_id = c.share_scope_id
                AND owner.shared_role = 'read_only' AND owner.shared_by_me = 0))
            OR EXISTS(SELECT 1 FROM notes n JOIN subtree s ON n.parent_collection_id = s.id
                JOIN collections owner ON owner.share_scope_id = n.share_scope_id
                WHERE owner.shared_role = 'read_only' AND owner.shared_by_me = 0)",
        params![id],
        |r| r.get(0),
    )?;
    if denied {
        return Err(AppError::InvalidArg(
            "This folder contains a read-only share".into(),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{collections, notes, tree_batch};

    #[test]
    fn read_only_shares_reject_local_mutations_before_writing() {
        let db = crate::db::open_memory_for_tests();
        let folder = db
            .with_conn(|c| {
                collections::create(
                    c,
                    collections::CreateCollection {
                        name: "Shared".into(),
                        parent_collection_id: None,
                    },
                )
            })
            .unwrap()
            .id;
        let note = db
            .with_conn(|c| {
                notes::create(
                    c,
                    notes::CreateNote {
                        title: Some("Original".into()),
                        body: Some("unchanged".into()),
                        parent_collection_id: Some(folder.clone()),
                        note_kind: None,
                    },
                )
            })
            .unwrap()
            .summary
            .id;
        db.with_conn_mut(|c| {
            c.execute("UPDATE collections SET shared_role = 'read_only', share_scope_id = 'scope', dirty = 0 WHERE id = ?1", params![folder])?;
            c.execute("UPDATE notes SET share_scope_id = 'scope', dirty = 0 WHERE id = ?1", params![note])?;
            let edit = serde_json::from_value(serde_json::json!({"id": note, "body": "lost edit", "tags": ["new"]})).unwrap();
            assert!(notes::update(c, edit).is_err());
            assert!(notes::save_yrs_state(c, &note, &[1, 2, 3]).is_err());
            assert!(notes::trash(c, &note).is_err());
            assert!(notes::restore(c, &note).is_err());
            assert!(notes::purge(c, &note).is_err());
            assert!(crate::assets::upload(c, crate::assets::UploadAsset {
                owning_note_id: note.clone(), mime_type: "image/png".into(), bytes: vec![1],
            }).is_err());
            assert!(collections::delete(c, &folder).is_err());
            let rename = serde_json::from_value(serde_json::json!({"id": folder, "name": "renamed"})).unwrap();
            assert!(collections::update(c, rename).is_err());
            assert!(notes::create(c, notes::CreateNote {
                title: None, body: None, parent_collection_id: Some(folder.clone()), note_kind: None,
            }).is_err());
            assert!(collections::create(c, collections::CreateCollection {
                name: "new".into(), parent_collection_id: Some(folder.clone()),
            }).is_err());
            assert!(tree_batch::move_many_items(c, vec![tree_batch::TreeItemRef::Note { id: note.clone() }], None).is_err());
            assert!(tree_batch::purge_many_items(c, vec![tree_batch::TreeItemRef::Folder { id: folder.clone() }]).is_err());
            let loaded = notes::load(c, &note)?;
            assert_eq!(loaded.body, "unchanged");
            assert!(loaded.summary.tags.is_empty());
            assert_eq!(c.query_row("SELECT dirty FROM notes WHERE id = ?1", params![note], |r| r.get::<_, i64>(0))?, 0);
            assert_eq!(c.query_row("SELECT count(*) FROM tombstones", [], |r| r.get::<_, i64>(0))?, 0);
            // A detached local item still inherits its scope's permission.
            c.execute("UPDATE notes SET parent_collection_id = NULL WHERE id = ?1", params![note])?;
            assert!(ensure_note_writable(c, &note).is_err());
            c.execute("UPDATE collections SET shared_role = 'read_write' WHERE id = ?1", params![folder])?;
            let edit = serde_json::from_value(serde_json::json!({"id": note, "body": "allowed"})).unwrap();
            notes::update(c, edit)?;
            assert_eq!(notes::load(c, &note)?.body, "allowed");
            Ok(())
        }).unwrap();
    }

    #[test]
    fn ancestor_operations_cannot_bypass_descendant_permissions() {
        let db = crate::db::open_memory_for_tests();
        db.with_conn_mut(|c| {
            let parent = collections::create(c, collections::CreateCollection {
                name: "Local parent".into(), parent_collection_id: None,
            })?.id;
            let shared = collections::create(c, collections::CreateCollection {
                name: "Shared child".into(), parent_collection_id: Some(parent.clone()),
            })?.id;
            c.execute("UPDATE collections SET shared_role = 'read_only', share_scope_id = 'scope' WHERE id = ?1", params![shared])?;
            assert!(collections::delete(c, &parent).is_err());
            assert!(tree_batch::move_many_items(c, vec![tree_batch::TreeItemRef::Folder { id: parent.clone() }], Some("trash".into())).is_err());
            assert!(collections::get(c, &parent)?.parent_collection_id.is_none());
            // A share owner retains write access even if stale recipient metadata remains.
            c.execute("UPDATE collections SET shared_by_me = 1 WHERE id = ?1", params![shared])?;
            assert!(ensure_subtree_writable(c, &parent).is_ok());
            Ok(())
        }).unwrap();
    }

    #[test]
    fn batch_move_into_read_only_folder_leaves_every_source_unchanged() {
        let db = crate::db::open_memory_for_tests();
        db.with_conn_mut(|c| {
            let destination = collections::create(
                c,
                collections::CreateCollection {
                    name: "Shared".into(),
                    parent_collection_id: None,
                },
            )?
            .id;
            let note = notes::create(
                c,
                notes::CreateNote {
                    title: None,
                    body: None,
                    parent_collection_id: None,
                    note_kind: None,
                },
            )?
            .summary
            .id;
            c.execute(
                "UPDATE collections SET shared_role = 'read_only' WHERE id = ?1",
                params![destination],
            )?;
            assert!(tree_batch::move_many_items(
                c,
                vec![tree_batch::TreeItemRef::Note { id: note.clone() }],
                Some(destination)
            )
            .is_err());
            assert!(notes::load(c, &note)?
                .summary
                .parent_collection_id
                .is_none());
            Ok(())
        })
        .unwrap();
    }
}
