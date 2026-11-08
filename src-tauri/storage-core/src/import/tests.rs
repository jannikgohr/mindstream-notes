//! The engine reached only through its seams, with no disk, as a browser runs
//! it. The app's suite in `src-tauri/src/import/tests.rs` covers each format in
//! depth.

use std::cell::RefCell;
use std::collections::BTreeMap;
use std::io::{self, Cursor, Read};
use std::rc::Rc;
use std::sync::atomic::AtomicBool;

use rusqlite::Connection;

use super::tar_files::TarFiles;
use super::*;
use crate::error::AppError;
use crate::migrations;

#[derive(Clone, Default)]
struct MemoryFiles(Rc<BTreeMap<String, Vec<u8>>>);

impl MemoryFiles {
    fn new(files: &[(&str, &[u8])]) -> Self {
        Self(Rc::new(
            files
                .iter()
                .map(|(path, bytes)| (path.to_string(), bytes.to_vec()))
                .collect(),
        ))
    }
}

impl ImportFiles for MemoryFiles {
    fn walk(&self, skip: &dyn Fn(&str) -> bool) -> Vec<ImportEntry> {
        walk_paths(self.0.keys().map(String::as_str), skip)
    }

    fn root_files(&self) -> io::Result<Vec<String>> {
        Ok(self
            .0
            .keys()
            .filter(|path| !path.contains('/'))
            .cloned()
            .collect())
    }

    fn read(&self, path: &str) -> io::Result<Vec<u8>> {
        self.0
            .get(path)
            .cloned()
            .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, path.to_string()))
    }

    fn read_range(&self, path: &str, start: u64, length: usize) -> io::Result<Vec<u8>> {
        let bytes = self.read(path)?;
        let start = (start as usize).min(bytes.len());
        let end = (start + length).min(bytes.len());
        Ok(bytes[start..end].to_vec())
    }

    fn stream(&self, path: &str) -> io::Result<Box<dyn Read>> {
        Ok(Box::new(Cursor::new(self.read(path)?)))
    }

    fn is_file(&self, path: &str) -> bool {
        self.0.contains_key(path)
    }

    fn is_dir(&self, path: &str) -> bool {
        let prefix = format!("{path}/");
        self.0.keys().any(|entry| entry.starts_with(&prefix))
    }

    fn modified(&self, _path: &str) -> Option<String> {
        Some("2024-03-04T05:06:07+00:00".into())
    }
}

struct MemoryStore(RefCell<Connection>);

impl MemoryStore {
    fn new() -> Self {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        migrations::run(&mut conn).unwrap();
        Self(RefCell::new(conn))
    }

    fn note(&self, title: &str) -> (String, String) {
        self.0
            .borrow()
            .query_row(
                "SELECT id, body FROM notes WHERE title = ?1",
                [title],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap()
    }
}

impl ImportStore for MemoryStore {
    fn with_conn_mut<T>(
        &self,
        write: impl FnOnce(&mut Connection) -> AppResult<T>,
    ) -> AppResult<T> {
        write(&mut self.0.borrow_mut())
    }
}

fn options(kind: ImportSourceKind) -> ImportOptions {
    ImportOptions {
        source_path: String::new(),
        kind: Some(kind),
        destination_collection_id: None,
        create_folder_named: Some("Imported".into()),
        import_attachments: true,
        max_attachment_bytes: DEFAULT_MAX_ATTACHMENT_BYTES,
        unresolved_links: UnresolvedLinks::default(),
    }
}

fn run(
    store: &MemoryStore,
    kind: ImportSourceKind,
    files: Box<dyn ImportFiles>,
    file_name: &str,
) -> ImportReport {
    let mut source = build_source(kind, files, file_name);
    run_import(
        store,
        source.as_mut(),
        &options(kind),
        &AtomicBool::new(false),
        |_| {},
    )
    .unwrap()
}

fn joplin_item(title: &str, body: &str, fields: &[(&str, &str)]) -> Vec<u8> {
    let meta: String = fields
        .iter()
        .map(|(key, value)| format!("{key}: {value}\n"))
        .collect();
    format!("{title}\n\n{body}\n\n{meta}").into_bytes()
}

const NOTE_A: &str = "0a1b2c3d4e5f60718293a4b5c6d7e8f9";
const NOTE_B: &str = "1b2c3d4e5f60718293a4b5c6d7e8f9a0";

fn jex_with(entries: &[(&str, Vec<u8>)]) -> Vec<u8> {
    let mut builder = tar::Builder::new(Vec::new());
    for (path, bytes) in entries {
        let mut header = tar::Header::new_gnu();
        header.set_path(path).unwrap();
        header.set_size(bytes.len() as u64);
        header.set_mode(0o644);
        header.set_cksum();
        builder.append(&header, bytes.as_slice()).unwrap();
    }
    builder.into_inner().unwrap()
}

#[test]
fn a_vault_imports_with_its_links_and_attachments() {
    let files = MemoryFiles::new(&[
        ("Index.md", b"See [[Other]] and ![[photo.png]]."),
        ("Sub/Other.md", b"# Other\n\nBack to [[Index]]."),
        ("pics/photo.png", &[137, 80, 78, 71]),
        (".obsidian/app.json", b"{}"),
        (".DS_Store", b"junk"),
    ]);
    assert_eq!(
        detect::detect_directory_kind(&files),
        ImportSourceKind::Obsidian
    );

    let store = MemoryStore::new();
    let report = run(&store, ImportSourceKind::Obsidian, Box::new(files), "");

    assert_eq!(report.notes_created, 2);
    assert_eq!(report.links_resolved, 2);
    assert_eq!(report.attachments_imported, 1);
    assert_eq!(report.errors, 0);
    let (other, _) = store.note("Other");
    let (_, index) = store.note("Index");
    assert!(index.contains(&other), "the link names the note: {index}");
    assert!(index.contains("asset:mindstream/"), "{index}");
}

#[test]
fn a_jex_archive_is_read_in_place() {
    let archive = jex_with(&[
        (
            &format!("{NOTE_A}.md"),
            joplin_item(
                "First note",
                &format!("Points at [Second note](:/{NOTE_B})."),
                &[("id", NOTE_A), ("type_", "1")],
            ),
        ),
        (
            &format!("{NOTE_B}.md"),
            joplin_item(
                "Second note",
                &format!("Back to [First note](:/{NOTE_A})."),
                &[("id", NOTE_B), ("type_", "1")],
            ),
        ),
    ]);
    let source = MemoryFiles::new(&[("export.jex", &archive)]);
    let files = TarFiles::new(Box::new(source), "export.jex".into()).unwrap();
    assert!(sources::joplin_raw::looks_like_raw_export(&files));

    let store = MemoryStore::new();
    let report = run(&store, ImportSourceKind::JoplinJex, Box::new(files), "");

    assert_eq!(report.notes_created, 2);
    assert_eq!(report.links_resolved, 2);
    let (second, _) = store.note("Second note");
    assert!(store.note("First note").1.contains(&second));
}

#[test]
fn a_jex_entry_cannot_climb_out_of_the_archive() {
    // set_path refuses `..`, so write the name into the header, as a hostile
    // archive would.
    let mut builder = tar::Builder::new(Vec::new());
    let payload = b"pwned";
    let mut header = tar::Header::new_gnu();
    let name = b"../escaped.md";
    header.as_gnu_mut().unwrap().name[..name.len()].copy_from_slice(name);
    header.set_size(payload.len() as u64);
    header.set_mode(0o644);
    header.set_cksum();
    builder.append(&header, &payload[..]).unwrap();
    let archive = builder.into_inner().unwrap();

    let source = MemoryFiles::new(&[("evil.jex", &archive)]);
    let files = TarFiles::new(Box::new(source), "evil.jex".into()).unwrap();

    assert!(files.walk(&|_| false).is_empty());
    assert!(!files.is_file("../escaped.md"));
}

#[test]
fn a_tar_entry_reads_only_its_own_bytes() {
    let archive = jex_with(&[("a.md", b"first".to_vec()), ("b.md", b"second".to_vec())]);
    let source = MemoryFiles::new(&[("x.jex", &archive)]);
    let files = TarFiles::new(Box::new(source), "x.jex".into()).unwrap();

    assert_eq!(files.read("b.md").unwrap(), b"second");
    assert_eq!(files.read_range("b.md", 2, 100).unwrap(), b"cond");
    assert_eq!(files.read_range("a.md", 9, 100).unwrap(), b"");
    assert_eq!(
        files.read("missing.md").unwrap_err().kind(),
        io::ErrorKind::NotFound
    );
    assert_eq!(files.root_files().unwrap(), ["a.md", "b.md"]);
    let mut text = String::new();
    files
        .stream("a.md")
        .unwrap()
        .read_to_string(&mut text)
        .unwrap();
    assert_eq!(text, "first");
    assert!(files.modified("a.md").is_none());
}

#[test]
fn an_evernote_export_is_read_by_byte_range() {
    let note = |title: &str, text: &str| {
        format!(
            "<note><title>{title}</title><content><![CDATA[<en-note>{text}</en-note>]]></content>\
             <created>20240102T101500Z</created></note>"
        )
    };
    let enex = format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?><en-export>{}{}</en-export>",
        note("Köln", "Am Dom"),
        note("Bonn", "Am Rhein")
    );
    let files = MemoryFiles::new(&[("export.enex", enex.as_bytes())]);

    let store = MemoryStore::new();
    let report = run(
        &store,
        ImportSourceKind::Evernote,
        Box::new(files),
        "export.enex",
    );

    assert_eq!(report.notes_created, 2);
    assert!(store.note("Köln").1.contains("Am Dom"));
    assert!(store.note("Bonn").1.contains("Am Rhein"));
}

#[test]
fn single_files_are_recognised_by_their_extension() {
    use detect::detect_file_kind;
    assert_eq!(
        detect_file_kind("Export.JEX"),
        Some(ImportSourceKind::JoplinJex)
    );
    assert_eq!(
        detect_file_kind("notes.enex"),
        Some(ImportSourceKind::Evernote)
    );
    assert_eq!(detect_file_kind("notes.zip"), None);
    assert_eq!(detect_file_kind("notes"), None);
}

#[test]
fn the_walk_sorts_each_directory_and_prunes_what_it_skips() {
    let paths = [
        "a-b/c.md",
        "a/b.md",
        "a.md",
        ".hidden/secret.md",
        "a/.DS_Store",
    ];
    let walked = walk_paths(paths.into_iter(), &|name| name.starts_with('.'));
    let order: Vec<(&str, bool)> = walked
        .iter()
        .map(|entry| (entry.path.as_str(), entry.is_dir))
        .collect();
    assert_eq!(
        order,
        [
            ("a", true),
            ("a/b.md", false),
            ("a-b", true),
            ("a-b/c.md", false),
            ("a.md", false),
        ]
    );
}

/// Items held in memory, so a test can choose which ones fail.
struct ScriptedSource {
    count: usize,
    folders: usize,
    failing_loads: Vec<usize>,
    failing_attachments: Vec<usize>,
    body: &'static str,
    attachments: bool,
    attachment_size: usize,
}

impl ScriptedSource {
    fn new(count: usize) -> Self {
        Self {
            count,
            folders: 0,
            failing_loads: Vec::new(),
            failing_attachments: Vec::new(),
            body: "body",
            attachments: false,
            attachment_size: 4,
        }
    }
}

impl source::ImportSource for ScriptedSource {
    fn index(&mut self) -> AppResult<model::SourceIndex> {
        let items = (0..self.count)
            .map(|i| model::ItemIndex {
                note_id: format!("{i:032x}"),
                title: format!("Note {i}"),
                folder_id: None,
                locator: i.to_string(),
                aliases: Vec::new(),
            })
            .collect();
        let folders = (0..self.folders)
            .map(|i| model::FolderIndex {
                id: format!("f{i:031x}"),
                parent_id: None,
                name: format!("Folder {i}"),
            })
            .collect();
        Ok(model::SourceIndex { folders, items })
    }

    fn load(&mut self, item: &model::ItemIndex) -> AppResult<source::LoadedItem> {
        let index: usize = item.locator.parse().unwrap();
        if self.failing_loads.contains(&index) {
            return Err(AppError::InvalidArg(format!("item {index} is unreadable")));
        }
        let attachments = if self.attachments {
            vec![model::AttachmentRef {
                locator: format!("{index}.png"),
                placeholder: format!("{index}.png"),
                mime_type: "image/png".into(),
            }]
        } else {
            Vec::new()
        };
        Ok(source::LoadedItem {
            note: model::StagedNote {
                note_id: item.note_id.clone(),
                title: item.title.clone(),
                folder_id: None,
                body: self.body.to_string(),
                tags: Vec::new(),
                created: None,
                modified: None,
                note_kind: crate::notes::NoteKind::Markdown,
            },
            attachments,
        })
    }

    fn attachment_bytes(&mut self, reference: &model::AttachmentRef) -> AppResult<Option<Vec<u8>>> {
        let index: usize = reference.locator.trim_end_matches(".png").parse().unwrap();
        if self.failing_attachments.contains(&index) {
            return Err(AppError::InvalidArg(format!("attachment {index} is gone")));
        }
        let mut bytes = vec![0; self.attachment_size];
        bytes[..4].copy_from_slice(&[137, 80, 78, 71]);
        Ok(Some(bytes))
    }

    fn rewrite_options(&self) -> links::RewriteOptions {
        links::RewriteOptions {
            wikilinks: true,
            markdown_links: false,
            id_links: false,
            evernote_links: false,
            keep_unresolved_wikilinks: false,
        }
    }
}

#[test]
fn progress_reports_committed_notes_apart_from_items_processed() {
    // Items 3 and 700 fail to load. Batches flush every 500 notes, so the
    // first ping lands after item 500 and the second after item 1001.
    let mut source = ScriptedSource::new(1200);
    source.folders = 2;
    source.failing_loads = vec![3, 700];
    let store = MemoryStore::new();
    let mut progress = Vec::new();

    let report = run_import(
        &store,
        &mut source,
        &options(ImportSourceKind::Obsidian),
        &AtomicBool::new(false),
        |p| progress.push(p),
    )
    .unwrap();

    assert_eq!(report.notes_created, 1198);
    assert_eq!(report.errors, 2);
    // `done` counts failed items. The snapshot counts only what committed.
    let pings: Vec<(usize, usize, usize)> = progress
        .iter()
        .filter(|p| p.phase == "importing")
        .map(|p| (p.done, p.committed.notes_created, p.committed.errors))
        .collect();
    assert_eq!(pings, [(501, 500, 1), (1002, 1000, 2)]);
    let folders = progress.iter().find(|p| p.phase == "folders").unwrap();
    assert_eq!(folders.committed.folders_created, 2);
    assert_eq!(folders.committed.notes_created, 0);
    let last = progress.last().unwrap();
    assert_eq!(last.phase, "done");
    assert_eq!(last.committed, report);
}

#[test]
fn a_batch_is_written_once_its_attachments_reach_the_byte_limit() {
    // Eight 8 MiB attachments fill a batch long before 500 notes do.
    let mut source = ScriptedSource::new(20);
    source.attachments = true;
    source.attachment_size = 8 * 1024 * 1024;
    let store = MemoryStore::new();
    let mut progress = Vec::new();

    let report = run_import(
        &store,
        &mut source,
        &options(ImportSourceKind::Obsidian),
        &AtomicBool::new(false),
        |p| progress.push(p),
    )
    .unwrap();

    assert_eq!(report.notes_created, 20);
    let pings: Vec<(usize, usize)> = progress
        .iter()
        .filter(|p| p.phase == "importing")
        .map(|p| (p.done, p.committed.notes_created))
        .collect();
    assert_eq!(pings, [(8, 8), (16, 16)]);
}

#[test]
fn a_cancelled_run_reports_the_last_committed_count() {
    let mut source = ScriptedSource::new(1200);
    source.folders = 2;
    let store = MemoryStore::new();
    let cancelled = AtomicBool::new(false);
    let mut last_committed: Option<ImportReport> = None;

    let report = run_import(
        &store,
        &mut source,
        &options(ImportSourceKind::Obsidian),
        &cancelled,
        |p| {
            if p.phase == "importing" {
                // Stop as soon as the first batch lands, the way a user would.
                cancelled.store(true, std::sync::atomic::Ordering::SeqCst);
            }
            last_committed = Some(p.committed);
        },
    )
    .unwrap();

    assert!(report.cancelled);
    assert_eq!(report.notes_created, 500);
    let last = last_committed.unwrap();
    assert_eq!(last.notes_created, 500);
    assert_eq!(last.folders_created, 2);
    assert_eq!(last.errors, 0);
}

#[test]
fn a_failed_item_adds_no_link_or_attachment_counts() {
    // Item 0 reads its attachment after parsing its link, then fails. Its
    // unresolved link must not reach the report, since its note never lands.
    let mut source = ScriptedSource::new(2);
    source.body = "[[Missing]]";
    source.attachments = true;
    source.failing_attachments = vec![0];
    let store = MemoryStore::new();

    let report = run_import(
        &store,
        &mut source,
        &options(ImportSourceKind::Obsidian),
        &AtomicBool::new(false),
        |_| {},
    )
    .unwrap();

    assert_eq!(report.notes_created, 1);
    assert_eq!(report.errors, 1);
    assert_eq!(report.links_unresolved, 1);
    assert_eq!(report.attachments_imported, 1);
}
