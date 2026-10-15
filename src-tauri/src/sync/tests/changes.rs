//! Which spaces a sync visits, and when the account's cursor may move.

use super::*;

fn folder(conn: &Connection, id: &str, scope: Option<&str>, dirty: i64) {
    conn.execute(
        "INSERT INTO collections(id, name, position, created, modified, share_scope_id, dirty)
         VALUES (?1, ?1, 0, 't', 't', ?2, ?3)",
        params![id, scope, dirty],
    )
    .unwrap();
}

fn note(conn: &Connection, id: &str, scope: Option<&str>, dirty: i64) {
    conn.execute(
        "INSERT INTO notes(id, title, body, position, created, modified, share_scope_id, dirty)
         VALUES (?1, ?1, '', 0, 't', 't', ?2, ?3)",
        params![id, scope, dirty],
    )
    .unwrap();
}

fn asset(conn: &Connection, id: &str, owner: Option<&str>, scope: Option<&str>, dirty: i64) {
    conn.execute(
        "INSERT INTO assets(id, owning_note_id, mime_type, bytes, size, created, modified,
                            share_scope_id, dirty)
         VALUES (?1, ?2, 'image/png', x'00', 1, 't', 't', ?3, ?4)",
        params![id, owner, scope, dirty],
    )
    .unwrap();
}

fn tombstone(conn: &Connection, kind: &str, uid: &str, scope: Option<&str>) {
    conn.execute(
        "INSERT INTO tombstones(kind, etebase_uid, queued_at, share_scope_id)
         VALUES (?1, ?2, 't', ?3)",
        params![kind, uid, scope],
    )
    .unwrap();
}

/// A database where every row has been sent: two spaces, nothing dirty.
fn settled() -> Db {
    let db = open_memory_for_tests();
    db.with_conn(|c| {
        folder(c, "f_vault", None, 0);
        note(c, "n_vault", None, 0);
        asset(c, "a_vault", Some("n_vault"), None, 0);
        folder(c, "f_share", Some("share_a"), 0);
        note(c, "n_share", Some("share_a"), 0);
        asset(c, "a_share", Some("n_share"), Some("share_a"), 0);
        // The built-in trash never syncs, dirty or not.
        c.execute("UPDATE collections SET dirty = 1 WHERE id = 'trash'", [])?;
        Ok(())
    })
    .unwrap();
    db
}

fn dirty(db: &Db, table: &str, id: &str) {
    db.with_conn(|c| {
        c.execute(
            &format!("UPDATE {table} SET dirty = 1 WHERE id = ?1"),
            params![id],
        )?;
        Ok(())
    })
    .unwrap();
}

#[test]
fn nothing_waits_when_every_row_has_been_sent() {
    let db = settled();

    assert!(!vault_has_local_work(&db).unwrap());
    assert!(scopes_with_local_work(&db).unwrap().is_empty());
}

#[test]
fn each_kind_of_row_in_the_vault_is_work_for_the_vault_alone() {
    for (table, id) in [
        ("collections", "f_vault"),
        ("notes", "n_vault"),
        ("assets", "a_vault"),
    ] {
        let db = settled();
        dirty(&db, table, id);

        assert!(vault_has_local_work(&db).unwrap(), "{table}");
        assert!(scopes_with_local_work(&db).unwrap().is_empty(), "{table}");
    }
}

#[test]
fn each_kind_of_row_in_a_shared_folder_is_work_for_that_folder_alone() {
    for (table, id) in [
        ("collections", "f_share"),
        ("notes", "n_share"),
        ("assets", "a_share"),
    ] {
        let db = settled();
        dirty(&db, table, id);

        assert!(!vault_has_local_work(&db).unwrap(), "{table}");
        assert_eq!(
            scopes_with_local_work(&db).unwrap(),
            vec!["share_a".to_string()],
            "{table}"
        );
    }
}

#[test]
fn deletion_waiting_to_be_passed_on_is_work() {
    let db = settled();
    db.with_conn(|c| {
        tombstone(c, "note", "uid_gone", None);
        Ok(())
    })
    .unwrap();
    assert!(vault_has_local_work(&db).unwrap());
    assert!(scopes_with_local_work(&db).unwrap().is_empty());

    let db = settled();
    db.with_conn(|c| {
        tombstone(c, "folder", "uid_gone", Some("share_b"));
        Ok(())
    })
    .unwrap();
    assert!(!vault_has_local_work(&db).unwrap());
    // A folder with nothing left here but a deletion to pass on.
    assert_eq!(
        scopes_with_local_work(&db).unwrap(),
        vec!["share_b".to_string()]
    );
}

#[test]
fn signature_waiting_is_work_for_the_vault() {
    let db = settled();
    db.with_conn(|c| {
        c.execute(
            "INSERT INTO signatures(id, data, created, modified, dirty)
             VALUES ('s1', 'data', 't', 't', 1)",
            [],
        )?;
        Ok(())
    })
    .unwrap();

    assert!(vault_has_local_work(&db).unwrap());
}

/// The push leaves an attachment without a note alone: it is about to be
/// swept. Counting it would make every sync visit its space until then.
#[test]
fn attachment_without_a_note_is_not_work() {
    let db = settled();
    db.with_conn(|c| {
        asset(c, "orphan_vault", None, None, 1);
        asset(c, "orphan_share", None, Some("share_a"), 1);
        Ok(())
    })
    .unwrap();

    assert!(!vault_has_local_work(&db).unwrap());
    assert!(scopes_with_local_work(&db).unwrap().is_empty());
}

#[test]
fn folders_with_work_are_named_once_each_and_in_order() {
    let db = settled();
    db.with_conn(|c| {
        note(c, "n_b1", Some("share_b"), 1);
        note(c, "n_b2", Some("share_b"), 1);
        folder(c, "f_b", Some("share_b"), 1);
        tombstone(c, "note", "uid_b", Some("share_b"));
        note(c, "n_a2", Some("share_a"), 1);
        Ok(())
    })
    .unwrap();

    assert_eq!(
        scopes_with_local_work(&db).unwrap(),
        vec!["share_a".to_string(), "share_b".to_string()]
    );
}

#[test]
fn vault_is_left_alone_only_when_nothing_calls_for_it() {
    // full list, settled, changed on the server, work to send
    assert!(!visits_vault(false, true, false, false));

    assert!(visits_vault(true, true, false, false));
    assert!(visits_vault(false, false, false, false));
    assert!(visits_vault(false, true, true, false));
    assert!(visits_vault(false, true, false, true));
}

#[test]
fn folder_with_work_is_fetched_unless_the_list_brought_it() {
    let work = vec!["share_a".to_string(), "share_b".to_string()];

    // The server named neither, so both are fetched.
    assert_eq!(scopes_to_fetch(&[], &work), work);
    // It named one. That one is in hand.
    assert_eq!(
        scopes_to_fetch(&["share_a"], &work),
        vec!["share_b".to_string()]
    );
    assert!(scopes_to_fetch(&["share_a", "share_b", "share_c"], &work).is_empty());
    // A changed folder with nothing to send is not fetched a second time.
    assert!(scopes_to_fetch(&["share_c"], &[]).is_empty());
}

#[test]
fn space_that_still_waits_holds_the_account_cursor_back() {
    let db = open_memory_for_tests();
    assert!(!holds_remain(&db).unwrap());

    // A cursor of a space is not a hold.
    save_stoken(&db, "scope:share_a", Some("st_1")).unwrap();
    save_stoken(&db, KIND_VAULT, Some("st_2")).unwrap();
    assert!(!holds_remain(&db).unwrap());

    save_stoken(&db, &held_key("scope:share_a"), Some("1")).unwrap();
    assert!(holds_remain(&db).unwrap());
}

#[test]
fn forgetting_the_account_cursor_leaves_every_other_cursor() {
    let db = open_memory_for_tests();
    save_stoken(&db, KIND_ACCOUNT, Some("st_account")).unwrap();
    save_stoken(&db, KIND_VAULT, Some("st_vault")).unwrap();
    save_stoken(&db, "scope:share_a", Some("st_share")).unwrap();

    db.with_conn(forget_account_cursor).unwrap();

    assert_eq!(load_stoken(&db, KIND_ACCOUNT).unwrap(), None);
    assert_eq!(
        load_stoken(&db, KIND_VAULT).unwrap().as_deref(),
        Some("st_vault")
    );
    assert_eq!(
        load_stoken(&db, "scope:share_a").unwrap().as_deref(),
        Some("st_share")
    );
    // Forgetting what is not there is fine.
    db.with_conn(forget_account_cursor).unwrap();
}

/// The first sync of every run asks about everything, so opening the
/// database drops the cursor and keeps the rest.
#[test]
fn opening_the_database_forgets_the_account_cursor() {
    let dir = std::env::temp_dir().join(format!(
        "mindstream-account-cursor-{}-{}",
        std::process::id(),
        Utc::now().timestamp_nanos_opt().unwrap_or_default()
    ));
    let path = dir.join("notes.db");
    {
        let db = Db::open(&path).unwrap();
        save_stoken(&db, KIND_ACCOUNT, Some("st_account")).unwrap();
        save_stoken(&db, KIND_VAULT, Some("st_vault")).unwrap();
    }

    let db = Db::open(&path).unwrap();
    assert_eq!(load_stoken(&db, KIND_ACCOUNT).unwrap(), None);
    assert_eq!(
        load_stoken(&db, KIND_VAULT).unwrap().as_deref(),
        Some("st_vault")
    );

    drop(db);
    let _ = std::fs::remove_dir_all(&dir);
}
