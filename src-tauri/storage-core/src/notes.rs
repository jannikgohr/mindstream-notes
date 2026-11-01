//! Note models and read queries shared by the app and browser worker.
use crate::error::{AppError, AppResult};
use crate::serde_helpers::double_option;
use rusqlite::{
    params,
    types::{FromSql, FromSqlError, FromSqlResult, ToSql, ToSqlOutput, ValueRef},
    Connection, OptionalExtension,
};
use serde::{de, Deserialize, Deserializer, Serialize, Serializer};
use std::{collections::HashMap, str::FromStr};

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub enum NoteKind {
    #[default]
    Markdown,
    Freeform,
    Ink,
    Pdf,
    Kanban,
    Plugin(String),
}

impl NoteKind {
    pub fn as_str(&self) -> &str {
        match self {
            Self::Markdown => "markdown",
            Self::Freeform => "freeform",
            Self::Ink => "ink",
            Self::Pdf => "pdf",
            Self::Kanban => "kanban",
            Self::Plugin(kind) => kind.as_str(),
        }
    }

    pub fn is_markdown(&self) -> bool {
        self == &Self::Markdown
    }
}

impl FromStr for NoteKind {
    type Err = AppError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "markdown" => Ok(Self::Markdown),
            "freeform" => Ok(Self::Freeform),
            "ink" => Ok(Self::Ink),
            "pdf" => Ok(Self::Pdf),
            "kanban" => Ok(Self::Kanban),
            value if is_valid_plugin_note_kind(value) => Ok(Self::Plugin(value.to_string())),
            _ => Err(AppError::InvalidArg(format!("unknown note kind {value}"))),
        }
    }
}

fn is_note_kind_segment(segment: &str) -> bool {
    if segment.is_empty() {
        return false;
    }
    let mut chars = segment.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    if !first.is_ascii_lowercase() && !first.is_ascii_digit() {
        return false;
    }
    let mut last = first;
    for ch in chars {
        if !ch.is_ascii_lowercase() && !ch.is_ascii_digit() && ch != '-' {
            return false;
        }
        last = ch;
    }
    last.is_ascii_lowercase() || last.is_ascii_digit()
}

pub fn is_valid_plugin_note_kind(value: &str) -> bool {
    const PREFIX: &str = "plugin.";
    if value.len() > 160 || !value.starts_with(PREFIX) {
        return false;
    }
    let segments: Vec<&str> = value[PREFIX.len()..].split('.').collect();
    if segments.len() < 3 {
        return false;
    }
    segments.into_iter().all(is_note_kind_segment)
}

impl Serialize for NoteKind {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for NoteKind {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Self::from_str(&value).map_err(de::Error::custom)
    }
}

impl From<&str> for NoteKind {
    fn from(value: &str) -> Self {
        Self::from_str(value).unwrap_or(Self::Markdown)
    }
}

impl From<String> for NoteKind {
    fn from(value: String) -> Self {
        Self::from_str(&value).unwrap_or(Self::Markdown)
    }
}

impl PartialEq<&str> for NoteKind {
    fn eq(&self, other: &&str) -> bool {
        self.as_str() == *other
    }
}

impl ToSql for NoteKind {
    fn to_sql(&self) -> rusqlite::Result<ToSqlOutput<'_>> {
        Ok(ToSqlOutput::from(self.as_str().to_string()))
    }
}

impl FromSql for NoteKind {
    fn column_result(value: ValueRef<'_>) -> FromSqlResult<Self> {
        let raw = value.as_str()?;
        Self::from_str(raw).map_err(|err| FromSqlError::Other(Box::new(err)))
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NoteSummary {
    pub id: String,
    pub parent_collection_id: Option<String>,
    pub title: String,
    pub position: i64,
    pub created: String,
    pub modified: String,
    pub tags: Vec<String>,
    pub trashed: bool,
    pub favourite: bool,
    /// True once the note has been pushed to the remote at least once
    /// (i.e. `etebase_uid IS NOT NULL`). The frontend watches this to
    /// know when live collab becomes reachable for a fresh note —
    /// `note_room_info` resolves the room key off the server payload,
    /// which only exists post-push. Doesn't track dirty-ness; a synced
    /// row with unsynced edits still reports `pushed: true`.
    pub pushed: bool,
    /// Discriminator that tells the frontend which editor component to render.
    /// Unknown synced kinds now fail at the DB boundary instead of being treated
    /// as valid typed data.
    #[serde(default = "default_note_kind")]
    pub note_kind: NoteKind,
}

pub fn default_note_kind() -> NoteKind {
    NoteKind::Markdown
}

pub fn default_note_kind_string() -> String {
    default_note_kind().as_str().to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Note {
    #[serde(flatten)]
    pub summary: NoteSummary,
    pub body: String,
    /// Encoded yrs Doc state. Empty for never-edited notes. The editor
    /// uses this to hydrate the y-prosemirror Doc on open.
    #[serde(default)]
    pub yrs_state: Vec<u8>,
    /// 1 = legacy Y.Text format, 2 = y-prosemirror XmlFragment.
    /// The editor reads this to decide whether to migrate.
    #[serde(default = "default_payload_schema")]
    pub payload_schema: u32,
}

fn default_payload_schema() -> u32 {
    1
}

#[derive(Debug, Clone, Deserialize)]
pub struct CreateNote {
    pub title: Option<String>,
    pub body: Option<String>,
    pub parent_collection_id: Option<String>,
    /// Optional discriminator. Omitted ⇒ defaults to "markdown" in
    /// `create()`, matching existing call sites that don't know about
    /// kinds. The frontend sets this for non-markdown note variants such
    /// as drawings, ink notes, and imported PDFs.
    #[serde(default)]
    pub note_kind: Option<NoteKind>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct UpdateNote {
    pub id: String,
    pub title: Option<String>,
    pub body: Option<String>,
    /// Outer Some => change parent. Inner Option is the new value (None = root).
    /// Outer Some => change parent. Inner Option = the new value
    /// (`Some(id)` to a specific folder, `None` for root).
    /// The custom deserializer is needed because plain
    /// `Option<Option<T>>` collapses `null` into outer `None`,
    /// which would silently turn a 'move to root' into a no-op.
    #[serde(default, deserialize_with = "double_option")]
    pub parent_collection_id: Option<Option<String>>,
    pub position: Option<i64>,
    pub tags: Option<Vec<String>>,
    /// When the live-collab editor is driving the save, it supplies the
    /// yrs Doc state alongside the rendered markdown body. Presence of
    /// this field also flips the row's payload_schema to 2, so future
    /// pushes use the v2 NotePayload format. Absence preserves the
    /// legacy Rust-side "diff old vs new markdown into Y.Text" path.
    #[serde(default)]
    pub yrs_state: Option<Vec<u8>>,
    /// Toggle the favourite bit. Some(true)/Some(false) writes; None
    /// leaves the existing value untouched.
    pub favourite: Option<bool>,
}

fn row_to_summary(row: &rusqlite::Row<'_>) -> rusqlite::Result<NoteSummary> {
    let trashed_at: Option<String> = row.get("trashed_at")?;
    let favourite: i64 = row.get("favourite")?;
    let etebase_uid: Option<String> = row.get("etebase_uid")?;
    Ok(NoteSummary {
        id: row.get("id")?,
        parent_collection_id: row.get("parent_collection_id")?,
        title: row.get("title")?,
        position: row.get("position")?,
        created: row.get("created")?,
        modified: row.get("modified")?,
        tags: Vec::new(),
        trashed: trashed_at.is_some(),
        favourite: favourite != 0,
        pushed: etebase_uid.is_some(),
        note_kind: row.get("note_kind")?,
    })
}

pub fn load_tags(conn: &Connection, note_id: &str) -> AppResult<Vec<String>> {
    let mut stmt = conn.prepare("SELECT tag FROM note_tags WHERE note_id = ?1 ORDER BY tag")?;
    let rows = stmt.query_map(params![note_id], |r| r.get::<_, String>(0))?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

/// Every note's tags in one pass, keyed by note id.
///
/// [`list`] used to call [`load_tags`] per row, which re-prepared the same
/// statement and ran a query for every note in the vault — and `list` backs
/// `load_tree`, which the frontend refetches after *every* mutation. One
/// grouped scan replaces N+1 round trips under the global connection lock.
///
/// Notes without tags are simply absent from the map; callers default to an
/// empty vec.
fn load_all_tags(conn: &Connection) -> AppResult<HashMap<String, Vec<String>>> {
    let mut stmt = conn.prepare("SELECT note_id, tag FROM note_tags ORDER BY note_id, tag")?;
    let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
    let mut out: HashMap<String, Vec<String>> = HashMap::new();
    for row in rows {
        let (note_id, tag) = row?;
        out.entry(note_id).or_default().push(tag);
    }
    Ok(out)
}

pub fn list(conn: &Connection, include_trashed: bool) -> AppResult<Vec<NoteSummary>> {
    let sql = if include_trashed {
        "SELECT id, parent_collection_id, title, position, created, modified,
                trashed_at, favourite, etebase_uid, note_kind
         FROM notes
         ORDER BY parent_collection_id IS NOT NULL, parent_collection_id, position, title"
    } else {
        "SELECT id, parent_collection_id, title, position, created, modified,
                trashed_at, favourite, etebase_uid, note_kind
         FROM active_notes
         ORDER BY parent_collection_id IS NOT NULL, parent_collection_id, position, title"
    };
    let mut stmt = conn.prepare(sql)?;
    let rows = stmt.query_map([], row_to_summary)?;
    let mut summaries = rows.collect::<rusqlite::Result<Vec<_>>>()?;
    let mut tags_by_note = load_all_tags(conn)?;
    for s in &mut summaries {
        s.tags = tags_by_note.remove(&s.id).unwrap_or_default();
    }
    Ok(summaries)
}

pub fn load_yrs_state(conn: &Connection, id: &str) -> AppResult<Vec<u8>> {
    let state: Option<Option<Vec<u8>>> = conn
        .query_row(
            "SELECT yrs_state FROM notes WHERE id = ?1",
            params![id],
            |row| row.get::<_, Option<Vec<u8>>>(0),
        )
        .optional()?;
    Ok(state.flatten().unwrap_or_default())
}

pub fn load(conn: &Connection, id: &str) -> AppResult<Note> {
    let mut stmt = conn.prepare(
        "SELECT id, parent_collection_id, title, position, created, modified,
                trashed_at, favourite, etebase_uid, note_kind,
                body, yrs_state, payload_schema
         FROM notes WHERE id = ?1",
    )?;
    let row_data = stmt
        .query_row(params![id], |row| {
            let summary = row_to_summary(row)?;
            let body: String = row.get("body")?;
            let yrs_state: Option<Vec<u8>> = row.get("yrs_state")?;
            let payload_schema: i64 = row.get("payload_schema")?;
            Ok((summary, body, yrs_state, payload_schema))
        })
        .optional()?;

    match row_data {
        Some((mut summary, body, yrs_state, payload_schema)) => {
            summary.tags = load_tags(conn, id)?;
            Ok(Note {
                summary,
                body,
                yrs_state: yrs_state.unwrap_or_default(),
                payload_schema: payload_schema.max(1) as u32,
            })
        }
        None => Err(AppError::NotFound(format!("note {id}"))),
    }
}
