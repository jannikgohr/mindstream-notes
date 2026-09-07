//! Markdown-on-disk sources: a plain GFM folder today, Obsidian and Joplin's
//! Markdown export layered on the same walker later.
//!
//! Everything these formats disagree about is a [`Flavour`] flag; the walking,
//! folder mapping, frontmatter handling and attachment resolution are shared,
//! because they are the same job in all three.
//!
//! This is also the source the big-vault performance test runs through:
//! `mediawiki-to-markdown` emits exactly this shape — one `.md` per page,
//! YAML frontmatter, relative links between pages.

use std::collections::HashMap;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

use walkdir::WalkDir;

use crate::error::{AppError, AppResult};
use crate::import::links::{self, RewriteOptions};
use crate::import::markdown::{self, Frontmatter};
use crate::import::mime;
use crate::import::model::{
    AliasTier, AttachmentRef, FolderIndex, ItemIndex, SourceIndex, StagedNote,
};
use crate::import::source::{ImportSource, LoadedItem};
use crate::notes::NoteKind;

/// Directories that are never note content. Dot-directories are skipped
/// wholesale on top of this, which covers `.obsidian`, `.trash` and `.git`.
const SKIPPED_DIRS: &[&str] = &["node_modules", "__MACOSX"];

/// How much of a file to read during phase 1 to recover its frontmatter.
///
/// Phase 1 is meant to be a body-free walk, and this is the one deliberate
/// exception: a note's real title and its `aliases:` are link targets, so
/// missing them means missing links. Capping the peek keeps it to one open and
/// one read per file — the tail of a 500 KB note is never touched, and the
/// second (full) read in phase 2 hits a warm page cache.
const FRONTMATTER_PEEK_BYTES: usize = 8 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Flavour {
    /// Plain markdown folder. Links are ordinary relative markdown links;
    /// `[[…]]` is not a link syntax here and must not be treated as one.
    Gfm,
    /// An Obsidian vault: `[[wikilinks]]`, `![[embeds]]`, inline `#tags`, and
    /// frontmatter `aliases:`. Obsidian resolves both links and attachments by
    /// *name* rather than by path, so a bare `![[diagram.png]]` finds the file
    /// wherever it lives in the vault.
    Obsidian,
    /// Joplin's "Markdown + Front Matter" export: a real folder tree, YAML
    /// frontmatter, resources under `_resources/`.
    ///
    /// Joplin rewrites resource links to relative paths on the way out, but
    /// whether it rewrites *note* links depends on the version — older exports
    /// leave `:/id` in place. Both forms are therefore enabled, and the `:/id`
    /// pass simply finds nothing when the export already resolved them.
    JoplinMarkdown,
}

pub struct MarkdownVaultSource {
    root: PathBuf,
    flavour: Flavour,
    /// Root-relative directory path → minted collection id, so phase 2 can
    /// place a note without re-walking.
    folder_ids: HashMap<String, String>,
    /// Lowercased file name → root-relative path, for every non-markdown file
    /// in the vault.
    ///
    /// Obsidian addresses attachments by bare name (`![[diagram.png]]`) no
    /// matter which folder they sit in, so resolving one means knowing every
    /// file's name up front. Built during the index walk, which is already
    /// visiting all of them.
    attachments_by_name: HashMap<String, String>,
}

impl MarkdownVaultSource {
    pub fn new(root: PathBuf, flavour: Flavour) -> Self {
        Self {
            root,
            flavour,
            folder_ids: HashMap::new(),
            attachments_by_name: HashMap::new(),
        }
    }

    fn absolute(&self, relative: &str) -> PathBuf {
        let mut path = self.root.clone();
        for segment in relative.split('/').filter(|s| !s.is_empty()) {
            path.push(segment);
        }
        path
    }
}

impl ImportSource for MarkdownVaultSource {
    fn index(&mut self) -> AppResult<SourceIndex> {
        let mut out = SourceIndex::default();
        // Sorted so a run is reproducible and so parents are always emitted
        // before their children, which the folder insert relies on.
        let walker = WalkDir::new(&self.root)
            .follow_links(false)
            .sort_by_file_name()
            .into_iter()
            .filter_entry(|entry| !is_skipped_dir(entry.file_name().to_string_lossy().as_ref()));

        for entry in walker {
            let entry = match entry {
                Ok(entry) => entry,
                // A single unreadable path shouldn't abort a vault-sized walk.
                Err(err) => {
                    log::warn!("[import] skipping unreadable path: {err}");
                    continue;
                }
            };
            let Some(relative) = relative_path(&self.root, entry.path()) else {
                continue;
            };
            if relative.is_empty() {
                continue;
            }

            if entry.file_type().is_dir() {
                let id = format!("col_{}", uuid::Uuid::new_v4());
                let parent = parent_dir(&relative)
                    .and_then(|p| self.folder_ids.get(p))
                    .cloned();
                self.folder_ids.insert(relative.clone(), id.clone());
                out.folders.push(FolderIndex {
                    id,
                    parent_id: parent,
                    name: entry.file_name().to_string_lossy().to_string(),
                });
                continue;
            }

            if !entry.file_type().is_file() {
                continue;
            }
            if !mime::is_markdown(&relative) {
                // First one wins, so a deterministic sorted walk makes the
                // choice between same-named files stable across runs.
                self.attachments_by_name
                    .entry(file_name(&relative).to_lowercase())
                    .or_insert_with(|| relative.clone());
                continue;
            }
            out.items.push(self.index_note(&relative));
        }
        Ok(out)
    }

    fn load(&mut self, item: &ItemIndex) -> AppResult<LoadedItem> {
        let path = self.absolute(&item.locator);
        let raw = read_text(&path)?;
        let (frontmatter, body) = markdown::split_frontmatter(&raw);
        let stem = file_stem(&item.locator);

        let title = frontmatter
            .title
            .clone()
            .unwrap_or_else(|| markdown::infer_title(body, &stem));

        // Rewrite `![[file.png]]` into ordinary image syntax BEFORE anything
        // else looks at the body: left alone, the wikilink pass would turn an
        // embedded image into a note link.
        let body = match self.flavour {
            Flavour::Obsidian => self.expand_embeds(&item.locator, body),
            Flavour::Gfm | Flavour::JoplinMarkdown => body.to_string(),
        };

        let mut tags = frontmatter.tags.clone();
        if self.flavour == Flavour::Obsidian {
            for tag in markdown::extract_inline_tags(&body) {
                if !tags.contains(&tag) {
                    tags.push(tag);
                }
            }
        }

        let attachments = self.collect_attachments(&item.locator, &body);

        let fs_modified = fs::metadata(&path)
            .ok()
            .and_then(|meta| meta.modified().ok())
            .map(|time| chrono::DateTime::<chrono::Utc>::from(time).to_rfc3339());

        Ok(LoadedItem {
            note: StagedNote {
                note_id: item.note_id.clone(),
                title,
                folder_id: item.folder_id.clone(),
                body: body.trim_start_matches(['\n', '\r']).to_string(),
                tags,
                created: normalize_timestamp(frontmatter.created.as_deref()),
                modified: normalize_timestamp(frontmatter.modified.as_deref()).or(fs_modified),
                note_kind: NoteKind::Markdown,
            },
            attachments,
        })
    }

    fn attachment_bytes(&mut self, reference: &AttachmentRef) -> AppResult<Option<Vec<u8>>> {
        let path = self.absolute(&reference.locator);
        match fs::read(&path) {
            Ok(bytes) => Ok(Some(bytes)),
            // Vanished between the index walk and now, or a permission
            // problem. One missing image is not a failed import.
            Err(err) => {
                log::warn!(
                    "[import] attachment {} unreadable: {err}",
                    reference.locator
                );
                Ok(None)
            }
        }
    }

    fn rewrite_options(&self) -> RewriteOptions {
        match self.flavour {
            // `[[…]]` in plain GFM is far more likely to be a citation marker
            // than a link, so the wikilink pass stays off.
            Flavour::Gfm => RewriteOptions {
                wikilinks: false,
                markdown_links: true,
                id_links: false,
                evernote_links: false,
            },
            Flavour::Obsidian => RewriteOptions {
                wikilinks: true,
                markdown_links: true,
                id_links: false,
                evernote_links: false,
            },
            Flavour::JoplinMarkdown => RewriteOptions {
                wikilinks: false,
                markdown_links: true,
                id_links: true,
                evernote_links: false,
            },
        }
    }
}

impl MarkdownVaultSource {
    fn index_note(&self, relative: &str) -> ItemIndex {
        let stem = file_stem(relative);
        let frontmatter = peek_frontmatter(&self.absolute(relative));
        let title = frontmatter
            .title
            .clone()
            .filter(|t| !t.trim().is_empty())
            .unwrap_or_else(|| stem.clone());

        let mut aliases = vec![
            (AliasTier::FullPath, relative.to_string()),
            (AliasTier::FullPath, strip_extension(relative)),
            (AliasTier::Basename, file_name(relative)),
            (AliasTier::Basename, stem.clone()),
            (AliasTier::Title, title.clone()),
            (AliasTier::NormalizedTitle, links::normalize_title(&title)),
            // The file stem matters even when frontmatter renamed the note:
            // links in the vault were written against the file name.
            (AliasTier::NormalizedTitle, links::normalize_title(&stem)),
        ];
        for alias in &frontmatter.aliases {
            aliases.push((AliasTier::Title, alias.clone()));
            aliases.push((AliasTier::NormalizedTitle, links::normalize_title(alias)));
        }

        ItemIndex {
            note_id: format!("note_{}", uuid::Uuid::new_v4()),
            title,
            folder_id: parent_dir(relative).and_then(|p| self.folder_ids.get(p).cloned()),
            locator: relative.to_string(),
            aliases,
        }
    }

    /// Turn `![[file.png]]` into `![file.png](file.png)` so the rest of the
    /// pipeline sees ordinary markdown.
    ///
    /// Only embeds that resolve to a real *file* are converted. An embed of
    /// another note (`![[Some note]]`) is left for the wikilink pass, which
    /// degrades it to a plain link — Mindstream has no transclusion, and a
    /// link to the same note is the closest thing that still works.
    ///
    /// Obsidian allows a display option after a pipe (`![[img.png|300]]`),
    /// which is a width, not an alias.
    fn expand_embeds(&self, note_relative: &str, body: &str) -> String {
        let base_dir = parent_dir(note_relative).unwrap_or("");
        let mut out = String::with_capacity(body.len());
        let mut rest = body;
        while let Some(at) = rest.find("![[") {
            out.push_str(&rest[..at]);
            let after = &rest[at + 3..];
            let Some(close) = after.find("]]") else {
                out.push_str(&rest[at..]);
                return out;
            };
            let inner = &after[..close];
            let target = inner.split('|').next().unwrap_or(inner).trim();
            match self.resolve_embed(base_dir, target) {
                Some(path) => out.push_str(&format!("![{target}]({path})")),
                None => out.push_str(&rest[at..at + 3 + close + 2]),
            }
            rest = &after[close + 2..];
        }
        out.push_str(rest);
        out
    }

    fn resolve_embed(&self, base_dir: &str, target: &str) -> Option<String> {
        if target.is_empty() || mime::is_markdown(target) {
            return None;
        }
        let decoded = links::percent_decode(target);
        [
            links::rebase(base_dir, &decoded),
            links::rebase("", &decoded),
        ]
        .into_iter()
        .flatten()
        .find(|candidate| self.absolute(candidate).is_file())
        .or_else(|| self.attachment_by_name(&decoded))
    }

    /// Obsidian's name-based attachment lookup. Returns `None` for every other
    /// flavour, which keeps GFM's path resolution strict.
    fn attachment_by_name(&self, target: &str) -> Option<String> {
        if self.flavour != Flavour::Obsidian {
            return None;
        }
        self.attachments_by_name
            .get(&file_name(target).to_lowercase())
            .cloned()
    }

    /// Find every link in the body that points at a real non-markdown file
    /// inside the vault.
    ///
    /// Links to files we can't find are left alone rather than guessed at —
    /// an external URL and a broken relative path both end up untouched,
    /// which is the honest rendering of each.
    fn collect_attachments(&self, note_relative: &str, body: &str) -> Vec<AttachmentRef> {
        let base_dir = parent_dir(note_relative).unwrap_or("");
        let mut seen: Vec<AttachmentRef> = Vec::new();
        for raw_target in links::inline_link_targets(body) {
            if seen.iter().any(|a| a.placeholder == raw_target) {
                continue;
            }
            let decoded = links::percent_decode(&raw_target);
            let decoded = decoded.split('#').next().unwrap_or(&decoded);
            if decoded.is_empty() || mime::is_markdown(decoded) || has_scheme(decoded) {
                continue;
            }
            // Try the path as written and rebased on the note's directory,
            // matching what the link rewriter does for note links.
            let candidates = [links::rebase(base_dir, decoded), links::rebase("", decoded)];
            let resolved = candidates
                .into_iter()
                .flatten()
                .find(|candidate| self.absolute(candidate).is_file())
                // Obsidian only: a bare file name resolves anywhere in the
                // vault. GFM stays strict, where a path that doesn't exist is
                // a broken link and guessing would be worse than leaving it.
                .or_else(|| self.attachment_by_name(decoded));
            let Some(resolved) = resolved else {
                continue;
            };
            seen.push(AttachmentRef {
                mime_type: mime::from_path(&resolved).to_string(),
                locator: resolved,
                placeholder: raw_target,
            });
        }
        seen
    }
}

fn is_skipped_dir(name: &str) -> bool {
    name.starts_with('.') && name != "." || SKIPPED_DIRS.contains(&name)
}

/// Path relative to `root`, with forward slashes on every platform so index
/// keys and link targets are directly comparable.
fn relative_path(root: &Path, path: &Path) -> Option<String> {
    let relative = path.strip_prefix(root).ok()?;
    Some(
        relative
            .components()
            .map(|c| c.as_os_str().to_string_lossy().to_string())
            .collect::<Vec<_>>()
            .join("/"),
    )
}

fn parent_dir(relative: &str) -> Option<&str> {
    relative.rfind('/').map(|idx| &relative[..idx])
}

fn file_name(relative: &str) -> String {
    relative.rsplit('/').next().unwrap_or(relative).to_string()
}

fn file_stem(relative: &str) -> String {
    let name = file_name(relative);
    match name.rfind('.') {
        Some(idx) if idx > 0 => name[..idx].to_string(),
        _ => name,
    }
}

fn strip_extension(relative: &str) -> String {
    match relative.rfind('.') {
        Some(idx) if idx > relative.rfind('/').map(|s| s + 1).unwrap_or(0) => {
            relative[..idx].to_string()
        }
        _ => relative.to_string(),
    }
}

fn has_scheme(target: &str) -> bool {
    match target.find(':') {
        // `C:/…` is a Windows path, not a URL scheme.
        Some(idx) => !(idx == 1 && target.as_bytes()[0].is_ascii_alphabetic()),
        None => false,
    }
}

/// Read a file as text, accepting invalid UTF-8 rather than failing.
///
/// Vaults exported from older tools carry stray Latin-1 bytes; losing one
/// character to a replacement marker beats losing the whole note.
fn read_text(path: &Path) -> AppResult<String> {
    let bytes =
        fs::read(path).map_err(|err| AppError::InvalidArg(format!("{}: {err}", path.display())))?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

/// Read just enough of a file to parse its frontmatter block.
fn peek_frontmatter(path: &Path) -> Frontmatter {
    let Ok(mut file) = fs::File::open(path) else {
        return Frontmatter::default();
    };
    let mut buffer = vec![0u8; FRONTMATTER_PEEK_BYTES];
    let Ok(read) = file.read(&mut buffer) else {
        return Frontmatter::default();
    };
    buffer.truncate(read);
    let text = String::from_utf8_lossy(&buffer);
    markdown::split_frontmatter(&text).0
}

/// Coerce the date formats vaults write into the RFC 3339 the notes table
/// stores. Anything unrecognised yields `None`, so the note falls back to the
/// file's own timestamps rather than to a wrong date.
pub fn normalize_timestamp(raw: Option<&str>) -> Option<String> {
    let raw = raw?.trim();
    if raw.is_empty() {
        return None;
    }
    if let Ok(parsed) = chrono::DateTime::parse_from_rfc3339(raw) {
        return Some(parsed.with_timezone(&chrono::Utc).to_rfc3339());
    }
    for format in [
        "%Y-%m-%d %H:%M:%S",
        "%Y-%m-%dT%H:%M:%S",
        "%Y/%m/%d %H:%M:%S",
    ] {
        if let Ok(naive) = chrono::NaiveDateTime::parse_from_str(raw, format) {
            return Some(naive.and_utc().to_rfc3339());
        }
    }
    for format in ["%Y-%m-%d", "%Y/%m/%d", "%d.%m.%Y"] {
        if let Ok(date) = chrono::NaiveDate::parse_from_str(raw, format) {
            return Some(date.and_hms_opt(0, 0, 0)?.and_utc().to_rfc3339());
        }
    }
    None
}
