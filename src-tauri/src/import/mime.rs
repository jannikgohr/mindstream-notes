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

#[cfg(test)]
mod tests {
    use super::{from_path, is_markdown};

    #[test]
    fn maps_supported_attachment_extensions_case_insensitively() {
        let cases = [
            ("image.png", "image/png"),
            ("image.jpg", "image/jpeg"),
            ("image.JPEG", "image/jpeg"),
            ("image.gif", "image/gif"),
            ("image.webp", "image/webp"),
            ("image.avif", "image/avif"),
            ("image.bmp", "image/bmp"),
            ("image.svg", "image/svg+xml"),
            ("image.ico", "image/x-icon"),
            ("image.tif", "image/tiff"),
            ("image.tiff", "image/tiff"),
            ("document.pdf", "application/pdf"),
            ("audio.mp3", "audio/mpeg"),
            ("audio.wav", "audio/wav"),
            ("audio.ogg", "audio/ogg"),
            ("audio.m4a", "audio/mp4"),
            ("video.mp4", "video/mp4"),
            ("video.webm", "video/webm"),
            ("video.mov", "video/quicktime"),
            ("notes.txt", "text/plain"),
            ("table.csv", "text/csv"),
            ("data.json", "application/json"),
            ("archive.zip", "application/zip"),
        ];

        for (path, expected) in cases {
            assert_eq!(from_path(path), expected, "wrong MIME type for {path}");
        }
    }

    #[test]
    fn unknown_or_missing_extensions_use_the_binary_fallback() {
        for path in ["archive.7z", "README", "", ".hidden"] {
            assert_eq!(
                from_path(path),
                "application/octet-stream",
                "wrong fallback for {path}"
            );
        }
    }

    #[test]
    fn recognises_all_supported_markdown_extensions_case_insensitively() {
        for path in ["note.md", "note.markdown", "note.mdown", "NOTE.MKD"] {
            assert!(is_markdown(path), "expected markdown path: {path}");
        }
    }

    #[test]
    fn rejects_non_markdown_and_extensionless_paths() {
        for path in ["note.md.txt", "note", "", ".markdown-file"] {
            assert!(!is_markdown(path), "unexpected markdown path: {path}");
        }
    }
}
