use mindstream_storage_core::{error::AppResult, migrations};
use rusqlite::Connection;

/// Only the isolated Pages demo receives these notes, on creation or reset.
pub fn seed(conn: &Connection) -> AppResult<()> {
    let now = chrono::Utc::now().to_rfc3339();
    for (position, (id, title, body)) in [
        ("demo_welcome", "Welcome", include_str!("demo/welcome.md")),
        ("demo_week", "Plan your week", include_str!("demo/week.md")),
        ("demo_ideas", "Ideas", include_str!("demo/ideas.md")),
    ]
    .into_iter()
    .enumerate()
    {
        migrations::insert_note(conn, id, title, body, None, position as i64, &now)?;
    }
    Ok(())
}
