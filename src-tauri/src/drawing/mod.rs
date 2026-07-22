//! Ink note bridge.
//!
//! The canonical ink editor is the Svelte/Pointer Events canvas on every
//! platform. Persistence is a single `drawing_save_ink_state` IPC that
//! merges the editor's Yrs/Yjs v1 update bytes into the note row through
//! the same `notes::save_yrs_state` helper sync uses.
//!
//! Android keeps a Kotlin `SurfaceView` live-ink overlay for the
//! in-flight wet stroke only; committed strokes and persistence stay in
//! JS/Rust save commands. The commands in this module are control-plane
//! only — they call into Kotlin via JNI and are no-ops on desktop.

#[cfg(target_os = "android")]
pub mod platform;

use crate::error::{CommandError, CommandErrorCode, CommandResult};

/// Persist an ink note state update through the same merge/write path
/// sync uses. The editor sends Yrs/Yjs v1 update bytes; Rust merges
/// them into the existing row's `yrs_state` and bumps `dirty`.
#[tauri::command]
pub fn drawing_save_ink_state(
    db: tauri::State<'_, crate::db::Db>,
    note_id: String,
    yrs_state: Vec<u8>,
) -> CommandResult<()> {
    db.with_conn_mut(|c| crate::notes::save_yrs_state(c, &note_id, &yrs_state))
        .map_err(|e| format!("drawing_save_ink_state: {e}"))?
        .then_some(())
        .ok_or_else(|| {
            CommandError::new(
                CommandErrorCode::NotFound,
                format!("drawing_save_ink_state: note {note_id} not found"),
            )
        })
}

#[tauri::command]
pub fn drawing_show_live_ink_overlay() -> CommandResult<()> {
    #[cfg(target_os = "android")]
    {
        Ok(platform::android::ui::call_show_live_overlay()
            .map_err(|e| format!("drawing_show_live_ink_overlay: {e}"))?)
    }
    #[cfg(not(target_os = "android"))]
    {
        Ok(())
    }
}

#[tauri::command]
pub fn drawing_hide_live_ink_overlay() -> CommandResult<()> {
    #[cfg(target_os = "android")]
    {
        Ok(platform::android::ui::call_hide_live_overlay()
            .map_err(|e| format!("drawing_hide_live_ink_overlay: {e}"))?)
    }
    #[cfg(not(target_os = "android"))]
    {
        Ok(())
    }
}

#[tauri::command]
pub fn drawing_enter_immersive_ink_mode() -> CommandResult<()> {
    #[cfg(target_os = "android")]
    {
        Ok(platform::android::ui::call_enter_immersive_ink_mode()
            .map_err(|e| format!("drawing_enter_immersive_ink_mode: {e}"))?)
    }
    #[cfg(not(target_os = "android"))]
    {
        Ok(())
    }
}

#[tauri::command]
pub fn drawing_exit_immersive_ink_mode() -> CommandResult<()> {
    #[cfg(target_os = "android")]
    {
        Ok(platform::android::ui::call_exit_immersive_ink_mode()
            .map_err(|e| format!("drawing_exit_immersive_ink_mode: {e}"))?)
    }
    #[cfg(not(target_os = "android"))]
    {
        Ok(())
    }
}

#[tauri::command]
pub fn drawing_cancel_live_ink() -> CommandResult<()> {
    #[cfg(target_os = "android")]
    {
        Ok(platform::android::ui::call_cancel_live_ink()
            .map_err(|e| format!("drawing_cancel_live_ink: {e}"))?)
    }
    #[cfg(not(target_os = "android"))]
    {
        Ok(())
    }
}

#[tauri::command]
pub fn drawing_set_live_ink_style(
    color_argb: u32,
    min_width_px: f32,
    max_width_px: f32,
) -> CommandResult<()> {
    #[cfg(target_os = "android")]
    {
        platform::android::ui::call_set_live_ink_style(color_argb, min_width_px, max_width_px)
            .map_err(|e| format!("drawing_set_live_ink_style: {e}"))?;
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (color_argb, min_width_px, max_width_px);
    }
    Ok(())
}

/// Push the screen-space bounds of the ink document's visible pages
/// to Kotlin's live overlay — the only region it's allowed to paint
/// in. Flat list of `[x0, y0, x1, y1, …]` quads in webview-local
/// surface pixels. Pass an empty list to disable painting entirely
/// (trashed note, layout not yet computed). No-op on desktop.
#[tauri::command]
pub fn drawing_set_document_bounds(bounds: Vec<f32>) -> CommandResult<()> {
    #[cfg(target_os = "android")]
    {
        Ok(platform::android::ui::call_set_document_bounds(&bounds)
            .map_err(|e| format!("drawing_set_document_bounds: {e}"))?)
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = bounds;
        Ok(())
    }
}

/// Push the screen-space bounds of Svelte UI controls (toolbar,
/// popovers, …) to Kotlin's live overlay so it refuses to paint over
/// them. `bounds` is a flat list of `[x0, y0, x1, y1, x0', y0', …]`
/// rectangles in webview-local surface pixels — what JS gets from
/// `getBoundingClientRect()` multiplied by `devicePixelRatio`. Pass
/// an empty list to clear. No-op on desktop.
#[tauri::command]
pub fn drawing_set_control_bounds(bounds: Vec<f32>) -> CommandResult<()> {
    #[cfg(target_os = "android")]
    {
        Ok(platform::android::ui::call_set_control_bounds(&bounds)
            .map_err(|e| format!("drawing_set_control_bounds: {e}"))?)
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = bounds;
        Ok(())
    }
}

#[tauri::command]
pub fn drawing_set_live_ink_finger_drawing(allowed: bool) -> CommandResult<()> {
    #[cfg(target_os = "android")]
    {
        platform::android::ui::call_set_finger_drawing_allowed(allowed)
            .map_err(|e| format!("drawing_set_live_ink_finger_drawing: {e}"))?;
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = allowed;
    }
    Ok(())
}
