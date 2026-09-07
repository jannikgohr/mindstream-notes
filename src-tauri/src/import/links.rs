//! Turning a source vault's links into Mindstream note links.
//!
//! Every note id exists before any body is rewritten (phase 1 mints them all),
//! so resolution is a pure lookup with no ordering constraint. Notes that
//! reference each other, three-note cycles and self-links all fall out for
//! free — there is no second fixup pass because there is nothing left to fix
//! up.
//!
//! The output is always `[text](mindstream://note/<id>)`, the format
//! `src/lib/editor/plugins/wikilink-href.ts` defines. Nothing is left as a
//! literal `[[Target]]`: the editor's title-matching fallback for those is
//! deprecated, and guessing at click time is strictly worse than resolving
//! once at import, when the whole source vault is in front of us.

use std::collections::HashMap;

use super::model::{AliasTier, ItemIndex, UnresolvedLinks};

/// Note ids are `note_<uuid>` — entirely within `[A-Za-z0-9_-]`, which needs
/// no percent-encoding, so the href can be built by concatenation and
/// `parseNoteHref` round-trips it unchanged.
pub fn note_href(note_id: &str) -> String {
    format!("mindstream://note/{note_id}")
}

/// A link target the source referenced but never defined.
#[derive(Debug, Clone)]
pub struct Placeholder {
    pub note_id: String,
    pub title: String,
}

/// Alias → note id, with the tier that claimed it.
pub struct LinkIndex {
    by_alias: HashMap<String, (AliasTier, String)>,
    placeholders: Vec<Placeholder>,
    policy: UnresolvedLinks,
}

impl LinkIndex {
    pub fn new(policy: UnresolvedLinks) -> Self {
        Self {
            by_alias: HashMap::new(),
            placeholders: Vec::new(),
            policy,
        }
    }

    /// Register every alias an indexed item answers to.
    pub fn register_item(&mut self, item: &ItemIndex) {
        for (tier, key) in &item.aliases {
            self.register(*tier, key, &item.note_id);
        }
    }

    /// Claim `key` for `note_id`.
    ///
    /// A stronger tier displaces a weaker one; within a tier the first
    /// registration wins. So two notes named `Index.md` both try to claim the
    /// basename `index` and only the first gets it, but a link that spells out
    /// `Archive/Index.md` still reaches the second, because its full path was
    /// claimed at a stronger tier.
    pub fn register(&mut self, tier: AliasTier, key: &str, note_id: &str) {
        let key = normalize_key(key);
        if key.is_empty() {
            return;
        }
        match self.by_alias.get(&key) {
            Some((existing, _)) if *existing <= tier => {}
            _ => {
                self.by_alias.insert(key, (tier, note_id.to_string()));
            }
        }
    }

    /// Look `key` up, exactly first and then loosely.
    ///
    /// The loose pass is what makes [`AliasTier::NormalizedTitle`] reachable:
    /// a MediaWiki link spells its target `Foo_Bar` while the note is titled
    /// `Foo Bar`, and only the flattened form brings the two together. Trying
    /// it second means an exact match always wins.
    pub fn resolve(&self, key: &str) -> Option<&str> {
        if let Some((_, id)) = self.by_alias.get(&normalize_key(key)) {
            return Some(id.as_str());
        }
        self.by_alias
            .get(&normalize_title(key))
            .map(|(_, id)| id.as_str())
    }

    /// Resolve `key`, minting a placeholder note for it if the policy says so.
    ///
    /// Placeholders are interned on first use and registered like any other
    /// alias, so every later reference to the same missing target resolves to
    /// the same note. That is why phase 1 can stay a body-free walk: a target
    /// nobody knew about until a body was parsed still ends up with one
    /// stable id.
    pub fn resolve_or_intern(&mut self, key: &str, title: &str) -> Option<String> {
        if let Some(id) = self.resolve(key) {
            return Some(id.to_string());
        }
        if self.policy != UnresolvedLinks::CreatePlaceholder {
            return None;
        }
        let note_id = format!("note_{}", uuid::Uuid::new_v4());
        self.placeholders.push(Placeholder {
            note_id: note_id.clone(),
            title: title.trim().to_string(),
        });
        self.register(AliasTier::Title, key, &note_id);
        Some(note_id)
    }

    pub fn placeholders(&self) -> &[Placeholder] {
        &self.placeholders
    }
}

/// Case- and separator-insensitive lookup key.
///
/// Windows and macOS vaults are case-insensitive, so a link written
/// `[[readme]]` must find `README.md`. Backslashes fold to forward slashes
/// because a link authored on Windows can carry either.
fn normalize_key(raw: &str) -> String {
    raw.trim()
        .trim_start_matches("./")
        .replace('\\', "/")
        .to_lowercase()
}

/// The looser form used for [`AliasTier::NormalizedTitle`]: separators become
/// spaces and punctuation is dropped, so `Foo_Bar`, `foo-bar` and `Foo Bar!`
/// all collapse together. MediaWiki page titles are underscore-separated,
/// which is why this tier exists at all.
pub fn normalize_title(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut last_was_space = true;
    for ch in raw.chars() {
        let mapped = if ch == '_' || ch == '-' || ch.is_whitespace() {
            ' '
        } else if ch.is_alphanumeric() {
            ch
        } else {
            continue;
        };
        if mapped == ' ' {
            if last_was_space {
                continue;
            }
            last_was_space = true;
        } else {
            last_was_space = false;
        }
        out.extend(mapped.to_lowercase());
    }
    out.trim_end().to_string()
}

/// Which link syntaxes a source wants rewritten. Plain GFM has no wikilinks;
/// running the wikilink pass over it anyway would turn `[[1]]` in a citation
/// into a link.
#[derive(Debug, Clone, Copy)]
pub struct RewriteOptions {
    pub wikilinks: bool,
    pub markdown_links: bool,
    /// Joplin's `[text](:/<id>)`, where the target is the note's own id.
    /// Resolves exactly, with no title guessing — which is why the RAW export
    /// is the Joplin format worth parsing.
    pub id_links: bool,
    /// Evernote's `[text](evernote:///view/<user>/<shard>/<guid>/<guid>/)`.
    pub evernote_links: bool,
}

/// Everything the rewrite needs about *where* the body came from.
///
/// `base_dir` is the note's own directory relative to the import root, and it
/// is what makes `[text](../Other/note.md)` resolvable: the index is keyed on
/// root-relative paths, so a link written relative to the file has to be
/// rebased before it can be looked up.
#[derive(Debug, Clone)]
pub struct RewriteContext {
    pub options: RewriteOptions,
    pub base_dir: String,
}

/// Join a file-relative link target onto the note's directory and normalise
/// `.` / `..`, without touching the filesystem. Returns `None` if the target
/// climbs above the import root.
pub fn rebase(base_dir: &str, target: &str) -> Option<String> {
    let mut parts: Vec<String> = base_dir
        .split('/')
        .filter(|p| !p.is_empty() && *p != ".")
        .map(str::to_string)
        .collect();
    for segment in target.replace('\\', "/").split('/') {
        match segment {
            "" | "." => {}
            ".." => {
                parts.pop()?;
            }
            other => parts.push(other.to_string()),
        }
    }
    Some(parts.join("/"))
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct RewriteStats {
    pub resolved: usize,
    pub unresolved: usize,
}

/// Rewrite every link in `body` that points at another note in the source.
///
/// Attachment references are handled separately, by the source, because only
/// it knows which of its relative paths are files it can produce bytes for.
pub fn rewrite_links(
    body: &str,
    index: &mut LinkIndex,
    context: &RewriteContext,
    stats: &mut RewriteStats,
) -> String {
    let mut out = body.to_string();
    if context.options.wikilinks {
        out = rewrite_wikilinks(&out, index, stats);
    }
    if context.options.id_links {
        out = rewrite_id_links(&out, index, stats);
    }
    if context.options.evernote_links {
        out = rewrite_evernote_links(&out, index, stats);
    }
    if context.options.markdown_links {
        out = rewrite_markdown_links(&out, index, &context.base_dir, stats);
    }
    out
}

/// `[text](:/<32-hex-id>)` — Joplin's internal link form.
///
/// Ids that name a *resource* rather than a note are deliberately left alone:
/// the source reports those as attachments, and the writer swaps them for
/// asset URLs once the bytes are stored.
fn rewrite_id_links(body: &str, index: &mut LinkIndex, stats: &mut RewriteStats) -> String {
    const OPENER: &str = "](:/";
    let mut out = String::with_capacity(body.len());
    let mut rest = body;
    while let Some(at) = rest.find(OPENER) {
        out.push_str(&rest[..at]);
        let after = &rest[at + OPENER.len()..];
        let id: String = after
            .chars()
            .take_while(char::is_ascii_alphanumeric)
            .collect();
        let tail = &after[id.len()..];
        match index.resolve(&id).map(str::to_string) {
            Some(note_id) if tail.starts_with(')') => {
                stats.resolved += 1;
                out.push_str(&format!("]({})", note_href(&note_id)));
                rest = &tail[1..];
            }
            _ => {
                out.push_str(&rest[at..at + OPENER.len()]);
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

/// `[[Target]]`, `[[Target|Alias]]`, `[[Target#heading]]`, `[[Target^block]]`.
///
/// Embeds (`![[…]]`) that survive to this point are note transclusions — the
/// source has already swapped out the ones that pointed at files. Mindstream
/// has no transclusion, so they degrade to a plain link to the same note,
/// which is the closest thing that still works.
fn rewrite_wikilinks(body: &str, index: &mut LinkIndex, stats: &mut RewriteStats) -> String {
    let mut out = String::with_capacity(body.len());
    let bytes = body.as_bytes();
    let mut i = 0usize;
    while i < bytes.len() {
        let is_embed = bytes[i] == b'!' && body[i + 1..].starts_with("[[");
        let starts_link = body[i..].starts_with("[[");
        if !starts_link && !is_embed {
            // Push one whole char so multi-byte scalars are never split.
            let ch = body[i..].chars().next().unwrap_or('\0');
            out.push(ch);
            i += ch.len_utf8();
            continue;
        }
        let open = if is_embed { i + 1 } else { i };
        let Some(close_rel) = body[open + 2..].find("]]") else {
            let ch = body[i..].chars().next().unwrap_or('\0');
            out.push(ch);
            i += ch.len_utf8();
            continue;
        };
        let inner = &body[open + 2..open + 2 + close_rel];
        // A newline inside means this was never a wikilink — most likely two
        // unrelated bracket pairs. Leave the text alone.
        if inner.contains('\n') {
            let ch = body[i..].chars().next().unwrap_or('\0');
            out.push(ch);
            i += ch.len_utf8();
            continue;
        }

        let (target, alias) = split_wikilink(inner);
        if target.is_empty() {
            out.push_str(&body[i..open + 2 + close_rel + 2]);
            i = open + 2 + close_rel + 2;
            continue;
        }
        let display = alias.unwrap_or(target);
        match index.resolve_or_intern(target, target) {
            Some(note_id) => {
                stats.resolved += 1;
                out.push_str(&format!(
                    "[{}]({})",
                    escape_link_text(display),
                    note_href(&note_id)
                ));
            }
            None => {
                stats.unresolved += 1;
                out.push_str(display);
            }
        }
        i = open + 2 + close_rel + 2;
    }
    out
}

/// Split `Target#heading|Alias` into its target and display text. The anchor
/// is dropped: Mindstream links address a note, not a position inside it.
fn split_wikilink(inner: &str) -> (&str, Option<&str>) {
    let (target_part, alias) = match inner.split_once('|') {
        Some((t, a)) => (t, Some(a.trim())),
        None => (inner, None),
    };
    let target = target_part
        .split(['#', '^'])
        .next()
        .unwrap_or(target_part)
        .trim();
    // `[[Note#Section]]` with no alias reads better as "Note#Section" than as
    // a bare "Note", so keep the original text when we dropped an anchor.
    let display = alias.or({
        if target_part.trim() == target {
            None
        } else {
            Some(target_part.trim())
        }
    });
    (target, display)
}

/// `[text](evernote:///view/<user>/<shard>/<guid>/<guid>/)`.
///
/// The guid is tried first, but most exports omit the `<guid>` element on the
/// notes themselves, so there is usually nothing for it to match. The fallback
/// is the anchor text, which Evernote fills in with the target note's title —
/// imprecise where two notes share a title, and still far better than dropping
/// the link.
fn rewrite_evernote_links(body: &str, index: &mut LinkIndex, stats: &mut RewriteStats) -> String {
    const SCHEME: &str = "](evernote:";
    let mut out = String::with_capacity(body.len());
    let mut rest = body;
    while let Some(at) = rest.find(SCHEME) {
        let Some(close) = rest[at..].find(')').map(|idx| idx + at) else {
            out.push_str(rest);
            return out;
        };
        let url = &rest[at + 2..close];
        // The link text is what precedes the `](`, back to its unescaped `[`.
        let text_start = match rest[..at].rfind('[') {
            Some(idx) => idx,
            None => {
                out.push_str(&rest[..close + 1]);
                rest = &rest[close + 1..];
                continue;
            }
        };
        let text = &rest[text_start + 1..at];
        let resolved = evernote_guid(url)
            .and_then(|guid| index.resolve(&guid).map(str::to_string))
            .or_else(|| index.resolve(text).map(str::to_string));

        out.push_str(&rest[..text_start]);
        match resolved {
            Some(note_id) => {
                stats.resolved += 1;
                out.push_str(&format!("[{text}]({})", note_href(&note_id)));
            }
            None => {
                stats.unresolved += 1;
                // Drop the dead scheme but keep the words: an
                // `evernote:///view/...` href is useless outside Evernote.
                out.push_str(text);
            }
        }
        rest = &rest[close + 1..];
    }
    out.push_str(rest);
    out
}

/// Pull the note guid out of an `evernote:///view/<user>/<shard>/<guid>/...`
/// URL. Anything shorter than that shape has no guid to give.
fn evernote_guid(url: &str) -> Option<String> {
    let rest = url.strip_prefix("evernote:///view/")?;
    let segments: Vec<&str> = rest.split('/').filter(|s| !s.is_empty()).collect();
    segments.get(2).map(|guid| guid.to_string())
}

/// `[text](relative/path.md)` — the GFM way of linking between files.
///
/// Absolute URLs, anchors and anything that doesn't resolve to a known note
/// are left exactly as they were: a link to `https://example.com` is not ours
/// to rewrite, and neither is a relative link to a file we didn't import.
fn rewrite_markdown_links(
    body: &str,
    index: &mut LinkIndex,
    base_dir: &str,
    stats: &mut RewriteStats,
) -> String {
    let mut out = String::with_capacity(body.len());
    let mut rest = body;
    while let Some(open) = rest.find('[') {
        // An image (`![…](…)`) is an attachment reference, never a note link.
        let is_image = open > 0 && rest.as_bytes()[open - 1] == b'!';
        out.push_str(&rest[..open + 1]);
        rest = &rest[open + 1..];

        let Some((text, target, consumed)) = split_inline_link(rest) else {
            continue;
        };
        if is_image || target.is_empty() || !is_relative_target(target) {
            continue;
        }
        // Try the link as written and as rebased onto the note's own
        // directory. Vaults mix both: an exporter may write root-relative
        // paths while a human writes `../Sibling/note.md`.
        let key = strip_anchor(&percent_decode(target));
        let rebased = rebase(base_dir, &key);
        let resolved = index
            .resolve(&key)
            .or_else(|| rebased.as_deref().and_then(|k| index.resolve(k)))
            .map(str::to_string);
        match resolved {
            Some(note_id) => {
                stats.resolved += 1;
                // The '[' is already on `out`; finish the link ourselves.
                out.push_str(text);
                out.push_str(&format!("]({})", note_href(&note_id)));
                rest = &rest[consumed..];
            }
            None => continue,
        }
    }
    out.push_str(rest);
    out
}

/// Every inline-link target in `body`, exactly as written.
///
/// Sources use this to spot the targets that point at files they can supply
/// bytes for. The raw (still percent-encoded) form comes back because the
/// caller has to substring-replace it in the body afterwards.
pub fn inline_link_targets(body: &str) -> Vec<String> {
    let mut targets = Vec::new();
    let mut rest = body;
    while let Some(open) = rest.find('[') {
        rest = &rest[open + 1..];
        if let Some((_, target, consumed)) = split_inline_link(rest) {
            if !target.is_empty() {
                targets.push(target.to_string());
            }
            rest = &rest[consumed.min(rest.len())..];
        }
    }
    targets
}

/// Parse `text](target)` starting just after the opening bracket. Returns the
/// text, the target, and how many bytes the whole `text](target)` tail spans.
fn split_inline_link(rest: &str) -> Option<(&str, &str, usize)> {
    // Bracket depth, so `[![img](a.png)](b.md)` finds the right closer.
    let bytes = rest.as_bytes();
    let mut depth = 0usize;
    let mut close = None;
    for (idx, byte) in bytes.iter().enumerate() {
        match byte {
            b'[' => depth += 1,
            b']' => {
                if depth == 0 {
                    close = Some(idx);
                    break;
                }
                depth -= 1;
            }
            b'\n' => break,
            _ => {}
        }
    }
    let close = close?;
    if rest.as_bytes().get(close + 1) != Some(&b'(') {
        return None;
    }
    let target_end = rest[close + 2..].find(')')? + close + 2;
    let target = rest[close + 2..target_end].trim();
    // A title (`(path.md "Title")`) is not part of the target.
    let target = target.split_whitespace().next().unwrap_or(target);
    Some((&rest[..close], target, target_end + 1))
}

/// Is this a path inside the vault, rather than a URL or a bare anchor?
fn is_relative_target(target: &str) -> bool {
    if target.starts_with('#') || target.starts_with('/') {
        return false;
    }
    // A scheme (`https:`, `mailto:`, `mindstream:`) means it isn't ours.
    match target.find(':') {
        Some(idx) => {
            // `C:/…` is a Windows path, not a scheme.
            idx == 1 && target.as_bytes()[0].is_ascii_alphabetic()
        }
        None => true,
    }
}

fn strip_anchor(target: &str) -> String {
    match target.split_once('#') {
        Some((path, _)) => path.to_string(),
        None => target.to_string(),
    }
}

/// Minimal percent-decoding for link targets. Vault links commonly encode
/// spaces as `%20`, and the index is keyed on the decoded name.
pub fn percent_decode(raw: &str) -> String {
    let bytes = raw.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).ok();
            if let Some(byte) = hex.and_then(|h| u8::from_str_radix(h, 16).ok()) {
                out.push(byte);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8(out).unwrap_or_else(|_| raw.to_string())
}

/// Keep display text from breaking out of the `[…]` it now lives in.
fn escape_link_text(text: &str) -> String {
    text.replace('[', "\\[").replace(']', "\\]")
}
