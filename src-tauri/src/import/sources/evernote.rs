//! Evernote `.enex` export.
//!
//! An ENEX file is one XML document holding every note, with the note body as
//! ENML (Evernote's XHTML dialect) inside a CDATA section and each attachment
//! base64-encoded inline.
//!
//! # Streaming, and why notes are addressed by byte range
//!
//! An export of a large Evernote account is easily several gigabytes, almost
//! all of it base64 attachment data. Parsing it into a DOM, or even keeping
//! every note's ENML in memory during phase 1, would be hopeless. So phase 1
//! streams the file with `quick-xml` and records only each note's metadata plus
//! the byte range of its `<note>` element; phase 2 seeks to that range and
//! parses one note's worth of XML. Memory stays proportional to the note
//! *count*, not the file size.
//!
//! # Links
//!
//! Evernote writes internal links as
//! `evernote:///view/<user>/<shard>/<guid>/<guid>/`. Most exports do not
//! include a `<guid>` element on the notes themselves, so the guid in a link
//! usually has nothing to match against — resolution falls back to the anchor
//! text, which Evernote populates with the target's title. Exports that *do*
//! carry guids resolve exactly.

use std::collections::HashMap;
use std::fs::File;
use std::io::{BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

use md5::{Digest, Md5};
use quick_xml::escape::unescape;
use quick_xml::events::Event;
use quick_xml::Reader;

use crate::error::{AppError, AppResult};
use crate::import::links::{self, RewriteOptions};
use crate::import::model::{AliasTier, AttachmentRef, ItemIndex, SourceIndex, StagedNote};
use crate::import::source::{ImportSource, LoadedItem};
use crate::notes::NoteKind;

/// Private-use characters standing in for ENML constructs while the body goes
/// through the HTML converter.
///
/// `<en-todo/>` and `<en-crypt/>` cannot be handled with a custom tag handler:
/// html5ever does not honour XML self-closing syntax on unknown elements, so
/// `<en-todo/>` opens a tag that swallows the rest of its paragraph, and a
/// handler for it would return the checkbox while dropping the text. Swapping
/// them for sentinel characters before parsing sidesteps that, and going
/// through the private-use area means the converter's text escaping leaves
/// them alone — a literal `[ ]` in the source would come back as `\[ \]`.
const TODO_CHECKED: char = '\u{E000}';
const TODO_UNCHECKED: char = '\u{E001}';
const ENCRYPTED: char = '\u{E002}';

/// URL scheme the media pre-pass writes, so an attachment survives the HTML
/// conversion as an ordinary image and comes out the other side identifiable.
const RESOURCE_SCHEME: &str = "enex-resource:";

/// What phase 1 recorded about one note.
#[derive(Debug, Clone)]
struct NoteIndexEntry {
    start: u64,
    end: u64,
}

pub struct EvernoteSource {
    path: PathBuf,
    ranges: Vec<NoteIndexEntry>,
    /// Resource bytes for the note currently being loaded, keyed by the MD5 of
    /// the bytes — which is how `<en-media hash>` addresses them.
    ///
    /// One note's worth at a time: the orchestrator calls `load` and then
    /// immediately asks for that note's attachments, so a single-item cache is
    /// enough and keeps a note with fifty photos from becoming fifty re-parses
    /// of the same XML.
    current_resources: HashMap<String, Vec<u8>>,
}

impl EvernoteSource {
    pub fn new(path: PathBuf) -> Self {
        Self {
            path,
            ranges: Vec::new(),
            current_resources: HashMap::new(),
        }
    }

    /// Read one note's XML back out of the file.
    fn read_fragment(&self, index: usize) -> AppResult<String> {
        let entry = self
            .ranges
            .get(index)
            .ok_or_else(|| AppError::InvalidArg(format!("no note at index {index}")))?;
        let mut file = File::open(&self.path)
            .map_err(|err| AppError::InvalidArg(format!("{}: {err}", self.path.display())))?;
        file.seek(SeekFrom::Start(entry.start))?;
        let mut buffer = vec![0u8; (entry.end - entry.start) as usize];
        file.read_exact(&mut buffer)?;
        Ok(String::from_utf8_lossy(&buffer).into_owned())
    }
}

impl ImportSource for EvernoteSource {
    fn index(&mut self) -> AppResult<SourceIndex> {
        let file = File::open(&self.path)
            .map_err(|err| AppError::InvalidArg(format!("{}: {err}", self.path.display())))?;
        let mut reader = Reader::from_reader(BufReader::new(file));
        reader.config_mut().trim_text(false);

        let mut out = SourceIndex::default();
        let mut buf = Vec::new();
        let mut note_start: Option<u64> = None;
        // Only the elements that make a title or an id; everything else is
        // read again in phase 2 where the whole note is in hand.
        let mut in_title = false;
        let mut in_guid = false;
        let mut title = String::new();
        let mut guid = String::new();

        loop {
            let position = reader.buffer_position();
            match reader.read_event_into(&mut buf) {
                Ok(Event::Start(tag)) => match tag.name().into_inner() {
                    "note" => {
                        note_start = Some(position);
                        title.clear();
                        guid.clear();
                    }
                    "title" => in_title = true,
                    "guid" => in_guid = true,
                    _ => {}
                },
                Ok(Event::Text(text)) => {
                    if in_title {
                        title.push_str(&decode_text(&text));
                    } else if in_guid {
                        guid.push_str(&decode_text(&text));
                    }
                }
                // quick-xml reports `&amp;` and friends as their own event
                // rather than folding them into the surrounding text, so a
                // title like "Tom &amp; Jerry" arrives in three pieces.
                Ok(Event::GeneralRef(reference)) => {
                    if in_title {
                        title.push_str(&decode_reference(&reference));
                    } else if in_guid {
                        guid.push_str(&decode_reference(&reference));
                    }
                }
                Ok(Event::CData(data)) => {
                    // A title inside CDATA is unusual but legal.
                    if in_title {
                        title.push_str(&data);
                    }
                }
                Ok(Event::End(tag)) => match tag.name().into_inner() {
                    "title" => in_title = false,
                    "guid" => in_guid = false,
                    "note" => {
                        if let Some(start) = note_start.take() {
                            // make_item reads ranges.len() for its locator, so
                            // it has to run before the range is pushed.
                            let item = self.make_item(&title, &guid);
                            self.push_range(start, reader.buffer_position());
                            out.items.push(item);
                        }
                    }
                    _ => {}
                },
                Ok(Event::Eof) => break,
                Err(err) => {
                    return Err(AppError::InvalidArg(format!(
                        "{} is not a readable .enex file: {err}",
                        self.path.display()
                    )))
                }
                _ => {}
            }
            buf.clear();
        }
        Ok(out)
    }

    fn load(&mut self, item: &ItemIndex) -> AppResult<LoadedItem> {
        let index: usize = item
            .locator
            .parse()
            .map_err(|_| AppError::InvalidArg(format!("bad locator {}", item.locator)))?;
        let fragment = self.read_fragment(index)?;
        let parsed = parse_note(&fragment)?;

        self.current_resources = parsed.resources;

        let markdown = enml_to_markdown(&parsed.content)?;
        let attachments = parsed
            .media
            .iter()
            .filter(|hash| self.current_resources.contains_key(*hash))
            .map(|hash| AttachmentRef {
                placeholder: format!("{RESOURCE_SCHEME}{hash}"),
                mime_type: parsed
                    .mime_by_hash
                    .get(hash)
                    .cloned()
                    .unwrap_or_else(|| "application/octet-stream".to_string()),
                locator: hash.clone(),
            })
            .collect();

        Ok(LoadedItem {
            note: StagedNote {
                note_id: item.note_id.clone(),
                title: item.title.clone(),
                folder_id: None,
                body: markdown,
                tags: parsed.tags,
                created: normalize_enex_time(parsed.created.as_deref()),
                modified: normalize_enex_time(parsed.updated.as_deref()),
                note_kind: NoteKind::Markdown,
            },
            attachments,
        })
    }

    fn attachment_bytes(&mut self, reference: &AttachmentRef) -> AppResult<Option<Vec<u8>>> {
        Ok(self.current_resources.get(&reference.locator).cloned())
    }

    fn rewrite_options(&self) -> RewriteOptions {
        RewriteOptions {
            wikilinks: false,
            // ENEX is flat and has no file paths, so a relative markdown link
            // could only be something the user typed by hand.
            markdown_links: false,
            id_links: false,
            evernote_links: true,
            keep_unresolved_wikilinks: false,
        }
    }
}

impl EvernoteSource {
    fn make_item(&self, title: &str, guid: &str) -> ItemIndex {
        let title = title.trim();
        let title = if title.is_empty() {
            "Untitled".to_string()
        } else {
            title.to_string()
        };
        let mut aliases = vec![
            (AliasTier::Title, title.clone()),
            (AliasTier::NormalizedTitle, links::normalize_title(&title)),
        ];
        // Rare, but exports that carry guids let links resolve exactly instead
        // of by title.
        if !guid.trim().is_empty() {
            aliases.insert(0, (AliasTier::NativeId, guid.trim().to_string()));
        }
        ItemIndex {
            note_id: format!("note_{}", uuid::Uuid::new_v4()),
            title,
            folder_id: None,
            locator: self.ranges.len().to_string(),
            aliases,
        }
    }
}

/// `index` has to push the byte range as it builds each item, but `make_item`
/// takes `&self`. Splitting the push out keeps both borrow-clean.
impl EvernoteSource {
    fn push_range(&mut self, start: u64, end: u64) {
        self.ranges.push(NoteIndexEntry { start, end });
    }
}

#[derive(Debug, Default)]
struct ParsedNote {
    content: String,
    tags: Vec<String>,
    created: Option<String>,
    updated: Option<String>,
    /// `<en-media hash>` values in encounter order.
    media: Vec<String>,
    /// MD5 → bytes, for the resources carried by this note.
    resources: HashMap<String, Vec<u8>>,
    mime_by_hash: HashMap<String, String>,
}

/// Parse one `<note>` element.
fn parse_note(fragment: &str) -> AppResult<ParsedNote> {
    let mut reader = Reader::from_str(fragment);
    reader.config_mut().trim_text(false);

    let mut out = ParsedNote::default();
    let mut path: Vec<String> = Vec::new();
    let mut text = String::new();
    // Resource fields are only complete at </resource>, so collect as we go.
    let mut resource_data = String::new();
    let mut resource_mime = String::new();

    loop {
        match reader.read_event() {
            Ok(Event::Start(tag)) => {
                path.push(tag.name().into_inner().to_string());
                text.clear();
            }
            Ok(Event::Text(chunk)) => text.push_str(&decode_text(&chunk)),
            Ok(Event::GeneralRef(reference)) => text.push_str(&decode_reference(&reference)),
            // ENML lives inside CDATA, which is raw by definition — passing it
            // through the entity decoder would corrupt an `&amp;` the note
            // legitimately contains.
            Ok(Event::CData(chunk)) => text.push_str(&chunk),
            Ok(Event::End(tag)) => {
                let name = tag.name().into_inner().to_string();
                let in_resource = path.iter().any(|p| p == "resource");
                match name.as_str() {
                    "content" if !in_resource => out.content = text.clone(),
                    "tag" => {
                        let tag_name = text.trim();
                        if !tag_name.is_empty() {
                            out.tags.push(tag_name.to_string());
                        }
                    }
                    "created" if !in_resource => out.created = Some(text.trim().to_string()),
                    "updated" if !in_resource => out.updated = Some(text.trim().to_string()),
                    "data" if in_resource => resource_data = text.clone(),
                    "mime" if in_resource => resource_mime = text.trim().to_string(),
                    "resource" => {
                        if let Some(bytes) = decode_base64(&resource_data) {
                            // Evernote addresses a resource by the MD5 of its
                            // bytes, which is what `<en-media hash>` carries;
                            // there is no id to match on.
                            let hash = md5_hex(&bytes);
                            if !resource_mime.is_empty() {
                                out.mime_by_hash.insert(hash.clone(), resource_mime.clone());
                            }
                            out.resources.insert(hash, bytes);
                        }
                        resource_data.clear();
                        resource_mime.clear();
                    }
                    _ => {}
                }
                path.pop();
                text.clear();
            }
            Ok(Event::Eof) => break,
            Err(err) => return Err(AppError::InvalidArg(format!("malformed note: {err}"))),
            _ => {}
        }
    }

    out.media = media_hashes(&out.content);
    Ok(out)
}

/// Every `<en-media hash="…">` in the ENML, in encounter order.
fn media_hashes(enml: &str) -> Vec<String> {
    let mut hashes = Vec::new();
    for (at, _) in enml.match_indices("<en-media") {
        let Some(rest) = enml.get(at..) else { continue };
        let Some(end) = rest.find('>') else { continue };
        let Some(hash) = attribute_value(&rest[..end], "hash") else {
            continue;
        };
        if !hashes.contains(&hash) {
            hashes.push(hash);
        }
    }
    hashes
}

fn attribute_value(tag: &str, name: &str) -> Option<String> {
    let needle = format!("{name}=\"");
    let at = tag.find(&needle)? + needle.len();
    let end = tag[at..].find('"')? + at;
    Some(tag[at..end].to_string())
}

/// ENML → markdown.
///
/// The `en-*` elements are swapped for stand-ins first (see [`TODO_CHECKED`]),
/// then the result goes through an ordinary HTML-to-markdown conversion, and
/// the stand-ins are substituted back.
fn enml_to_markdown(enml: &str) -> AppResult<String> {
    let prepared = prepare_enml(enml);
    // Match what the app's own editor serialises, so an imported note and a
    // hand-written one are indistinguishable in source view: `-` bullets with a
    // single space, not htmd's default `*` with three.
    let converter = htmd::HtmlToMarkdown::builder()
        .options(htmd::options::Options {
            bullet_list_marker: htmd::options::BulletListMarker::Dash,
            ul_bullet_spacing: 1,
            ..Default::default()
        })
        .build();
    let markdown = converter
        .convert(&prepared)
        .map_err(|err| AppError::InvalidArg(format!("could not convert note content: {err}")))?;
    Ok(markdown
        .replace(TODO_CHECKED, "- [x] ")
        .replace(TODO_UNCHECKED, "- [ ] ")
        .replace(ENCRYPTED, "*(encrypted content — not imported)*")
        .trim()
        .to_string())
}

/// Replace ENML-only elements with things an HTML parser handles correctly.
///
/// `<en-media>` becomes an `<img>`, a void element, so its siblings stay
/// siblings; the checkbox and encryption markers become sentinel characters.
fn prepare_enml(enml: &str) -> String {
    let mut out = String::with_capacity(enml.len());
    let mut rest = enml;
    while let Some(at) = rest.find('<') {
        out.push_str(&rest[..at]);
        let tail = &rest[at..];
        let Some(end) = tail.find('>') else {
            out.push_str(tail);
            return out;
        };
        let tag = &tail[..=end];
        let lower = tag.to_ascii_lowercase();
        if lower.starts_with("<en-media") {
            // A media element with no hash references nothing, so it is
            // dropped rather than rendered as a broken image.
            if let Some(hash) = attribute_value(tag, "hash") {
                let alt = attribute_value(tag, "alt").unwrap_or_default();
                out.push_str(&format!(
                    "<img src=\"{RESOURCE_SCHEME}{hash}\" alt=\"{alt}\">"
                ));
            }
        } else if lower.starts_with("<en-todo") {
            let checked = attribute_value(tag, "checked")
                .map(|v| v.eq_ignore_ascii_case("true"))
                .unwrap_or(false);
            out.push(if checked {
                TODO_CHECKED
            } else {
                TODO_UNCHECKED
            });
        } else if lower.starts_with("<en-crypt") {
            out.push(ENCRYPTED);
        } else if lower.starts_with("</en-media")
            || lower.starts_with("</en-todo")
            || lower.starts_with("</en-crypt")
        {
            // Closing halves of the elements handled above; drop them.
        } else {
            out.push_str(tag);
        }
        rest = &tail[end + 1..];
    }
    out.push_str(rest);
    out
}

/// XML text events arrive still escaped. A malformed entity is kept verbatim
/// rather than failing the note — a stray `&` in an old export should not cost
/// the user their content.
fn decode_text(raw: &str) -> String {
    unescape(raw)
        .map(|decoded| decoded.into_owned())
        .unwrap_or_else(|_| raw.to_string())
}

/// A `GeneralRef` event carries the entity name alone (`amp`, `#38`), so the
/// delimiters go back on before decoding.
fn decode_reference(name: &str) -> String {
    let literal = format!("&{name};");
    unescape(&literal)
        .map(|decoded| decoded.into_owned())
        .unwrap_or(literal)
}

fn md5_hex(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    let digest = Md5::digest(bytes);
    let mut out = String::with_capacity(digest.len() * 2);
    for byte in digest {
        let _ = write!(out, "{byte:02x}");
    }
    out
}

/// Base64 as ENEX writes it: wrapped across lines, so whitespace is stripped
/// before decoding.
fn decode_base64(raw: &str) -> Option<Vec<u8>> {
    use base64::Engine as _;
    let compact: String = raw.chars().filter(|c| !c.is_whitespace()).collect();
    if compact.is_empty() {
        return None;
    }
    base64::engine::general_purpose::STANDARD
        .decode(compact)
        .ok()
}

/// Evernote timestamps are basic-format ISO 8601: `20240102T100000Z`.
fn normalize_enex_time(raw: Option<&str>) -> Option<String> {
    let raw = raw?.trim();
    if raw.is_empty() {
        return None;
    }
    if let Ok(parsed) = chrono::DateTime::parse_from_rfc3339(raw) {
        return Some(parsed.with_timezone(&chrono::Utc).to_rfc3339());
    }
    chrono::NaiveDateTime::parse_from_str(raw, "%Y%m%dT%H%M%SZ")
        .ok()
        .map(|naive| naive.and_utc().to_rfc3339())
}

/// Does this file look like an Evernote export?
pub fn is_enex(path: &Path) -> bool {
    path.extension()
        .map(|extension| extension.to_string_lossy().eq_ignore_ascii_case("enex"))
        .unwrap_or(false)
}
