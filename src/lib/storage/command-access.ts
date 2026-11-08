/**
 * Which backend commands write storage.
 *
 * `invokeOrFallback` holds every `write` command until the vault access gate
 * opens (see `vault-access.svelte.ts`). The table is exhaustive over
 * `TauriCommandName`, so a new command does not compile until someone decides
 * whether it writes. When unsure, choose `write`: the cost is waiting for the
 * vault to load, not losing data.
 *
 *   - `read`: changes nothing that persists.
 *   - `write`: changes the vault, the app's settings or data, an account, or
 *     anything else another window reads back.
 *   - `exempt`: touches none of that. Window and OS integration, dialogs,
 *     files the user picked for an export, and the steps a window takes to
 *     open its vault in the first place.
 */

import type { TauriCommandName } from '$lib/api/core';

export type CommandAccess = 'read' | 'write' | 'exempt';

const COMMAND_ACCESS: Record<`${TauriCommandName}`, CommandAccess> = {
  // Vault and window lifecycle: how a window gets to the point of owning its
  // vault, or hands it back.
  initialize_ui_settings: 'exempt',
  vault_worker_ready: 'exempt',
  vault_worker_failed: 'exempt',
  vault_window_close_ready: 'exempt',
  vault_window_close_ack: 'exempt',
  open_picker_vault: 'exempt',
  open_profile_window: 'exempt',
  restart_app: 'exempt',
  install_coordinated_update: 'exempt',

  // Window, OS and runtime state that is not stored.
  drawing_cancel_live_ink: 'exempt',
  drawing_enter_immersive_ink_mode: 'exempt',
  drawing_exit_immersive_ink_mode: 'exempt',
  drawing_hide_live_ink_overlay: 'exempt',
  drawing_set_control_bounds: 'exempt',
  drawing_set_document_bounds: 'exempt',
  drawing_set_live_ink_finger_drawing: 'exempt',
  drawing_set_live_ink_style: 'exempt',
  drawing_show_live_ink_overlay: 'exempt',
  set_hotkey_displays: 'exempt',
  sync_global_shortcuts: 'exempt',
  spellcheck_release_dictionaries: 'exempt',
  take_pending_invite_link: 'exempt',
  plugins_preview_start: 'exempt',
  plugins_preview_update: 'exempt',
  plugins_preview_stop: 'exempt',
  plugins_run_native_tool: 'exempt',
  notes_import_cancel: 'exempt',
  notes_import_running: 'exempt',

  // Dialogs, folders and files the user picked, outside the vault.
  open_data_folder: 'exempt',
  open_folder: 'exempt',
  notes_export_pick_dir: 'exempt',
  export_begin: 'exempt',
  export_write: 'exempt',
  export_finish: 'exempt',
  export_abort: 'exempt',
  notes_import_pick_file: 'exempt',
  notes_import_pick_folder: 'exempt',
  account_save_secret_file: 'exempt',

  // Reads.
  get_onboarding: 'read',
  list_theme_presets: 'read',
  get_theme_appearance: 'read',
  account_security_status: 'read',
  account_server_info: 'read',
  account_sessions: 'read',
  audit_corrupt_remote_items: 'read',
  check_etebase_server_url: 'read',
  check_coordinated_update: 'read',
  custom_dictionary_list: 'read',
  etebase_session: 'read',
  fetch_drawing_asset: 'read',
  fetch_asset_bytes: 'read',
  export_copy_asset: 'read',
  export_asset_types: 'read',
  get_close_to_tray: 'read',
  get_collection_share_state: 'read',
  get_custom_window_decorations: 'read',
  get_worker_browser_options: 'read',
  get_vault_window_state: 'read',
  get_picker_vaults: 'read',
  get_desktop_language: 'read',
  get_desktop_theme_mode: 'read',
  get_hotkey_display: 'read',
  get_start_in_tray: 'read',
  get_start_on_login: 'read',
  get_global_shortcut_status: 'read',
  // Reads the cached text; with a `text` argument it stores it instead, see
  // `commandWrites`.
  pdf_page_text: 'read',
  is_appimage_install: 'read',
  text_checker_check: 'read',
  text_checker_test_connection: 'read',
  list_collection_members: 'read',
  legacy_wikilink_count: 'read',
  list_collections: 'read',
  list_incoming_shares: 'read',
  list_note_versions: 'read',
  list_notes: 'read',
  list_share_links: 'read',
  list_profiles: 'read',
  list_signatures: 'read',
  load_note: 'read',
  load_tree: 'read',
  load_ui_settings: 'read',
  load_note_version: 'read',
  note_room_info: 'read',
  note_room_ticket: 'read',
  note_word_count: 'read',
  notes_import_detect: 'read',
  open_share_link: 'read',
  own_key_fingerprint: 'read',
  pdf_note_needs_text: 'read',
  pdf_notes_missing_text: 'read',
  plugins_artifacts_status: 'read',
  plugins_get: 'read',
  plugins_list: 'read',
  plugins_native_service_status: 'read',
  plugins_native_tool_status: 'read',
  plugins_read_artifact: 'read',
  plugins_read_file: 'read',
  // Scripts only compute; the app performs any effect they return.
  plugins_run_script: 'read',
  plugins_settings_all: 'read',
  search_notes: 'read',
  spellcheck_available_dictionaries: 'read',
  spellcheck_installed_dictionaries: 'read',
  spellcheck_suggest: 'read',
  spellcheck_unknown_words: 'read',
  spellcheck_word_chars: 'read',
  trash_counts: 'read',
  user_key_info: 'read',

  // Writes.
  restart_onboarding: 'write',
  save_onboarding_step: 'write',
  finish_onboarding: 'write',
  save_theme_preset: 'write',
  delete_theme_preset: 'write',
  accept_share: 'write',
  account_begin_authenticator: 'write',
  account_change_password: 'write',
  account_confirm_authenticator: 'write',
  account_end_other_sessions: 'write',
  account_end_session: 'write',
  account_new_backup_codes: 'write',
  account_new_recovery_key: 'write',
  account_recover: 'write',
  account_remove_authenticator: 'write',
  account_signup: 'write',
  backup_now: 'write',
  capture_current_note_version: 'write',
  capture_note_version: 'write',
  claim_share_link: 'write',
  create_collection: 'write',
  convert_legacy_wikilinks_command: 'write',
  create_note: 'write',
  create_share_link: 'write',
  create_profile: 'write',
  custom_dictionary_add: 'write',
  custom_dictionary_remove: 'write',
  decline_share: 'write',
  delete_collection: 'write',
  delete_profile: 'write',
  delete_signature: 'write',
  drawing_save_ink_state: 'write',
  e2e_create_standalone_collection_invite: 'write',
  empty_trash: 'write',
  etebase_login: 'write',
  etebase_logout: 'write',
  upload_asset_bytes: 'write',
  import_pdf_note_bytes: 'write',
  import_begin: 'write',
  import_cleanup: 'write',
  import_merge: 'write',
  import_pdf_note: 'write',
  import_ink_pdf_note: 'write',
  import_restore: 'write',
  invite_collection: 'write',
  leave_shared_collection: 'write',
  move_many: 'write',
  migrate_legacy_content: 'write',
  patch_ui_setting: 'write',
  notes_import_run: 'write',
  plugins_approve: 'write',
  plugins_disable: 'write',
  // Discovery records what it finds.
  plugins_discover: 'write',
  plugins_download_artifact: 'write',
  plugins_enable: 'write',
  plugins_remove: 'write',
  plugins_install: 'write',
  plugins_set_load_error: 'write',
  plugins_settings_remove: 'write',
  plugins_settings_set: 'write',
  prune_note_versions: 'write',
  purge_corrupt_remote_note: 'write',
  purge_many: 'write',
  purge_note: 'write',
  remove_collection_member: 'write',
  revoke_share_link: 'write',
  rename_profile: 'write',
  restore_many: 'write',
  restore_note: 'write',
  save_note: 'write',
  save_signature: 'write',
  set_close_to_tray: 'write',
  set_collection_member_access: 'write',
  set_custom_window_decorations: 'write',
  set_desktop_language: 'write',
  set_desktop_theme_mode: 'write',
  set_pdf_text: 'write',
  set_start_in_tray: 'write',
  set_start_on_login: 'write',
  // Starts scheduled syncs, which write the vault.
  set_sync_schedule: 'write',
  set_trash_retention: 'write',
  spellcheck_install_dictionary: 'write',
  spellcheck_remove_dictionary: 'write',
  stop_sharing_collection: 'write',
  sweep_trash_retention: 'write',
  sweep_unreferenced_markdown_assets: 'write',
  switch_profile: 'write',
  sync_now: 'write',
  trash_many: 'write',
  trash_note: 'write',
  update_collection: 'write',
  upload_drawing_asset: 'write'
};

/** True when `command` has to wait for the vault access gate. */
/** Read commands that write when called with this argument. */
const WRITES_WITH_ARGUMENT: Partial<Record<`${TauriCommandName}`, string>> = {
  pdf_page_text: 'text'
};

export function commandWrites(
  command: `${TauriCommandName}`,
  args?: unknown
): boolean {
  const argument = WRITES_WITH_ARGUMENT[command];
  if (
    argument &&
    typeof args === 'object' &&
    args !== null &&
    (args as Record<string, unknown>)[argument] !== undefined
  )
    return true;
  return (
    COMMAND_ACCESS[command] !== 'read' && COMMAND_ACCESS[command] !== 'exempt'
  );
}

export function commandAccess(command: `${TauriCommandName}`): CommandAccess {
  return COMMAND_ACCESS[command];
}
