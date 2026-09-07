//! File extension → MIME type, for imported attachments.
//!
//! Deliberately a short table rather than a sniffing crate: the value is only
//! used to set a `Blob`'s type at render time, and the set of things a note
//! vault actually embeds is small. Anything unrecognised gets the generic
//! binary type, which still renders as a downloadable link.

pub fn from_path(path: &str) -> &'static str {
    let extension = path
        .rsplit('.')
        .next()
        .map(str::to_ascii_lowercase)
        .unwrap_or_default();
    match extension.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "bmp" => "image/bmp",
        "svg" => "image/svg+xml",
        "ico" => "image/x-icon",
        "tif" | "tiff" => "image/tiff",
        "pdf" => "application/pdf",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "ogg" => "audio/ogg",
        "m4a" => "audio/mp4",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "mov" => "video/quicktime",
        "txt" => "text/plain",
        "csv" => "text/csv",
        "json" => "application/json",
        "zip" => "application/zip",
        _ => "application/octet-stream",
    }
}

/// Is this a file the import treats as a note rather than an attachment?
pub fn is_markdown(path: &str) -> bool {
    let extension = path
        .rsplit('.')
        .next()
        .map(str::to_ascii_lowercase)
        .unwrap_or_default();
    matches!(extension.as_str(), "md" | "markdown" | "mdown" | "mkd")
}
