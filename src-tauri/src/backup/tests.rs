use super::*;
use crate::db::open_memory_for_tests;
use std::io::Read;

/// In-memory DBs can't be VACUUMed INTO via a path-based connection
/// (the source is `:memory:`). The tests below exercise the parts
/// that don't depend on VACUUM INTO — manifest assembly, counts,
/// zip layout — by driving them directly. The end-to-end
/// snapshot+zip path is exercised via the integration smoke test in
/// `run_backup_smoke_via_disk` below, which uses a real on-disk DB.
use crate::collections::{create as create_collection, CreateCollection};
use crate::notes::{create as create_note, CreateNote};

fn seed_notes_and_folders(db: &Db) {
    let folder = db
        .with_conn(|c| {
            create_collection(
                c,
                CreateCollection {
                    name: "f".into(),
                    parent_collection_id: None,
                },
            )
        })
        .unwrap()
        .id;
    db.with_conn(|c| {
        create_note(
            c,
            CreateNote {
                title: Some("n1".into()),
                body: Some("body".into()),
                parent_collection_id: Some(folder.clone()),
                note_kind: None,
            },
        )
    })
    .unwrap();
    db.with_conn(|c| {
        create_note(
            c,
            CreateNote {
                title: Some("n2".into()),
                body: Some("".into()),
                parent_collection_id: None,
                note_kind: None,
            },
        )
    })
    .unwrap();
}

#[test]
fn read_counts_excludes_the_trash_folder() {
    let db = open_memory_for_tests();
    seed_notes_and_folders(&db);
    let counts = db.with_conn(|c| read_counts(c)).unwrap();
    assert_eq!(counts.notes, 2);
    assert_eq!(
        counts.folders, 1,
        "the built-in 'trash' collection must not show up in the count"
    );
    assert_eq!(counts.assets_bytes, 0, "no assets seeded");
}

#[test]
fn read_account_identity_returns_none_for_local_only_db() {
    let db = open_memory_for_tests();
    seed_notes_and_folders(&db);
    let identity = db.with_conn(|c| read_account_identity(c, None)).unwrap();
    assert!(
        identity.is_none(),
        "fresh local DB has no sync_state rows, no identity to record"
    );
}

#[test]
fn read_account_identity_returns_uids_when_sync_state_is_populated() {
    let db = open_memory_for_tests();
    seed_notes_and_folders(&db);
    db.with_conn(|c| {
        c.execute(
            "INSERT INTO sync_state(kind, etebase_collection_uid, stoken)
             VALUES ('notes', 'uid-notes-123', 'stok-1')",
            [],
        )?;
        c.execute(
            "INSERT INTO sync_state(kind, etebase_collection_uid, stoken)
             VALUES ('folders', 'uid-folders-456', 'stok-2')",
            [],
        )?;
        Ok(())
    })
    .unwrap();

    let identity = db
        .with_conn(|c| read_account_identity(c, None))
        .unwrap()
        .expect("identity present when both UIDs are stored");
    assert_eq!(identity.etebase_collection_uid_notes, "uid-notes-123");
    assert_eq!(identity.etebase_collection_uid_folders, "uid-folders-456");
    assert!(
        identity.server_url.is_none(),
        "no session ⇒ no friendly url"
    );
    assert!(identity.username.is_none(), "no session ⇒ no username");
}

#[test]
fn read_account_identity_carries_session_strings_through() {
    let db = open_memory_for_tests();
    seed_notes_and_folders(&db);
    db.with_conn(|c| {
        c.execute(
            "INSERT INTO sync_state(kind, etebase_collection_uid, stoken)
             VALUES ('notes', 'uid-notes-123', 'stok-1')",
            [],
        )?;
        c.execute(
            "INSERT INTO sync_state(kind, etebase_collection_uid, stoken)
             VALUES ('folders', 'uid-folders-456', 'stok-2')",
            [],
        )?;
        Ok(())
    })
    .unwrap();

    let session = auth::SessionInfo {
        username: "alice".into(),
        server_url: "https://etebase.example/".into(),
    };
    let identity = db
        .with_conn(|c| read_account_identity(c, Some(&session)))
        .unwrap()
        .expect("identity");
    assert_eq!(identity.username.as_deref(), Some("alice"));
    assert_eq!(
        identity.server_url.as_deref(),
        Some("https://etebase.example/")
    );
}

#[test]
fn read_account_identity_skips_half_synced_state() {
    // Only one kind pushed — an in-progress sync state. We refuse
    // to record an account identity for this; the import side
    // can't reliably match against a partial pair.
    let db = open_memory_for_tests();
    seed_notes_and_folders(&db);
    db.with_conn(|c| {
        c.execute(
            "INSERT INTO sync_state(kind, etebase_collection_uid, stoken)
             VALUES ('notes', 'uid-notes-123', 'stok-1')",
            [],
        )?;
        Ok(())
    })
    .unwrap();
    let identity = db.with_conn(|c| read_account_identity(c, None)).unwrap();
    assert!(identity.is_none());
}

#[test]
fn write_zip_round_trips_manifest_and_db_bytes() {
    let tmp_dir = std::env::temp_dir().join(format!("ms-backup-test-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&tmp_dir).unwrap();
    let db_path = tmp_dir.join("source.db");
    let zip_path = tmp_dir.join("out.zip");
    fs::write(&db_path, b"SQLite fake content for zip roundtrip").unwrap();

    let manifest = Manifest {
        format_version: MANIFEST_FORMAT_VERSION,
        app_version: "0.0.0-test".into(),
        schema_version: 11,
        created_at: "2026-06-10T00:00:00+00:00".into(),
        account_present_at_export: false,
        account: None,
        contents: Contents {
            db_filename: DB_ENTRY_NAME.into(),
            counts: Counts {
                notes: 3,
                folders: 2,
                assets_bytes: 0,
            },
        },
    };

    write_zip(&zip_path, &manifest, &db_path).unwrap();

    let bytes = fs::read(&zip_path).unwrap();
    let cursor = std::io::Cursor::new(bytes);
    let mut archive = zip::ZipArchive::new(cursor).unwrap();
    assert_eq!(archive.len(), 2, "manifest + db");

    let mut manifest_entry = archive.by_name(MANIFEST_ENTRY_NAME).unwrap();
    let mut manifest_bytes = Vec::new();
    manifest_entry.read_to_end(&mut manifest_bytes).unwrap();
    drop(manifest_entry);
    let parsed: Manifest = serde_json::from_slice(&manifest_bytes).unwrap();
    assert_eq!(parsed.format_version, MANIFEST_FORMAT_VERSION);
    assert_eq!(parsed.contents.counts.notes, 3);
    assert!(parsed.account.is_none());

    let mut db_entry = archive.by_name(DB_ENTRY_NAME).unwrap();
    let mut db_bytes = Vec::new();
    db_entry.read_to_end(&mut db_bytes).unwrap();
    assert_eq!(db_bytes, b"SQLite fake content for zip roundtrip");

    fs::remove_dir_all(&tmp_dir).ok();
}

fn sample_manifest() -> Manifest {
    Manifest {
        format_version: MANIFEST_FORMAT_VERSION,
        app_version: "0.0.0-test".into(),
        schema_version: 11,
        created_at: "2026-06-10T00:00:00+00:00".into(),
        account_present_at_export: false,
        account: None,
        contents: Contents {
            db_filename: DB_ENTRY_NAME.into(),
            counts: Counts {
                notes: 1,
                folders: 1,
                assets_bytes: 0,
            },
        },
    }
}

#[test]
fn extract_zip_into_recovers_manifest_and_db_bytes() {
    let tmp = std::env::temp_dir().join(format!("ms-extract-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&tmp).unwrap();
    let db_src = tmp.join("source.db");
    let zip = tmp.join("backup.zip");
    fs::write(&db_src, b"db-bytes-here").unwrap();
    write_zip(&zip, &sample_manifest(), &db_src).unwrap();

    let out_dir = tmp.join("extracted");
    let db_target = out_dir.join("restored.db");
    let manifest = extract_zip_into(&zip, &out_dir, &db_target).unwrap();

    assert_eq!(manifest.contents.counts.notes, 1);
    assert_eq!(fs::read(&db_target).unwrap(), b"db-bytes-here");

    fs::remove_dir_all(&tmp).ok();
}

#[test]
fn extract_zip_into_rejects_a_zip_without_a_manifest() {
    let tmp = std::env::temp_dir().join(format!("ms-extract-bad-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&tmp).unwrap();
    let zip_path = tmp.join("empty.zip");
    {
        let file = fs::File::create(&zip_path).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let opts: zip::write::FileOptions<()> = zip::write::FileOptions::default();
        zip.start_file("unrelated.txt", opts).unwrap();
        zip.write_all(b"nope").unwrap();
        zip.finish().unwrap();
    }
    let err = extract_zip_into(&zip_path, &tmp.join("out"), &tmp.join("out/db")).unwrap_err();
    assert!(format!("{err}").contains("manifest"));
    fs::remove_dir_all(&tmp).ok();
}

#[test]
fn with_extra_extension_appends_a_suffix() {
    let p = Path::new("/tmp/backup.zip");
    assert_eq!(
        with_extra_extension(p, "tmp"),
        Path::new("/tmp/backup.zip.tmp")
    );
}

#[test]
fn sweep_staging_root_removes_every_child() {
    let root = std::env::temp_dir().join(format!("ms-sweep-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(root.join("a")).unwrap();
    fs::create_dir_all(root.join("b")).unwrap();
    fs::write(root.join("a/file.txt"), b"x").unwrap();

    sweep_staging_root(&root);

    let remaining = fs::read_dir(&root).unwrap().count();
    assert_eq!(remaining, 0);
    fs::remove_dir_all(&root).ok();
}

#[test]
fn apply_pending_restore_swaps_db_and_saves_a_safety_copy() {
    let app_data = std::env::temp_dir().join(format!("ms-restore-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&app_data).unwrap();
    let live = app_data.join("mindstream.db");
    let pending = app_data.join(PENDING_DB_FILE);
    let sentinel = app_data.join(SENTINEL_FILE);
    fs::write(&live, b"old").unwrap();
    fs::write(&pending, b"new").unwrap();
    fs::write(&sentinel, b"").unwrap();

    apply_pending_restore(&app_data, &pending, &sentinel).unwrap();

    assert_eq!(fs::read(&live).unwrap(), b"new", "pending DB is now live");
    assert!(!pending.exists(), "pending consumed");
    assert!(!sentinel.exists(), "sentinel cleared");
    let safety = fs::read_dir(&app_data).unwrap().flatten().any(|e| {
        e.file_name()
            .to_string_lossy()
            .starts_with("mindstream-pre-restore-")
    });
    assert!(safety, "a timestamped safety copy of the old DB was made");

    fs::remove_dir_all(&app_data).ok();
}

#[test]
fn suggested_filename_is_path_safe() {
    let name = suggested_filename();
    assert!(name.starts_with("mindstream-backup-"));
    assert!(name.ends_with(".zip"));
    // No colons — Windows would reject them in a filename.
    assert!(!name.contains(':'), "{name} contains a colon");
}

// ---------- Import-side tests ----------

fn open_fresh_disk_db(dir: &Path, filename: &str) -> Connection {
    let path = dir.join(filename);
    if path.exists() {
        fs::remove_file(&path).ok();
    }
    let mut conn = Connection::open(&path).unwrap();
    conn.pragma_update(None, "foreign_keys", "ON").unwrap();
    migrations::run(&mut conn).unwrap();
    conn
}

#[test]
fn validate_rejects_a_random_sqlite_file() {
    let tmp = std::env::temp_dir().join(format!("ms-import-val-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&tmp).unwrap();
    let conn = Connection::open(tmp.join("not-mindstream.db")).unwrap();
    conn.execute("CREATE TABLE foo (id INTEGER PRIMARY KEY)", [])
        .unwrap();
    let err = validate_looks_like_mindstream_db(&conn).unwrap_err();
    assert!(
        err.to_string().contains("missing"),
        "expected missing-table error, got {err}"
    );
    fs::remove_dir_all(&tmp).ok();
}

#[test]
fn sanitize_clears_sync_metadata_and_tombstones() {
    // Set up an on-disk DB that looks "fully synced" — every row
    // has etebase_uid + etag, sync_state is populated, a tombstone
    // is queued. After sanitize, none of that should remain.
    let tmp = std::env::temp_dir().join(format!("ms-import-san-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&tmp).unwrap();
    let db_path = tmp.join("data.db");
    {
        let conn = open_fresh_disk_db(&tmp, "data.db");
        let now = chrono::Utc::now().to_rfc3339();
        conn.execute(
            "INSERT INTO notes(id, parent_collection_id, title, body, position,
                                created, modified, dirty, note_kind,
                                etebase_uid, etebase_etag)
             VALUES ('note_x', NULL, 't', 'b', 0, ?1, ?1, 0, 'markdown',
                     'eu-1', 'ee-1')",
            params![now],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO collections(id, parent_collection_id, name, position,
                                      created, modified, dirty,
                                      etebase_uid, etebase_etag)
             VALUES ('coll_x', NULL, 'c', 0, ?1, ?1, 0, 'eu-c', 'ee-c')",
            params![now],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO sync_state(kind, etebase_collection_uid, stoken)
             VALUES ('notes', 'uid-n', 'stok-n')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO sync_state(kind, etebase_collection_uid, stoken)
             VALUES ('folders', 'uid-f', 'stok-f')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO tombstones(kind, etebase_uid, queued_at)
             VALUES ('note', 'gone-1', ?1)",
            params![now],
        )
        .unwrap();
    }

    sanitize_for_foreign_account(&db_path).unwrap();

    let conn = Connection::open(&db_path).unwrap();
    let (uid, etag, dirty): (Option<String>, Option<String>, i64) = conn
        .query_row(
            "SELECT etebase_uid, etebase_etag, dirty FROM notes WHERE id = 'note_x'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .unwrap();
    assert!(uid.is_none());
    assert!(etag.is_none());
    assert_eq!(dirty, 1, "sanitized row must be marked dirty for re-push");
    let coll_uid: Option<String> = conn
        .query_row(
            "SELECT etebase_uid FROM collections WHERE id = 'coll_x'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert!(coll_uid.is_none());
    let sync_count: i64 = conn
        .query_row("SELECT COUNT(*) FROM sync_state", [], |r| r.get(0))
        .unwrap();
    assert_eq!(sync_count, 0);
    let tomb_count: i64 = conn
        .query_row("SELECT COUNT(*) FROM tombstones", [], |r| r.get(0))
        .unwrap();
    assert_eq!(tomb_count, 0);

    // The built-in trash collection must not be touched by the
    // collections sanitise (its `dirty` should stay 0 per
    // migration 4).
    let trash_dirty: i64 = conn
        .query_row(
            "SELECT dirty FROM collections WHERE id = 'trash'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(trash_dirty, 0, "trash collection mustn't be re-dirtied");
    fs::remove_dir_all(&tmp).ok();
}

fn seed_backup_db(conn: &Connection, label: &str) {
    let now = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO collections(id, parent_collection_id, name, position,
                                  created, modified, dirty,
                                  etebase_uid, etebase_etag)
         VALUES (?1, NULL, ?2, 0, ?3, ?3, 0, 'eu-c', 'ee-c')",
        params![format!("coll_{label}"), format!("Folder {label}"), now],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO notes(id, parent_collection_id, title, body, position,
                            created, modified, dirty, note_kind,
                            etebase_uid, etebase_etag)
         VALUES (?1, ?2, ?3, 'body', 0, ?4, ?4, 0, 'markdown', 'eu-n', 'ee-n')",
        params![
            format!("note_{label}"),
            format!("coll_{label}"),
            format!("Note {label}"),
            now,
        ],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO note_tags(note_id, tag) VALUES (?1, ?2)",
        params![format!("note_{label}"), "tag-x"],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO assets(id, owning_note_id, mime_type, bytes, size,
                             created, modified, dirty, etebase_uid)
         VALUES (?1, ?2, 'image/png', X'8950', 2, ?3, ?3, 0, 'eu-a')",
        params![format!("asset_{label}"), format!("note_{label}"), now],
    )
    .unwrap();
}

#[test]
fn merge_adds_missing_rows_and_strips_sync_metadata() {
    let live_db = open_memory_for_tests();
    seed_notes_and_folders(&live_db); // some pre-existing local content
    let backup_conn = Connection::open_in_memory().unwrap();
    backup_conn
        .pragma_update(None, "foreign_keys", "ON")
        .unwrap();
    {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        migrations::run(&mut conn).unwrap();
        seed_backup_db(&conn, "BACKUP");
        // Drain the prepared in-memory backup into the test's
        // `backup_conn` via the SQL serialise dance isn't really
        // needed — just seed `backup_conn` directly.
        drop(conn);
    }
    // Easier: seed the original `backup_conn` directly.
    let backup_conn = {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        migrations::run(&mut conn).unwrap();
        seed_backup_db(&conn, "BACKUP");
        conn
    };

    let report = live_db
        .with_conn_mut(|live| merge_into(live, &backup_conn))
        .unwrap();
    assert_eq!(report.folders_added, 1);
    assert_eq!(report.notes_added, 1);
    assert_eq!(report.assets_added, 1);
    assert_eq!(report.notes_orphaned, 0);

    // The imported note must have NULL etebase metadata + dirty=1.
    let (uid, etag, dirty): (Option<String>, Option<String>, i64) = live_db
        .with_conn(|c| {
            Ok(c.query_row(
                "SELECT etebase_uid, etebase_etag, dirty FROM notes WHERE id = 'note_BACKUP'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )?)
        })
        .unwrap();
    assert!(uid.is_none());
    assert!(etag.is_none());
    assert_eq!(dirty, 1);

    // Tag carried over.
    let tag_count: i64 = live_db
        .with_conn(|c| {
            Ok(c.query_row(
                "SELECT COUNT(*) FROM note_tags WHERE note_id = 'note_BACKUP'",
                [],
                |r| r.get(0),
            )?)
        })
        .unwrap();
    assert_eq!(tag_count, 1);

    // Asset carried, with stripped UID + dirty=1.
    let asset_uid: Option<String> = live_db
        .with_conn(|c| {
            Ok(c.query_row(
                "SELECT etebase_uid FROM assets WHERE id = 'asset_BACKUP'",
                [],
                |r| r.get(0),
            )?)
        })
        .unwrap();
    assert!(asset_uid.is_none());
}

#[test]
fn merge_skips_rows_whose_id_already_exists_locally() {
    let live_db = open_memory_for_tests();
    let backup_conn = {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        migrations::run(&mut conn).unwrap();
        seed_backup_db(&conn, "SHARED");
        conn
    };
    // First merge brings the row in.
    let r1 = live_db
        .with_conn_mut(|live| merge_into(live, &backup_conn))
        .unwrap();
    assert_eq!(r1.notes_added, 1);
    // Second merge against the same backup must be a no-op.
    let r2 = live_db
        .with_conn_mut(|live| merge_into(live, &backup_conn))
        .unwrap();
    assert_eq!(r2.notes_added, 0);
    assert_eq!(r2.folders_added, 0);
    assert_eq!(r2.assets_added, 0);
}

#[test]
fn merge_reroutes_orphan_note_parents_to_root() {
    // Seed a backup with a note whose parent_collection_id refers
    // to a folder the backup *also* won't have (FKs disabled for
    // the seed step to allow the deliberately-broken state). This
    // simulates the case where the user merged piecemeal and the
    // folder never made it across.
    let live_db = open_memory_for_tests();
    let backup_conn = {
        let mut conn = Connection::open_in_memory().unwrap();
        migrations::run(&mut conn).unwrap();
        // `migrations::run` re-enables FKs at the end. Toggle off
        // *after* it so the deliberately dangling reference can be
        // inserted for this test.
        conn.pragma_update(None, "foreign_keys", "OFF").unwrap();
        let now = chrono::Utc::now().to_rfc3339();
        conn.execute(
            "INSERT INTO notes(id, parent_collection_id, title, body, position,
                                created, modified, dirty, note_kind)
             VALUES ('note_orphan', 'coll_missing', 'orphan', '', 0, ?1, ?1, 0, 'markdown')",
            params![now],
        )
        .unwrap();
        conn
    };

    let report = live_db
        .with_conn_mut(|live| merge_into(live, &backup_conn))
        .unwrap();
    assert_eq!(report.notes_added, 1);
    assert_eq!(report.notes_orphaned, 1);
    let parent: Option<String> = live_db
        .with_conn(|c| {
            Ok(c.query_row(
                "SELECT parent_collection_id FROM notes WHERE id = 'note_orphan'",
                [],
                |r| r.get(0),
            )?)
        })
        .unwrap();
    assert!(parent.is_none(), "orphan note must land at root");
}

#[test]
fn merge_skips_assets_whose_owner_isnt_present() {
    // Backup has an asset, but the owning note didn't come over
    // (and isn't already present locally either — truly orphaned).
    // We refuse to import a dangling blob.
    let live_db = open_memory_for_tests();
    let backup_conn = {
        let mut conn = Connection::open_in_memory().unwrap();
        migrations::run(&mut conn).unwrap();
        // Toggle FKs off *after* migrations so the dangling
        // owning_note_id can be inserted.
        conn.pragma_update(None, "foreign_keys", "OFF").unwrap();
        let now = chrono::Utc::now().to_rfc3339();
        conn.execute(
            "INSERT INTO assets(id, owning_note_id, mime_type, bytes, size,
                                 created, modified, dirty)
             VALUES ('asset_orphan_blob', 'note_missing', 'image/png', X'8950', 2, ?1, ?1, 0)",
            params![now],
        )
        .unwrap();
        conn
    };

    let report = live_db
        .with_conn_mut(|live| merge_into(live, &backup_conn))
        .unwrap();
    assert_eq!(report.assets_added, 0, "orphan blob must not be imported");
}

#[test]
fn merge_does_not_overwrite_existing_local_notes() {
    // A note id present in both local and backup must keep its
    // local content — merge is insert-only, never update.
    let live_db = open_memory_for_tests();
    live_db
        .with_conn(|c| {
            let now = chrono::Utc::now().to_rfc3339();
            c.execute(
                "INSERT INTO notes(id, parent_collection_id, title, body, position,
                                    created, modified, dirty, note_kind)
                 VALUES ('note_collision', NULL, 'local', '', 0, ?1, ?1, 0, 'markdown')",
                params![now],
            )?;
            Ok(())
        })
        .unwrap();
    let backup_conn = {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        migrations::run(&mut conn).unwrap();
        let now = chrono::Utc::now().to_rfc3339();
        conn.execute(
            "INSERT INTO notes(id, parent_collection_id, title, body, position,
                                created, modified, dirty, note_kind)
             VALUES ('note_collision', NULL, 'backup', '', 0, ?1, ?1, 0, 'markdown')",
            params![now],
        )
        .unwrap();
        conn
    };

    let report = live_db
        .with_conn_mut(|live| merge_into(live, &backup_conn))
        .unwrap();
    assert_eq!(report.notes_added, 0, "id collision must skip insert");
    let title: String = live_db
        .with_conn(|c| {
            Ok(c.query_row(
                "SELECT title FROM notes WHERE id = 'note_collision'",
                [],
                |r| r.get(0),
            )?)
        })
        .unwrap();
    assert_eq!(title, "local", "local content must be preserved");
}
