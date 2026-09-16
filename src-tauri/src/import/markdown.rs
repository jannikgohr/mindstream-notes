//! YAML frontmatter and the other metadata conventions markdown vaults use.
//!
//! Obsidian, Jekyll, Hugo and `mediawiki-to-markdown` all front-load a
//! `---` block; the keys differ but the shape doesn't. We read the handful
//! that map onto a Mindstream note and ignore the rest rather than failing on
//! a vault-specific key.

use yaml_rust2::{Yaml, YamlLoader};

/// What a frontmatter block contributed. Everything is optional — a plain
/// markdown file with no block at all is perfectly valid input.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Frontmatter {
    pub title: Option<String>,
    pub tags: Vec<String>,
    /// Obsidian's `aliases:`, registered as extra link targets.
    pub aliases: Vec<String>,
    pub created: Option<String>,
    pub modified: Option<String>,
}

/// Split a `---`-delimited frontmatter block off the front of `raw`.
///
/// Returns the parsed block and the remaining body. A file that opens with
/// `---` but never closes it is treated as having no frontmatter, because a
/// horizontal rule on line 1 is far more likely than a truncated block.
pub fn split_frontmatter(raw: &str) -> (Frontmatter, &str) {
    let trimmed = raw.strip_prefix('\u{feff}').unwrap_or(raw);
    let Some(rest) = trimmed
        .strip_prefix("---\n")
        .or_else(|| trimmed.strip_prefix("---\r\n"))
    else {
        return (Frontmatter::default(), trimmed);
    };
    let Some(end) = find_closing_fence(rest) else {
        return (Frontmatter::default(), trimmed);
    };
    let (block, after) = rest.split_at(end.0);
    (parse_frontmatter(block), &after[end.1..])
}

/// Byte offset of the closing `---` line and the length of that line
/// (including its newline), so the caller can slice past it.
fn find_closing_fence(rest: &str) -> Option<(usize, usize)> {
    let mut offset = 0usize;
    for line in rest.split_inclusive('\n') {
        let stripped = line.trim_end_matches(['\n', '\r']);
        if stripped == "---" || stripped == "..." {
            return Some((offset, line.len()));
        }
        offset += line.len();
    }
    None
}

fn parse_frontmatter(block: &str) -> Frontmatter {
    // A malformed block is metadata we do without, never a failed import.
    let Ok(docs) = YamlLoader::load_from_str(block) else {
        return Frontmatter::default();
    };
    let Some(doc) = docs.first() else {
        return Frontmatter::default();
    };

    let mut fm = Frontmatter {
        title: scalar(&doc["title"]).or_else(|| scalar(&doc["name"])),
        tags: string_list(&doc["tags"]),
        aliases: string_list(&doc["aliases"]),
        created: scalar(&doc["created"])
            .or_else(|| scalar(&doc["created_at"]))
            .or_else(|| scalar(&doc["date"])),
        modified: scalar(&doc["modified"])
            .or_else(|| scalar(&doc["updated"]))
            .or_else(|| scalar(&doc["updated_at"])),
    };
    // Obsidian writes `tag:` as often as `tags:`.
    if fm.tags.is_empty() {
        fm.tags = string_list(&doc["tag"]);
    }
    if fm.aliases.is_empty() {
        fm.aliases = string_list(&doc["alias"]);
    }
    fm
}

/// A YAML scalar as a string. Numbers and booleans are accepted because
/// `created: 2024` and `draft: true` are both things vaults write.
fn scalar(node: &Yaml) -> Option<String> {
    let value = match node {
        Yaml::String(s) => s.trim().to_string(),
        Yaml::Integer(i) => i.to_string(),
        Yaml::Real(r) => r.clone(),
        Yaml::Boolean(b) => b.to_string(),
        _ => return None,
    };
    if value.is_empty() {
        None
    } else {
        Some(value)
    }
}

/// A YAML sequence, or a single scalar, or a comma-separated string — all
/// three appear in the wild for `tags:`.
fn string_list(node: &Yaml) -> Vec<String> {
    match node {
        Yaml::Array(items) => items.iter().filter_map(scalar).collect(),
        Yaml::String(s) => s
            .split(',')
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .collect(),
        other => scalar(other).into_iter().collect(),
    }
}

/// Inline `#tag` occurrences, the way Obsidian writes tags in body text.
///
/// Skips fenced code blocks, inline code spans, and anything that looks like a
/// markdown heading (`# Title`) or a URL fragment (`…/page#section`), because
/// none of those are tags and all of them are common.
pub fn extract_inline_tags(body: &str) -> Vec<String> {
    let mut tags: Vec<String> = Vec::new();
    let mut in_fence = false;
    for line in body.lines() {
        let trimmed = line.trim_start();
        if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
            in_fence = !in_fence;
            continue;
        }
        if in_fence || is_heading(trimmed) {
            continue;
        }
        collect_line_tags(line, &mut tags);
    }
    tags.sort();
    tags.dedup();
    tags
}

/// An ATX heading is `#`-`######` followed by whitespace. The trailing space
/// is what separates `# Heading` from `#tag`, and a line may legitimately open
/// with a tag.
fn is_heading(trimmed: &str) -> bool {
    let hashes = trimmed.bytes().take_while(|b| *b == b'#').count();
    (1..=6).contains(&hashes)
        && trimmed[hashes..]
            .chars()
            .next()
            .is_none_or(char::is_whitespace)
}

fn collect_line_tags(line: &str, out: &mut Vec<String>) {
    let bytes = line.as_bytes();
    let mut in_code = false;
    let mut idx = 0usize;
    while idx < bytes.len() {
        let byte = bytes[idx];
        if byte == b'`' {
            in_code = !in_code;
            idx += 1;
            continue;
        }
        if byte != b'#' || in_code {
            idx += 1;
            continue;
        }
        // A `#` glued to the previous character is a URL fragment or a colour
        // literal, not a tag.
        if idx > 0 && !bytes[idx - 1].is_ascii_whitespace() && bytes[idx - 1] != b'(' {
            idx += 1;
            continue;
        }
        let start = idx + 1;
        let mut end = start;
        while end < bytes.len() {
            let ch = bytes[end];
            if ch.is_ascii_alphanumeric() || matches!(ch, b'-' | b'_' | b'/') || ch >= 0x80 {
                end += 1;
            } else {
                break;
            }
        }
        let tag = &line[start..end];
        // A purely numeric "tag" is an issue reference (`#42`).
        if !tag.is_empty() && !tag.bytes().all(|b| b.is_ascii_digit()) {
            out.push(tag.to_string());
        }
        idx = end.max(idx + 1);
    }
}

/// Best-effort title for a note that has no frontmatter title.
///
/// A leading `# Heading` wins over the file name: exporters that write one
/// (`mediawiki-to-markdown` does) put the real page title there, while the
/// file name has been through slugification.
pub fn infer_title(body: &str, fallback: &str) -> String {
    for line in body.lines().take(10) {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        if let Some(heading) = trimmed.strip_prefix("# ") {
            let heading = heading.trim();
            if !heading.is_empty() {
                return heading.to_string();
            }
        }
        break;
    }
    fallback.to_string()
}
