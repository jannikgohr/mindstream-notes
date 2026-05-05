/**
 * Window-management bridge. Spawning a fresh OS-level Tauri window is a
 * Rust-side responsibility (capabilities, asset URL, drag-drop config).
 */

import {WebviewWindow} from "@tauri-apps/api/webviewWindow";

export async function openNoteWindow(id: string, title: string): Promise<void> {
    const win = new WebviewWindow(
        id,
        {
            title: title,
        }
    )
}
