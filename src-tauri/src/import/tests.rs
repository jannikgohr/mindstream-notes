use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;

use rusqlite::params;

use super::links::{self, LinkIndex, RewriteContext, RewriteOptions, RewriteStats};
use super::markdown;
use super::model::{AliasTier, UnresolvedLinks};
use super::{run_import, ImportOptions, ImportSourceKind, DEFAULT_MAX_ATTACHMENT_BYTES};
use crate::db::{open_memory_for_tests, Db};
use crate::error::AppError;

/// A throwaway directory that cleans itself up, so a failing assertion doesn't
/// leave litter in the temp dir.
struct TempVault(PathBuf);

impl TempVault {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!("ms-import-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&path).expect("temp vault");
        Self(path)
    }

    fn write(&self, relative: &str, contents: &str) -> &Self {
        self.write_bytes(relative, contents.as_bytes())
    }

    fn write_bytes(&self, relative: &str, contents: &[u8]) -> &Self {
        let path = self
            .0
            .join(relative.replace('/', std::path::MAIN_SEPARATOR_STR));
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("parent dir");
        }
        fs::write(&path, contents).expect("write fixture");
        self
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempVault {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

/// Mark a fixture vault as an Obsidian vault the way Obsidian itself does.
fn as_obsidian_vault(vault: &TempVault) {
    fs::create_dir_all(vault.path().join(".obsidian")).expect("config dir");
}

fn obsidian_options(vault: &TempVault) -> ImportOptions {
    ImportOptions {
        kind: Some(ImportSourceKind::Obsidian),
        ..options(vault)
    }
}

fn options(vault: &TempVault) -> ImportOptions {
    ImportOptions {
        source_path: vault.path().to_string_lossy().to_string(),
        kind: Some(ImportSourceKind::Gfm),
        destination_collection_id: None,
        create_folder_named: None,
        import_attachments: true,
        max_attachment_bytes: DEFAULT_MAX_ATTACHMENT_BYTES,
        unresolved_links: UnresolvedLinks::PlainText,
    }
}

fn import(db: &Db, options: ImportOptions) -> super::ImportReport {
    let cancelled = AtomicBool::new(false);
    run_import(db, options, &cancelled, |_| {}).expect("import")
}

fn body_of(db: &Db, title: &str) -> String {
    db.with_conn(|c| {
        Ok(c.query_row(
            "SELECT body FROM notes WHERE title = ?1",
            params![title],
            |r| r.get::<_, String>(0),
        )?)
    })
    .unwrap()
}

fn note_id_of(db: &Db, title: &str) -> String {
    db.with_conn(|c| {
        Ok(c.query_row(
            "SELECT id FROM notes WHERE title = ?1",
            params![title],
            |r| r.get::<_, String>(0),
        )?)
    })
    .unwrap()
}

// ---------- link resolution ----------

#[test]
fn mutual_links_resolve_in_both_directions() {
    // The case that motivates minting every id in phase 1. When Alpha's body
    // is rewritten, Beta has not been read yet — but its id already exists, so
    // the link resolves without a second pass.
    let vault = TempVault::new();
    vault
        .write("Alpha.md", "See [Beta](Beta.md).")
        .write("Beta.md", "Back to [Alpha](Alpha.md).");
    let db = open_memory_for_tests();

    let report = import(&db, options(&vault));

    assert_eq!(report.notes_created, 2);
    assert_eq!(report.links_resolved, 2);
    assert_eq!(report.links_unresolved, 0);

    let alpha = note_id_of(&db, "Alpha");
    let beta = note_id_of(&db, "Beta");
    assert_eq!(
        body_of(&db, "Alpha"),
        format!("See [Beta](mindstream://note/{beta}).")
    );
    assert_eq!(
        body_of(&db, "Beta"),
        format!("Back to [Alpha](mindstream://note/{alpha}).")
    );
}

#[test]
fn a_three_note_cycle_resolves() {
    let vault = TempVault::new();
    vault
        .write("One.md", "[Two](Two.md)")
        .write("Two.md", "[Three](Three.md)")
        .write("Three.md", "[One](One.md)");
    let db = open_memory_for_tests();

    let report = import(&db, options(&vault));

    assert_eq!(report.links_resolved, 3);
    assert_eq!(report.links_unresolved, 0);
    for (from, to) in [("One", "Two"), ("Two", "Three"), ("Three", "One")] {
        let target = note_id_of(&db, to);
        assert!(
            body_of(&db, from).contains(&format!("mindstream://note/{target}")),
            "{from} should link to {to}"
        );
    }
}

#[test]
fn a_self_link_resolves_to_the_note_itself() {
    let vault = TempVault::new();
    vault.write("Loop.md", "I link to [myself](Loop.md).");
    let db = open_memory_for_tests();

    import(&db, options(&vault));

    let id = note_id_of(&db, "Loop");
    assert_eq!(
        body_of(&db, "Loop"),
        format!("I link to [myself](mindstream://note/{id}).")
    );
}

#[test]
fn a_full_path_beats_a_basename_collision() {
    // Two notes share a file name. The bare basename can only belong to one of
    // them, but a link that spells out the path must still reach the other.
    let vault = TempVault::new();
    vault
        .write("Archive/Index.md", "---\ntitle: Archived\n---\narchived")
        .write("Index.md", "---\ntitle: Root\n---\nroot")
        .write("Hub.md", "[a](Archive/Index.md) and [b](Index.md)");
    let db = open_memory_for_tests();

    import(&db, options(&vault));

    let archived = note_id_of(&db, "Archived");
    let root = note_id_of(&db, "Root");
    let hub = body_of(&db, "Hub");
    assert!(
        hub.contains(&format!("[a](mindstream://note/{archived})")),
        "explicit path must win: {hub}"
    );
    assert!(
        hub.contains(&format!("[b](mindstream://note/{root})")),
        "{hub}"
    );
}

#[test]
fn parent_relative_links_resolve() {
    let vault = TempVault::new();
    vault
        .write("Guides/Setup.md", "Back to [home](../Home.md).")
        .write("Home.md", "hello");
    let db = open_memory_for_tests();

    import(&db, options(&vault));

    let home = note_id_of(&db, "Home");
    assert!(body_of(&db, "Setup").contains(&format!("mindstream://note/{home}")));
}

#[test]
fn percent_encoded_targets_resolve() {
    let vault = TempVault::new();
    vault
        .write("Release Notes.md", "notes")
        .write("Index.md", "[link](Release%20Notes.md)");
    let db = open_memory_for_tests();

    import(&db, options(&vault));

    let target = note_id_of(&db, "Release Notes");
    assert!(body_of(&db, "Index").contains(&format!("mindstream://note/{target}")));
}

#[test]
fn external_urls_are_left_alone() {
    let vault = TempVault::new();
    vault.write(
        "Links.md",
        "[site](https://example.com/a.md) and [anchor](#section)",
    );
    let db = open_memory_for_tests();

    let report = import(&db, options(&vault));

    assert_eq!(report.links_resolved, 0);
    assert_eq!(
        body_of(&db, "Links"),
        "[site](https://example.com/a.md) and [anchor](#section)"
    );
}

#[test]
fn unresolved_links_stay_plain_text_by_default() {
    let vault = TempVault::new();
    vault.write("Solo.md", "[missing](Ghost.md)");
    let db = open_memory_for_tests();

    let report = import(&db, options(&vault));

    // A markdown link to a file we never imported is left exactly as written:
    // rewriting it would break a link that may still be valid on disk.
    assert_eq!(report.links_resolved, 0);
    assert_eq!(report.placeholders_created, 0);
    assert_eq!(body_of(&db, "Solo"), "[missing](Ghost.md)");
}

// ---------- wikilink rewriting (exercised directly; GFM leaves [[…]] alone) ----------

fn rewrite(body: &str, index: &mut LinkIndex) -> (String, RewriteStats) {
    let mut stats = RewriteStats::default();
    let out = links::rewrite_links(
        body,
        index,
        &RewriteContext {
            options: RewriteOptions {
                wikilinks: true,
                markdown_links: true,
                id_links: true,
                evernote_links: false,
            },
            base_dir: String::new(),
        },
        &mut stats,
    );
    (out, stats)
}

#[test]
fn wikilinks_become_id_backed_links() {
    let mut index = LinkIndex::new(UnresolvedLinks::PlainText);
    index.register(AliasTier::Basename, "Target", "note_abc");

    let (out, stats) = rewrite("see [[Target]] here", &mut index);

    assert_eq!(out, "see [Target](mindstream://note/note_abc) here");
    assert_eq!(stats.resolved, 1);
}

#[test]
fn wikilink_aliases_headings_and_blocks_are_handled() {
    let mut index = LinkIndex::new(UnresolvedLinks::PlainText);
    index.register(AliasTier::Basename, "Target", "note_abc");

    let (out, _) = rewrite("[[Target|the alias]]", &mut index);
    assert_eq!(out, "[the alias](mindstream://note/note_abc)");

    // The anchor is dropped from the target — links address a note, not a
    // position — but is kept in the display text so the reference still reads
    // the way the author wrote it.
    let (out, _) = rewrite("[[Target#Section]]", &mut index);
    assert_eq!(out, "[Target#Section](mindstream://note/note_abc)");

    let (out, _) = rewrite("[[Target^block-id]]", &mut index);
    assert_eq!(out, "[Target^block-id](mindstream://note/note_abc)");
}

#[test]
fn a_note_embed_degrades_to_a_plain_link() {
    // Mindstream has no transclusion, so `![[Note]]` becomes the closest thing
    // that still works: a link to the same note.
    let mut index = LinkIndex::new(UnresolvedLinks::PlainText);
    index.register(AliasTier::Basename, "Target", "note_abc");

    let (out, _) = rewrite("![[Target]]", &mut index);

    assert_eq!(out, "[Target](mindstream://note/note_abc)");
}

#[test]
fn an_unresolved_wikilink_becomes_its_own_text() {
    let mut index = LinkIndex::new(UnresolvedLinks::PlainText);

    let (out, stats) = rewrite("a [[Ghost]] link", &mut index);

    assert_eq!(out, "a Ghost link");
    assert_eq!(stats.unresolved, 1);
    assert!(index.placeholders().is_empty());
}

#[test]
fn placeholder_policy_mints_one_note_per_missing_target() {
    // Two references to the same missing target must land on the SAME note —
    // otherwise a vault with a popular red link grows a note per mention.
    let mut index = LinkIndex::new(UnresolvedLinks::CreatePlaceholder);

    let (first, _) = rewrite("[[Ghost]]", &mut index);
    let (second, _) = rewrite("also [[ghost]]", &mut index);

    assert_eq!(index.placeholders().len(), 1);
    let id = &index.placeholders()[0].note_id;
    assert_eq!(first, format!("[Ghost](mindstream://note/{id})"));
    assert_eq!(second, format!("also [ghost](mindstream://note/{id})"));
}

#[test]
fn a_normalized_title_matches_an_underscore_separated_target() {
    // MediaWiki writes `Foo_Bar`; the exported file is `Foo Bar.md`. Without
    // this tier a Wikipedia import resolves almost nothing.
    let mut index = LinkIndex::new(UnresolvedLinks::PlainText);
    index.register(
        AliasTier::NormalizedTitle,
        &links::normalize_title("Foo Bar"),
        "note_x",
    );

    let (out, _) = rewrite("[[Foo_Bar]]", &mut index);

    assert_eq!(out, "[Foo_Bar](mindstream://note/note_x)");
}

#[test]
fn a_stronger_tier_displaces_a_weaker_claim() {
    let mut index = LinkIndex::new(UnresolvedLinks::PlainText);
    index.register(AliasTier::Title, "shared", "note_weak");
    index.register(AliasTier::FullPath, "shared", "note_strong");
    // …and a later weak claim must not take it back.
    index.register(AliasTier::Title, "shared", "note_other");

    assert_eq!(index.resolve("shared"), Some("note_strong"));
}

#[test]
fn rebase_resolves_dot_segments_and_refuses_to_escape_the_root() {
    assert_eq!(
        links::rebase("Guides", "../Home.md"),
        Some("Home.md".to_string())
    );
    assert_eq!(links::rebase("a/b", "./c.md"), Some("a/b/c.md".to_string()));
    assert_eq!(links::rebase("", "../outside.md"), None);
}

// ---------- frontmatter and metadata ----------

#[test]
fn frontmatter_supplies_title_tags_and_timestamps() {
    let vault = TempVault::new();
    vault.write(
        "page.md",
        "---\ntitle: Real Title\ntags:\n  - alpha\n  - beta\ncreated: 2024-03-04\n---\nBody text\n",
    );
    let db = open_memory_for_tests();

    import(&db, options(&vault));

    let (created, body) = db
        .with_conn(|c| {
            Ok(c.query_row(
                "SELECT created, body FROM notes WHERE title = 'Real Title'",
                [],
                |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
            )?)
        })
        .unwrap();
    assert!(created.starts_with("2024-03-04"), "created was {created}");
    assert_eq!(body, "Body text\n");

    let tags: Vec<String> = db
        .with_conn(|c| {
            let mut stmt = c.prepare("SELECT tag FROM note_tags ORDER BY tag")?;
            let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
            Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
        })
        .unwrap();
    assert_eq!(tags, vec!["alpha".to_string(), "beta".to_string()]);
}

#[test]
fn a_leading_heading_supplies_the_title_when_frontmatter_has_none() {
    let vault = TempVault::new();
    vault.write("slugified-name.md", "# The Real Page Title\n\nbody");
    let db = open_memory_for_tests();

    import(&db, options(&vault));

    assert!(!note_id_of(&db, "The Real Page Title").is_empty());
}

#[test]
fn a_horizontal_rule_on_line_one_is_not_frontmatter() {
    let (frontmatter, body) = markdown::split_frontmatter("---\nJust a rule\n\nmore");
    assert_eq!(frontmatter, markdown::Frontmatter::default());
    assert_eq!(body, "---\nJust a rule\n\nmore");
}

#[test]
fn tags_accept_a_sequence_or_a_comma_separated_string() {
    let (list, _) = markdown::split_frontmatter("---\ntags:\n  - a\n  - b\n---\n");
    assert_eq!(list.tags, vec!["a".to_string(), "b".to_string()]);

    let (inline, _) = markdown::split_frontmatter("---\ntags: a, b\n---\n");
    assert_eq!(inline.tags, vec!["a".to_string(), "b".to_string()]);
}

#[test]
fn inline_tags_skip_headings_code_and_issue_numbers() {
    let tags = markdown::extract_inline_tags(
        "# Heading\n#real-tag here\n`#not-a-tag`\n```\n#fenced\n```\nsee #42 and https://x/y#frag\n",
    );
    assert_eq!(tags, vec!["real-tag".to_string()]);
}

// ---------- structure ----------

#[test]
fn folders_mirror_the_directory_tree() {
    let vault = TempVault::new();
    vault
        .write("Work/Projects/plan.md", "plan")
        .write("Personal/diary.md", "diary");
    let db = open_memory_for_tests();

    let report = import(&db, options(&vault));

    assert_eq!(report.folders_created, 3);
    let parent_name: String = db
        .with_conn(|c| {
            Ok(c.query_row(
                "SELECT p.name FROM notes n
                 JOIN collections p ON p.id = n.parent_collection_id
                 WHERE n.title = 'plan'",
                [],
                |r| r.get(0),
            )?)
        })
        .unwrap();
    assert_eq!(parent_name, "Projects");
}

#[test]
fn everything_lands_under_a_new_destination_folder() {
    let vault = TempVault::new();
    vault.write("a.md", "a").write("Sub/b.md", "b");
    let db = open_memory_for_tests();

    let mut opts = options(&vault);
    opts.create_folder_named = Some("My Vault".into());
    import(&db, opts);

    let destination: String = db
        .with_conn(|c| {
            Ok(c.query_row(
                "SELECT id FROM collections WHERE name = 'My Vault'",
                [],
                |r| r.get(0),
            )?)
        })
        .unwrap();
    // The root-level note and the root-level folder both hang off it.
    let children: i64 = db
        .with_conn(|c| {
            Ok(c.query_row(
                "SELECT (SELECT COUNT(*) FROM notes WHERE parent_collection_id = ?1)
                      + (SELECT COUNT(*) FROM collections WHERE parent_collection_id = ?1)",
                params![destination],
                |r| r.get(0),
            )?)
        })
        .unwrap();
    assert_eq!(children, 2);
}

#[test]
fn hidden_directories_are_not_imported() {
    let vault = TempVault::new();
    vault
        .write("real.md", "real")
        .write(".obsidian/plugins/readme.md", "config")
        .write(".git/notes.md", "internal");
    let db = open_memory_for_tests();

    let report = import(&db, options(&vault));

    assert_eq!(report.notes_created, 1);
    assert_eq!(report.folders_created, 0);
}

// ---------- attachments ----------

#[test]
fn attachments_are_imported_and_deduplicated() {
    let vault = TempVault::new();
    let png = b"\x89PNG\r\n\x1a\n-fixture";
    vault
        .write_bytes("images/logo.png", png)
        .write_bytes("images/copy.png", png)
        .write("One.md", "![logo](images/logo.png)")
        .write("Two.md", "![same bytes](images/copy.png)");
    let db = open_memory_for_tests();

    let report = import(&db, options(&vault));

    assert_eq!(report.attachments_imported, 1, "one blob written");
    assert_eq!(report.attachments_deduplicated, 1, "the twin reused it");

    let rows: i64 = db
        .with_conn(|c| Ok(c.query_row("SELECT COUNT(*) FROM assets", [], |r| r.get(0))?))
        .unwrap();
    assert_eq!(rows, 1);
    let refs: i64 = db
        .with_conn(|c| Ok(c.query_row("SELECT COUNT(*) FROM asset_refs", [], |r| r.get(0))?))
        .unwrap();
    assert_eq!(refs, 2, "both notes reference the single blob");

    for title in ["One", "Two"] {
        assert!(
            body_of(&db, title).contains("asset:mindstream/asset_"),
            "{title} body should point at the stored asset"
        );
    }
}

#[test]
fn attachments_over_the_size_cap_are_skipped() {
    let vault = TempVault::new();
    vault
        .write_bytes("big.png", &vec![0u8; 4096])
        .write("Note.md", "![big](big.png)");
    let db = open_memory_for_tests();

    let mut opts = options(&vault);
    opts.max_attachment_bytes = 1024;
    let report = import(&db, opts);

    assert_eq!(report.attachments_too_large, 1);
    assert_eq!(report.attachments_imported, 0);
    // The link is left inert rather than pointing at an asset that isn't there.
    assert_eq!(body_of(&db, "Note"), "![big](big.png)");
}

#[test]
fn attachments_can_be_turned_off() {
    let vault = TempVault::new();
    vault
        .write_bytes("pic.png", b"bytes")
        .write("Note.md", "![pic](pic.png)");
    let db = open_memory_for_tests();

    let mut opts = options(&vault);
    opts.import_attachments = false;
    let report = import(&db, opts);

    assert_eq!(report.attachments_imported, 0);
    let rows: i64 = db
        .with_conn(|c| Ok(c.query_row("SELECT COUNT(*) FROM assets", [], |r| r.get(0))?))
        .unwrap();
    assert_eq!(rows, 0);
}

#[test]
fn a_link_to_a_missing_file_is_not_treated_as_an_attachment() {
    let vault = TempVault::new();
    vault.write("Note.md", "![gone](images/missing.png)");
    let db = open_memory_for_tests();

    let report = import(&db, options(&vault));

    assert_eq!(report.attachments_imported, 0);
    assert_eq!(body_of(&db, "Note"), "![gone](images/missing.png)");
}

// ---------- control flow ----------

#[test]
fn cancelling_keeps_everything_already_committed() {
    let vault = TempVault::new();
    for i in 0..5 {
        vault.write(&format!("note{i}.md"), "body");
    }
    let db = open_memory_for_tests();

    // Pre-cancelled: the run indexes, creates folders, then stops before the
    // first note. Nothing is rolled back, and the report says so.
    let cancelled = AtomicBool::new(true);
    let report = run_import(&db, options(&vault), &cancelled, |_| {}).expect("import");

    assert!(report.cancelled);
    assert_eq!(report.notes_created, 0);
}

#[test]
fn a_run_reports_progress_for_its_phases() {
    let vault = TempVault::new();
    vault.write("a.md", "a");
    let db = open_memory_for_tests();

    let mut phases = Vec::new();
    let cancelled = AtomicBool::new(false);
    run_import(&db, options(&vault), &cancelled, |progress| {
        phases.push(progress.phase)
    })
    .expect("import");

    assert_eq!(phases.first(), Some(&"scanning"));
    assert_eq!(phases.last(), Some(&"done"));
}

#[test]
fn detect_refuses_a_path_that_is_not_a_directory() {
    let vault = TempVault::new();
    vault.write("lonely.md", "x");
    let file = vault.path().join("lonely.md");

    let err = super::detect::detect(&file).unwrap_err();

    assert!(matches!(err, AppError::InvalidArg(_)), "got {err:?}");
}

// ---------- Obsidian ----------

#[test]
fn an_obsidian_vault_is_detected_by_its_config_directory() {
    let vault = TempVault::new();
    vault.write("note.md", "x");
    assert_eq!(
        super::detect::detect(vault.path()).unwrap().kind,
        ImportSourceKind::Gfm
    );

    as_obsidian_vault(&vault);
    assert_eq!(
        super::detect::detect(vault.path()).unwrap().kind,
        ImportSourceKind::Obsidian
    );
}

#[test]
fn obsidian_wikilinks_resolve_by_bare_name_across_folders() {
    // Obsidian's shortest-path linking: `[[Deep note]]` finds the file
    // wherever it lives, which is why the basename tier exists.
    let vault = TempVault::new();
    as_obsidian_vault(&vault);
    vault
        .write("Hub.md", "Go to [[Deep note]] now.")
        .write("Archive/Nested/Deep note.md", "arrived");
    let db = open_memory_for_tests();

    let report = import(&db, obsidian_options(&vault));

    assert_eq!(report.links_resolved, 1);
    let target = note_id_of(&db, "Deep note");
    assert_eq!(
        body_of(&db, "Hub"),
        format!("Go to [Deep note](mindstream://note/{target}) now.")
    );
}

#[test]
fn obsidian_mutual_wikilinks_resolve_both_ways() {
    let vault = TempVault::new();
    as_obsidian_vault(&vault);
    vault
        .write("Alpha.md", "[[Beta]]")
        .write("Beta.md", "[[Alpha]]");
    let db = open_memory_for_tests();

    import(&db, obsidian_options(&vault));

    let alpha = note_id_of(&db, "Alpha");
    let beta = note_id_of(&db, "Beta");
    assert_eq!(
        body_of(&db, "Alpha"),
        format!("[Beta](mindstream://note/{beta})")
    );
    assert_eq!(
        body_of(&db, "Beta"),
        format!("[Alpha](mindstream://note/{alpha})")
    );
}

#[test]
fn an_obsidian_alias_resolves_to_its_note() {
    let vault = TempVault::new();
    as_obsidian_vault(&vault);
    vault
        .write("Canonical.md", "---\naliases:\n  - Nickname\n---\nthe note")
        .write("Ref.md", "see [[Nickname]]");
    let db = open_memory_for_tests();

    import(&db, obsidian_options(&vault));

    let target = note_id_of(&db, "Canonical");
    assert_eq!(
        body_of(&db, "Ref"),
        format!("see [Nickname](mindstream://note/{target})")
    );
}

#[test]
fn an_obsidian_image_embed_becomes_an_asset_reference() {
    // `![[diagram.png]]` addresses the file by bare name, from anywhere in the
    // vault, and must not go through the wikilink pass — that would turn an
    // image into a note link.
    let vault = TempVault::new();
    as_obsidian_vault(&vault);
    vault
        .write_bytes("Files/attachments/diagram.png", b"\x89PNG\r\n\x1a\nfixture")
        .write("Note.md", "Look: ![[diagram.png]]");
    let db = open_memory_for_tests();

    let report = import(&db, obsidian_options(&vault));

    assert_eq!(report.attachments_imported, 1);
    let body = body_of(&db, "Note");
    assert!(
        body.starts_with("Look: ![diagram.png](asset:mindstream/asset_"),
        "got {body}"
    );
}

#[test]
fn an_obsidian_embed_width_is_not_mistaken_for_an_alias() {
    let vault = TempVault::new();
    as_obsidian_vault(&vault);
    vault
        .write_bytes("pic.png", b"bytes")
        .write("Note.md", "![[pic.png|300]]");
    let db = open_memory_for_tests();

    let report = import(&db, obsidian_options(&vault));

    assert_eq!(report.attachments_imported, 1);
    assert!(body_of(&db, "Note").starts_with("![pic.png](asset:mindstream/"));
}

#[test]
fn an_obsidian_note_embed_degrades_to_a_link() {
    let vault = TempVault::new();
    as_obsidian_vault(&vault);
    vault
        .write("Host.md", "![[Embedded]]")
        .write("Embedded.md", "content");
    let db = open_memory_for_tests();

    import(&db, obsidian_options(&vault));

    let target = note_id_of(&db, "Embedded");
    assert_eq!(
        body_of(&db, "Host"),
        format!("[Embedded](mindstream://note/{target})")
    );
}

#[test]
fn obsidian_inline_tags_land_on_the_note() {
    let vault = TempVault::new();
    as_obsidian_vault(&vault);
    vault.write(
        "Tagged.md",
        "---\ntags: [front]\n---\nBody with #inline and #nested/tag\n",
    );
    let db = open_memory_for_tests();

    import(&db, obsidian_options(&vault));

    let tags: Vec<String> = db
        .with_conn(|c| {
            let mut stmt = c.prepare("SELECT tag FROM note_tags ORDER BY tag")?;
            let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
            Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
        })
        .unwrap();
    assert_eq!(
        tags,
        vec![
            "front".to_string(),
            "inline".to_string(),
            "nested/tag".to_string()
        ]
    );
}

#[test]
fn gfm_leaves_double_brackets_alone() {
    // `[[1]]` in a plain markdown folder is a citation marker, not a link.
    let vault = TempVault::new();
    vault
        .write("Paper.md", "As shown in [[1]] and [[Other]].")
        .write("Other.md", "x");
    let db = open_memory_for_tests();

    let report = import(&db, options(&vault));

    assert_eq!(report.links_resolved, 0);
    assert_eq!(body_of(&db, "Paper"), "As shown in [[1]] and [[Other]].");
}

// ---------- Joplin ----------

/// Build a Joplin RAW item file: title, body, then the trailing metadata
/// block that identifies the format.
fn joplin_item(title: &str, body: &str, fields: &[(&str, &str)]) -> String {
    let meta: String = fields
        .iter()
        .map(|(key, value)| format!("{key}: {value}\n"))
        .collect();
    format!("{title}\n\n{body}\n\n{meta}")
}

const NOTE_A: &str = "0a1b2c3d4e5f60718293a4b5c6d7e8f9";
const NOTE_B: &str = "1b2c3d4e5f60718293a4b5c6d7e8f9a0";
const FOLDER_A: &str = "2c3d4e5f60718293a4b5c6d7e8f9a0b1";
const RESOURCE_A: &str = "3d4e5f60718293a4b5c6d7e8f9a0b1c2";

fn joplin_options(vault: &TempVault) -> ImportOptions {
    ImportOptions {
        kind: Some(ImportSourceKind::JoplinRaw),
        ..options(vault)
    }
}

fn write_joplin_pair(vault: &TempVault) {
    vault
        .write(
            &format!("{FOLDER_A}.md"),
            &joplin_item("Work", "", &[("id", FOLDER_A), ("type_", "2")]),
        )
        .write(
            &format!("{NOTE_A}.md"),
            &joplin_item(
                "First note",
                &format!("Points at [Second note](:/{NOTE_B})."),
                &[
                    ("id", NOTE_A),
                    ("parent_id", FOLDER_A),
                    ("created_time", "2024-01-01T10:00:00.000Z"),
                    ("updated_time", "2024-02-02T11:00:00.000Z"),
                    ("type_", "1"),
                ],
            ),
        )
        .write(
            &format!("{NOTE_B}.md"),
            &joplin_item(
                "Second note",
                &format!("Back to [First note](:/{NOTE_A})."),
                &[("id", NOTE_B), ("parent_id", FOLDER_A), ("type_", "1")],
            ),
        );
}

#[test]
fn a_joplin_raw_export_is_detected_by_its_metadata_block() {
    let vault = TempVault::new();
    write_joplin_pair(&vault);

    assert_eq!(
        super::detect::detect(vault.path()).unwrap().kind,
        ImportSourceKind::JoplinRaw
    );
}

#[test]
fn joplin_id_links_resolve_in_both_directions() {
    // The reason the RAW export is the Joplin format worth parsing: links are
    // `:/id`, so resolution is exact rather than a title match.
    let vault = TempVault::new();
    write_joplin_pair(&vault);
    let db = open_memory_for_tests();

    let report = import(&db, joplin_options(&vault));

    assert_eq!(report.notes_created, 2);
    assert_eq!(report.folders_created, 1);
    assert_eq!(report.links_resolved, 2);

    let first = note_id_of(&db, "First note");
    let second = note_id_of(&db, "Second note");
    assert_eq!(
        body_of(&db, "First note"),
        format!("Points at [Second note](mindstream://note/{second}).")
    );
    assert_eq!(
        body_of(&db, "Second note"),
        format!("Back to [First note](mindstream://note/{first}).")
    );
}

#[test]
fn joplin_notes_land_in_their_folder_with_their_timestamps() {
    let vault = TempVault::new();
    write_joplin_pair(&vault);
    let db = open_memory_for_tests();

    import(&db, joplin_options(&vault));

    let (folder, created) = db
        .with_conn(|c| {
            Ok(c.query_row(
                "SELECT p.name, n.created FROM notes n
                 JOIN collections p ON p.id = n.parent_collection_id
                 WHERE n.title = 'First note'",
                [],
                |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
            )?)
        })
        .unwrap();
    assert_eq!(folder, "Work");
    assert!(created.starts_with("2024-01-01"), "created was {created}");
}

#[test]
fn a_joplin_resource_becomes_an_attachment() {
    let vault = TempVault::new();
    vault
        .write(
            &format!("{RESOURCE_A}.md"),
            &joplin_item(
                "diagram.png",
                "",
                &[
                    ("id", RESOURCE_A),
                    ("mime", "image/png"),
                    ("file_extension", "png"),
                    ("type_", "4"),
                ],
            ),
        )
        .write_bytes(
            "resources/3d4e5f60718293a4b5c6d7e8f9a0b1c2.png",
            b"PNGBYTES",
        )
        .write(
            &format!("{NOTE_A}.md"),
            &joplin_item(
                "Illustrated",
                &format!("![diagram](:/{RESOURCE_A})"),
                &[("id", NOTE_A), ("type_", "1")],
            ),
        );
    let db = open_memory_for_tests();

    let report = import(&db, joplin_options(&vault));

    assert_eq!(report.attachments_imported, 1);
    let body = body_of(&db, "Illustrated");
    assert!(
        body.starts_with("![diagram](asset:mindstream/asset_"),
        "got {body}"
    );
    let mime: String = db
        .with_conn(|c| Ok(c.query_row("SELECT mime_type FROM assets", [], |r| r.get(0))?))
        .unwrap();
    assert_eq!(mime, "image/png");
}

#[test]
fn a_joplin_body_containing_colon_lines_keeps_them() {
    // The metadata block is the trailing run of `key: value` lines. A body
    // that happens to contain one must not be swallowed into it.
    let vault = TempVault::new();
    vault.write(
        &format!("{NOTE_A}.md"),
        &joplin_item(
            "Recipe",
            "ingredients: flour\n\nMix well.",
            &[("id", NOTE_A), ("type_", "1")],
        ),
    );
    let db = open_memory_for_tests();

    import(&db, joplin_options(&vault));

    assert_eq!(body_of(&db, "Recipe"), "ingredients: flour\n\nMix well.");
}

#[test]
fn joplin_tags_reach_their_notes() {
    let vault = TempVault::new();
    let tag_id = "4e5f60718293a4b5c6d7e8f9a0b1c2d3";
    let join_id = "5f60718293a4b5c6d7e8f9a0b1c2d3e4";
    vault
        .write(
            &format!("{NOTE_A}.md"),
            &joplin_item("Tagged", "body", &[("id", NOTE_A), ("type_", "1")]),
        )
        .write(
            &format!("{tag_id}.md"),
            &joplin_item("important", "", &[("id", tag_id), ("type_", "5")]),
        )
        .write(
            &format!("{join_id}.md"),
            &joplin_item(
                "",
                "",
                &[
                    ("id", join_id),
                    ("note_id", NOTE_A),
                    ("tag_id", tag_id),
                    ("type_", "6"),
                ],
            ),
        );
    let db = open_memory_for_tests();

    import(&db, joplin_options(&vault));

    let tags: Vec<String> = db
        .with_conn(|c| {
            let mut stmt = c.prepare("SELECT tag FROM note_tags")?;
            let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
            Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
        })
        .unwrap();
    assert_eq!(tags, vec!["important".to_string()]);
}

#[test]
fn a_jex_archive_imports_like_the_raw_directory_it_wraps() {
    // A .jex is a tar of the RAW layout, which is why one parser serves both.
    let source = TempVault::new();
    write_joplin_pair(&source);

    let holder = TempVault::new();
    let archive_path = holder.path().join("export.jex");
    {
        let file = fs::File::create(&archive_path).expect("create archive");
        let mut builder = tar::Builder::new(file);
        builder
            .append_dir_all(".", source.path())
            .expect("append vault");
        builder.finish().expect("finish archive");
    }

    let detected = super::detect::detect(&archive_path).unwrap();
    assert_eq!(detected.kind, ImportSourceKind::JoplinJex);
    assert_eq!(detected.suggested_name, "export");

    let db = open_memory_for_tests();
    let report = import(
        &db,
        ImportOptions {
            source_path: archive_path.to_string_lossy().to_string(),
            kind: Some(ImportSourceKind::JoplinJex),
            ..options(&source)
        },
    );

    assert_eq!(report.notes_created, 2);
    assert_eq!(report.links_resolved, 2);
}

#[test]
fn a_joplin_markdown_export_is_detected_by_its_resources_folder() {
    let vault = TempVault::new();
    vault
        .write("Note.md", "---\ntitle: Note\n---\nbody")
        .write_bytes("_resources/pic.png", b"bytes");

    assert_eq!(
        super::detect::detect(vault.path()).unwrap().kind,
        ImportSourceKind::JoplinMarkdown
    );
}

#[test]
fn a_joplin_markdown_export_resolves_relative_note_links() {
    let vault = TempVault::new();
    vault
        .write_bytes("_resources/pic.png", b"bytes")
        .write(
            "Work/Plan.md",
            "---\ntitle: Plan\n---\nSee [Notes](../Notes.md) and ![pic](../_resources/pic.png)",
        )
        .write("Notes.md", "---\ntitle: Notes\n---\nreference");
    let db = open_memory_for_tests();

    let report = import(
        &db,
        ImportOptions {
            kind: Some(ImportSourceKind::JoplinMarkdown),
            ..options(&vault)
        },
    );

    assert_eq!(report.links_resolved, 1);
    assert_eq!(report.attachments_imported, 1);
    let target = note_id_of(&db, "Notes");
    let body = body_of(&db, "Plan");
    assert!(
        body.contains(&format!("[Notes](mindstream://note/{target})")),
        "{body}"
    );
    assert!(body.contains("![pic](asset:mindstream/asset_"), "{body}");
}

#[test]
fn a_jex_entry_cannot_escape_the_staging_directory() {
    // Archives are user-supplied files; an entry naming ../ must be refused
    // rather than written outside the temp dir.
    let holder = TempVault::new();
    let archive_path = holder.path().join("evil.jex");
    {
        let file = fs::File::create(&archive_path).expect("create archive");
        let mut builder = tar::Builder::new(file);
        let payload = b"pwned";
        let mut header = tar::Header::new_gnu();
        // set_path refuses `..`, which is exactly the entry a hostile archive
        // would carry — so write the name straight into the header instead.
        // Nothing stops a real attacker from doing the same.
        let name = b"../escaped.txt";
        let gnu = header.as_gnu_mut().expect("gnu header");
        gnu.name[..name.len()].copy_from_slice(name);
        header.set_size(payload.len() as u64);
        header.set_mode(0o644);
        header.set_cksum();
        builder.append(&header, &payload[..]).expect("append");
        builder.finish().expect("finish");
    }

    let staged = super::stage::extract_tar(&archive_path).expect("extract");

    assert!(
        !holder.path().join("escaped.txt").exists(),
        "traversal entry must not be written"
    );
    assert!(!staged.path().join("escaped.txt").exists());
}

// ---------- Evernote ----------

/// Base64 of the eight-byte PNG signature, and the MD5 Evernote would address
/// it by. Computed rather than hard-coded so the fixture can't drift.
fn png_resource() -> (String, String) {
    use base64::Engine as _;
    let bytes: [u8; 8] = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
    let b64 = base64::engine::general_purpose::STANDARD.encode(bytes);
    let digest = <md5::Md5 as md5::Digest>::digest(bytes);
    let hash = digest
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<String>();
    (b64, hash)
}

fn enex(notes: &str) -> String {
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n\
         <!DOCTYPE en-export SYSTEM \"http://xml.evernote.com/pub/evernote-export4.dtd\">\n\
         <en-export export-date=\"20240101T000000Z\" application=\"Evernote\" version=\"10.0\">\n\
         {notes}</en-export>\n"
    )
}

fn enex_note(title: &str, enml: &str, extra: &str) -> String {
    format!(
        "<note><title>{title}</title>\n\
         <content><![CDATA[<?xml version=\"1.0\" encoding=\"UTF-8\"?>\
         <!DOCTYPE en-note SYSTEM \"http://xml.evernote.com/pub/enml2.dtd\">\
         <en-note>{enml}</en-note>]]></content>\n\
         <created>20240102T101500Z</created><updated>20240305T091000Z</updated>\n\
         {extra}</note>\n"
    )
}

fn enex_options(vault: &TempVault, file: &str) -> ImportOptions {
    ImportOptions {
        source_path: vault.path().join(file).to_string_lossy().to_string(),
        kind: Some(ImportSourceKind::Evernote),
        ..options(vault)
    }
}

#[test]
fn an_enex_file_is_detected_by_its_extension() {
    let vault = TempVault::new();
    vault.write("export.enex", &enex(&enex_note("A", "<div>hi</div>", "")));

    let detected = super::detect::detect(&vault.path().join("export.enex")).unwrap();

    assert_eq!(detected.kind, ImportSourceKind::Evernote);
    assert_eq!(detected.suggested_name, "export");
}

#[test]
fn enml_becomes_markdown_with_tags_and_timestamps() {
    let vault = TempVault::new();
    vault.write(
        "export.enex",
        &enex(&enex_note(
            "Meeting notes",
            "<div>Discussed <b>the plan</b>.</div><ul><li>First</li><li>Second</li></ul>",
            "<tag>work</tag><tag>2024</tag>",
        )),
    );
    let db = open_memory_for_tests();

    let report = import(&db, enex_options(&vault, "export.enex"));

    assert_eq!(report.notes_created, 1);
    let body = body_of(&db, "Meeting notes");
    assert!(body.contains("**the plan**"), "got {body}");
    assert!(body.contains("- First"), "got {body}");

    let (created, modified) = db
        .with_conn(|c| {
            Ok(c.query_row(
                "SELECT created, modified FROM notes WHERE title = 'Meeting notes'",
                [],
                |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
            )?)
        })
        .unwrap();
    assert!(created.starts_with("2024-01-02T10:15"), "created {created}");
    assert!(
        modified.starts_with("2024-03-05T09:10"),
        "modified {modified}"
    );

    let tags: Vec<String> = db
        .with_conn(|c| {
            let mut stmt = c.prepare("SELECT tag FROM note_tags ORDER BY tag")?;
            let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
            Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
        })
        .unwrap();
    assert_eq!(tags, vec!["2024".to_string(), "work".to_string()]);
}

#[test]
fn an_en_media_element_becomes_an_asset_reference() {
    // Evernote addresses a resource by the MD5 of its bytes; there is no id to
    // match on, so the importer has to hash every resource it decodes.
    let (b64, hash) = png_resource();
    let vault = TempVault::new();
    vault.write(
        "export.enex",
        &enex(&enex_note(
            "Illustrated",
            &format!(
                "<div>Before</div><en-media hash=\"{hash}\" type=\"image/png\"/><div>After</div>"
            ),
            &format!(
                "<resource><data encoding=\"base64\">{b64}</data><mime>image/png</mime>\
                 <resource-attributes><file-name>diagram.png</file-name></resource-attributes>\
                 </resource>"
            ),
        )),
    );
    let db = open_memory_for_tests();

    let report = import(&db, enex_options(&vault, "export.enex"));

    assert_eq!(report.attachments_imported, 1);
    let body = body_of(&db, "Illustrated");
    assert!(body.contains("(asset:mindstream/asset_"), "got {body}");
    // The surrounding text must survive: html5ever does not honour XML
    // self-closing on unknown elements, so an un-rewritten <en-media/> would
    // swallow everything after it.
    assert!(
        body.contains("Before") && body.contains("After"),
        "got {body}"
    );
}

#[test]
fn en_todo_elements_become_task_list_items() {
    let vault = TempVault::new();
    vault.write(
        "export.enex",
        &enex(&enex_note(
            "Checklist",
            "<div><en-todo checked=\"true\"/>Done thing</div>\
             <div><en-todo checked=\"false\"/>Pending thing</div>",
            "",
        )),
    );
    let db = open_memory_for_tests();

    import(&db, enex_options(&vault, "export.enex"));

    let body = body_of(&db, "Checklist");
    assert!(body.contains("- [x] Done thing"), "got {body}");
    assert!(body.contains("- [ ] Pending thing"), "got {body}");
}

#[test]
fn an_evernote_note_link_resolves_by_its_anchor_text() {
    // Most exports carry no <guid>, so the link's guid matches nothing and the
    // anchor text — which Evernote fills with the target's title — is all
    // there is to go on.
    let vault = TempVault::new();
    vault.write(
        "export.enex",
        &enex(&format!(
            "{}{}",
            enex_note(
                "Source",
                "<div>See <a href=\"evernote:///view/123/s1/abc-guid/abc-guid/\">Target note</a>.</div>",
                "",
            ),
            enex_note("Target note", "<div>arrived</div>", ""),
        )),
    );
    let db = open_memory_for_tests();

    let report = import(&db, enex_options(&vault, "export.enex"));

    assert_eq!(report.links_resolved, 1);
    let target = note_id_of(&db, "Target note");
    assert!(
        body_of(&db, "Source").contains(&format!("[Target note](mindstream://note/{target})")),
        "got {}",
        body_of(&db, "Source")
    );
}

#[test]
fn an_evernote_guid_resolves_exactly_when_the_export_carries_one() {
    let vault = TempVault::new();
    vault.write(
        "export.enex",
        &enex(&format!(
            "{}{}",
            enex_note(
                "Source",
                // Deliberately mismatched anchor text: only the guid can get
                // this right.
                "<div><a href=\"evernote:///view/123/s1/the-guid/the-guid/\">click here</a></div>",
                "",
            ),
            enex_note("Real target", "<div>arrived</div>", "<guid>the-guid</guid>"),
        )),
    );
    let db = open_memory_for_tests();

    import(&db, enex_options(&vault, "export.enex"));

    let target = note_id_of(&db, "Real target");
    assert!(
        body_of(&db, "Source").contains(&format!("[click here](mindstream://note/{target})")),
        "got {}",
        body_of(&db, "Source")
    );
}

#[test]
fn an_unresolvable_evernote_link_keeps_its_words_and_drops_the_dead_scheme() {
    let vault = TempVault::new();
    vault.write(
        "export.enex",
        &enex(&enex_note(
            "Orphan",
            "<div>See <a href=\"evernote:///view/1/s1/gone/gone/\">a missing note</a>.</div>",
            "",
        )),
    );
    let db = open_memory_for_tests();

    let report = import(&db, enex_options(&vault, "export.enex"));

    assert_eq!(report.links_unresolved, 1);
    let body = body_of(&db, "Orphan");
    assert!(body.contains("a missing note"), "got {body}");
    assert!(!body.contains("evernote:"), "dead scheme kept: {body}");
}

#[test]
fn several_enex_notes_are_addressed_independently() {
    // Notes are read back by byte range rather than held in memory, so the
    // ranges have to line up with the right note.
    let vault = TempVault::new();
    let notes: String = (0..5)
        .map(|i| enex_note(&format!("Note {i}"), &format!("<div>body {i}</div>"), ""))
        .collect();
    vault.write("export.enex", &enex(&notes));
    let db = open_memory_for_tests();

    let report = import(&db, enex_options(&vault, "export.enex"));

    assert_eq!(report.notes_created, 5);
    for i in 0..5 {
        assert_eq!(body_of(&db, &format!("Note {i}")), format!("body {i}"));
    }
}

#[test]
fn xml_entities_in_a_title_are_decoded() {
    let vault = TempVault::new();
    vault.write(
        "export.enex",
        &enex(&enex_note("Tom &amp; Jerry", "<div>x</div>", "")),
    );
    let db = open_memory_for_tests();

    import(&db, enex_options(&vault, "export.enex"));

    assert!(!note_id_of(&db, "Tom & Jerry").is_empty());
}
