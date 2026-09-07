//! Joplin's RAW export, and the `.jex` archive that is a tar of it.
//!
//! One parser serves both: [`crate::import::stage`] unpacks a `.jex` into a
//! temporary directory and hands back the same flat layout the RAW export
//! writes directly.
//!
//! Every item — note, folder, resource, tag — is a `<id>.md` file shaped like:
//!
//! ```text
//! The item's title
//!
//! Body, for notes.
//!
//! id: 8f5a3f2c4e5b4d6a8c9e0f1a2b3c4d5e
//! parent_id: 1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d
//! created_time: 2024-01-01T10:00:00.000Z
//! type_: 1
//! ```
//!
//! This is the lossless export, which is why it is worth parsing: items carry
//! their real ids, and links between notes are written `[title](:/<id>)`. That
//! makes link preservation exact rather than a title match.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use crate::error::{AppError, AppResult};
use crate::import::links::{self, RewriteOptions};
use crate::import::mime;
use crate::import::model::{
    AliasTier, AttachmentRef, FolderIndex, ItemIndex, SourceIndex, StagedNote,
};
use crate::import::source::{ImportSource, LoadedItem};
use crate::import::stage::StagedArchive;
use crate::notes::NoteKind;

/// Joplin's `type_` discriminator. Only the ones that carry content matter
/// here; settings, revisions and master keys are skipped.
const TYPE_NOTE: i64 = 1;
const TYPE_FOLDER: i64 = 2;
const TYPE_RESOURCE: i64 = 4;
const TYPE_TAG: i64 = 5;
const TYPE_NOTE_TAG: i64 = 6;

/// One parsed `<id>.md`.
#[derive(Debug, Clone)]
struct RawItem {
    title: String,
    body: String,
    fields: HashMap<String, String>,
}

impl RawItem {
    fn field(&self, key: &str) -> Option<&str> {
        self.fields.get(key).map(String::as_str)
    }

    fn type_(&self) -> Option<i64> {
        self.field("type_")?.trim().parse().ok()
    }
}

#[derive(Debug, Clone)]
struct Resource {
    /// Joplin stores the bytes as `resources/<id>.<file_extension>`.
    file_extension: String,
    mime_type: String,
}

pub struct JoplinRawSource {
    root: PathBuf,
    /// Kept alive for the whole run when the source was a `.jex`: the
    /// extracted files are read lazily in phase 2, so dropping this earlier
    /// would delete the vault mid-import.
    _staged: Option<StagedArchive>,
    resources: HashMap<String, Resource>,
    /// Joplin note id → tag names, assembled from the `note_tag` join items.
    tags_by_note: HashMap<String, Vec<String>>,
}

impl JoplinRawSource {
    pub fn new(root: PathBuf) -> Self {
        Self {
            root,
            _staged: None,
            resources: HashMap::new(),
            tags_by_note: HashMap::new(),
        }
    }

    /// Unpack a `.jex` and read the RAW layout inside it.
    pub fn from_archive(archive: &Path) -> AppResult<Self> {
        let staged = crate::import::stage::extract_tar(archive)?;
        Ok(Self {
            root: staged.path().to_path_buf(),
            _staged: Some(staged),
            resources: HashMap::new(),
            tags_by_note: HashMap::new(),
        })
    }

    fn read_item(&self, path: &Path) -> Option<RawItem> {
        let bytes = fs::read(path).ok()?;
        parse_item(&String::from_utf8_lossy(&bytes))
    }
}

impl ImportSource for JoplinRawSource {
    fn index(&mut self) -> AppResult<SourceIndex> {
        // The RAW layout is flat, so one directory read finds every item.
        let mut paths: Vec<PathBuf> = fs::read_dir(&self.root)
            .map_err(|err| AppError::InvalidArg(format!("{}: {err}", self.root.display())))?
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .filter(|path| path.is_file() && mime::is_markdown(&path.to_string_lossy()))
            .collect();
        paths.sort();

        let mut notes: Vec<(String, RawItem)> = Vec::new();
        let mut folders: HashMap<String, RawItem> = HashMap::new();
        let mut tag_names: HashMap<String, String> = HashMap::new();
        let mut note_tag_pairs: Vec<(String, String)> = Vec::new();

        for path in &paths {
            let Some(item) = self.read_item(path) else {
                continue;
            };
            let Some(id) = item.field("id").map(str::to_string) else {
                continue;
            };
            match item.type_() {
                Some(TYPE_NOTE) => notes.push((id, item)),
                Some(TYPE_FOLDER) => {
                    folders.insert(id, item);
                }
                Some(TYPE_RESOURCE) => {
                    let mime_type = match item.field("mime").filter(|m| !m.is_empty()) {
                        Some(declared) => declared.to_string(),
                        None => mime::from_path(&item.title).to_string(),
                    };
                    self.resources.insert(
                        id,
                        Resource {
                            file_extension: item.field("file_extension").unwrap_or("").to_string(),
                            mime_type,
                        },
                    );
                }
                Some(TYPE_TAG) => {
                    tag_names.insert(id, item.title.clone());
                }
                Some(TYPE_NOTE_TAG) => {
                    if let (Some(note), Some(tag)) = (item.field("note_id"), item.field("tag_id")) {
                        note_tag_pairs.push((note.to_string(), tag.to_string()));
                    }
                }
                _ => {}
            }
        }

        for (note_id, tag_id) in note_tag_pairs {
            if let Some(name) = tag_names.get(&tag_id) {
                self.tags_by_note
                    .entry(note_id)
                    .or_default()
                    .push(name.clone());
            }
        }

        let folder_ids: HashMap<String, String> = folders
            .keys()
            .map(|id| (id.clone(), format!("col_{}", uuid::Uuid::new_v4())))
            .collect();
        let mut out = SourceIndex {
            folders: order_folders(&folders, &folder_ids),
            items: Vec::with_capacity(notes.len()),
        };

        for (joplin_id, item) in notes {
            let title = if item.title.trim().is_empty() {
                "Untitled".to_string()
            } else {
                item.title.clone()
            };
            out.items.push(ItemIndex {
                note_id: format!("note_{}", uuid::Uuid::new_v4()),
                folder_id: item
                    .field("parent_id")
                    .and_then(|parent| folder_ids.get(parent))
                    .cloned(),
                // Joplin's own id is unambiguous, which is the whole reason
                // this format is worth parsing: `[text](:/id)` resolves
                // exactly, with no title guessing.
                aliases: vec![
                    (AliasTier::NativeId, joplin_id.clone()),
                    (AliasTier::Title, title.clone()),
                    (AliasTier::NormalizedTitle, links::normalize_title(&title)),
                ],
                title,
                locator: format!("{joplin_id}.md"),
            });
        }
        Ok(out)
    }

    fn load(&mut self, item: &ItemIndex) -> AppResult<LoadedItem> {
        let path = self.root.join(&item.locator);
        let raw = self
            .read_item(&path)
            .ok_or_else(|| AppError::InvalidArg(format!("unreadable item {}", item.locator)))?;
        let joplin_id = raw.field("id").unwrap_or_default().to_string();

        // Resource references are `:/<id>` just like note links; which one it
        // is depends purely on whether the id names a resource.
        let mut attachments: Vec<AttachmentRef> = Vec::new();
        for (at, _) in raw.body.match_indices(":/") {
            let id: String = raw.body[at + 2..]
                .chars()
                .take_while(char::is_ascii_alphanumeric)
                .collect();
            let Some(resource) = self.resources.get(&id) else {
                continue;
            };
            if attachments.iter().any(|a| a.locator == id) {
                continue;
            }
            attachments.push(AttachmentRef {
                placeholder: format!(":/{id}"),
                locator: id,
                mime_type: resource.mime_type.clone(),
            });
        }

        Ok(LoadedItem {
            note: StagedNote {
                note_id: item.note_id.clone(),
                title: item.title.clone(),
                folder_id: item.folder_id.clone(),
                body: raw.body.clone(),
                tags: self
                    .tags_by_note
                    .get(&joplin_id)
                    .cloned()
                    .unwrap_or_default(),
                created: normalize_joplin_time(raw.field("user_created_time"))
                    .or_else(|| normalize_joplin_time(raw.field("created_time"))),
                modified: normalize_joplin_time(raw.field("user_updated_time"))
                    .or_else(|| normalize_joplin_time(raw.field("updated_time"))),
                note_kind: NoteKind::Markdown,
            },
            attachments,
        })
    }

    fn attachment_bytes(&mut self, reference: &AttachmentRef) -> AppResult<Option<Vec<u8>>> {
        let Some(resource) = self.resources.get(&reference.locator) else {
            return Ok(None);
        };
        let name = if resource.file_extension.is_empty() {
            reference.locator.clone()
        } else {
            format!("{}.{}", reference.locator, resource.file_extension)
        };
        match fs::read(self.root.join("resources").join(&name)) {
            Ok(bytes) => Ok(Some(bytes)),
            Err(err) => {
                log::warn!("[import] joplin resource {name} unreadable: {err}");
                Ok(None)
            }
        }
    }

    fn rewrite_options(&self) -> RewriteOptions {
        RewriteOptions {
            // Joplin writes plain markdown; `[[…]]` is not a link syntax.
            wikilinks: false,
            markdown_links: true,
            id_links: true,
            evernote_links: false,
        }
    }
}

/// Split an item file into its title line, body, and trailing metadata block.
///
/// The metadata is the run of `key: value` lines at the very end. Scanning
/// backwards until a line stops matching is what keeps a body that happens to
/// contain `foo: bar` from being eaten — the blank line before the block ends
/// the scan. An item without `type_` is not a Joplin item at all.
fn parse_item(raw: &str) -> Option<RawItem> {
    let normalized = raw.replace("\r\n", "\n");
    let lines: Vec<&str> = normalized.split('\n').collect();

    let mut fields = HashMap::new();
    let mut first_meta = lines.len();
    for (idx, line) in lines.iter().enumerate().rev() {
        if line.trim().is_empty() && idx + 1 == first_meta {
            // A trailing newline leaves an empty final element; step past it
            // without ending the scan.
            first_meta = idx;
            continue;
        }
        match split_field(line) {
            Some((key, value)) => {
                fields.insert(key, value);
                first_meta = idx;
            }
            None => break,
        }
    }
    if !fields.contains_key("type_") {
        return None;
    }

    let head = &lines[..first_meta];
    let title = head.first().unwrap_or(&"").trim().to_string();
    let body = head
        .iter()
        .skip(1)
        .copied()
        .collect::<Vec<_>>()
        .join("\n")
        .trim_matches('\n')
        .to_string();

    Some(RawItem {
        title,
        body,
        fields,
    })
}

/// A metadata line is `snake_case_key: value`, with an empty value allowed.
/// Anything else ends the block.
fn split_field(line: &str) -> Option<(String, String)> {
    let (key, value) = line.split_once(':')?;
    if key.is_empty()
        || !key
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
    {
        return None;
    }
    Some((key.to_string(), value.trim().to_string()))
}

/// Emit folders parents-first, which is what the single-pass insert needs.
///
/// Joplin's export order is arbitrary, and a folder whose parent has not been
/// written yet would violate the foreign key. Depth comes from walking each
/// folder's parent chain, bounded so a hand-edited export containing a cycle
/// can't spin forever.
fn order_folders(
    folders: &HashMap<String, RawItem>,
    folder_ids: &HashMap<String, String>,
) -> Vec<FolderIndex> {
    let mut ordered: Vec<(usize, FolderIndex)> = folders
        .iter()
        .map(|(id, item)| {
            let parent = item.field("parent_id").filter(|p| !p.is_empty());
            (
                depth_of(folders, id),
                FolderIndex {
                    id: folder_ids.get(id).cloned().unwrap_or_default(),
                    parent_id: parent.and_then(|p| folder_ids.get(p)).cloned(),
                    name: if item.title.trim().is_empty() {
                        "Untitled folder".to_string()
                    } else {
                        item.title.clone()
                    },
                },
            )
        })
        .collect();
    // Depth first, then name, so a run is reproducible.
    ordered.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.name.cmp(&b.1.name)));
    ordered.into_iter().map(|(_, folder)| folder).collect()
}

fn depth_of(folders: &HashMap<String, RawItem>, id: &str) -> usize {
    let mut depth = 0usize;
    let mut current = id;
    // The bound doubles as cycle protection.
    while depth < 64 {
        let Some(item) = folders.get(current) else {
            break;
        };
        let Some(parent) = item.field("parent_id").filter(|p| !p.is_empty()) else {
            break;
        };
        if !folders.contains_key(parent) {
            break;
        }
        current = parent;
        depth += 1;
    }
    depth
}

/// Joplin writes ISO-8601 with milliseconds (`2024-01-01T10:00:00.000Z`),
/// which is valid RFC 3339. Older exports use epoch milliseconds instead.
fn normalize_joplin_time(raw: Option<&str>) -> Option<String> {
    let raw = raw?.trim();
    if raw.is_empty() {
        return None;
    }
    if let Ok(parsed) = chrono::DateTime::parse_from_rfc3339(raw) {
        return Some(parsed.with_timezone(&chrono::Utc).to_rfc3339());
    }
    let millis: i64 = raw.parse().ok()?;
    if millis <= 0 {
        return None;
    }
    chrono::DateTime::from_timestamp_millis(millis).map(|dt| dt.to_rfc3339())
}

/// Does this directory look like a Joplin RAW export? Used by detection.
pub fn looks_like_raw_export(path: &Path) -> bool {
    let Ok(entries) = fs::read_dir(path) else {
        return false;
    };
    entries
        .filter_map(Result::ok)
        .filter(|entry| entry.path().is_file())
        .filter(|entry| mime::is_markdown(&entry.file_name().to_string_lossy()))
        .take(20)
        .any(|entry| {
            fs::read(entry.path())
                .ok()
                .and_then(|bytes| parse_item(&String::from_utf8_lossy(&bytes)))
                .is_some()
        })
}
