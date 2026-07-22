import { invoke as tauriInvoke } from '@tauri-apps/api/core';

export enum CommandErrorCode {
  Database = 'database',
  Io = 'io',
  NotFound = 'notFound',
  InvalidArgument = 'invalidArgument',
  Tauri = 'tauri',
  Task = 'task',
  Unknown = 'unknown'
}

export interface CommandError {
  code: CommandErrorCode;
  message: string;
}

export enum TauriCommandName {
  AcceptCollectionInvitation = 'accept_collection_invitation',
  AcceptShareBundle = 'accept_share_bundle',
  AuditCorruptRemoteItems = 'audit_corrupt_remote_items',
  BackupNow = 'backup_now',
  CaptureCurrentNoteVersion = 'capture_current_note_version',
  CaptureNoteVersion = 'capture_note_version',
  CheckEtebaseServerUrl = 'check_etebase_server_url',
  CreateCollection = 'create_collection',
  CreateNote = 'create_note',
  CreateProfile = 'create_profile',
  DeclineShareBundle = 'decline_share_bundle',
  DeleteCollection = 'delete_collection',
  DeleteProfile = 'delete_profile',
  DeleteSignature = 'delete_signature',
  DrawingCancelLiveInk = 'drawing_cancel_live_ink',
  DrawingEnterImmersiveInkMode = 'drawing_enter_immersive_ink_mode',
  DrawingExitImmersiveInkMode = 'drawing_exit_immersive_ink_mode',
  DrawingHideLiveInkOverlay = 'drawing_hide_live_ink_overlay',
  DrawingSaveInkState = 'drawing_save_ink_state',
  DrawingSetControlBounds = 'drawing_set_control_bounds',
  DrawingSetDocumentBounds = 'drawing_set_document_bounds',
  DrawingSetLiveInkFingerDrawing = 'drawing_set_live_ink_finger_drawing',
  DrawingSetLiveInkStyle = 'drawing_set_live_ink_style',
  DrawingShowLiveInkOverlay = 'drawing_show_live_ink_overlay',
  E2eAcceptShareManifestOnly = 'e2e_accept_share_manifest_only',
  E2eCreateIncompleteShareBundle = 'e2e_create_incomplete_share_bundle',
  E2eCreateStandaloneCollectionInvite = 'e2e_create_standalone_collection_invite',
  EmptyTrash = 'empty_trash',
  EtebaseLogin = 'etebase_login',
  EtebaseLogout = 'etebase_logout',
  EtebaseSession = 'etebase_session',
  FetchDrawingAsset = 'fetch_drawing_asset',
  GetCloseToTray = 'get_close_to_tray',
  GetCollectionShareState = 'get_collection_share_state',
  GetCustomWindowDecorations = 'get_custom_window_decorations',
  GetDesktopLanguage = 'get_desktop_language',
  GetDesktopThemeMode = 'get_desktop_theme_mode',
  GetHotkeyDisplay = 'get_hotkey_display',
  GetStartInTray = 'get_start_in_tray',
  ImportBegin = 'import_begin',
  ImportCleanup = 'import_cleanup',
  ImportMerge = 'import_merge',
  ImportPdfNote = 'import_pdf_note',
  ImportRestore = 'import_restore',
  InviteCollection = 'invite_collection',
  IsAppimageInstall = 'is_appimage_install',
  LeaveSharedCollection = 'leave_shared_collection',
  ListCollectionInvitations = 'list_collection_invitations',
  ListCollectionMembers = 'list_collection_members',
  ListCollections = 'list_collections',
  ListIncomingShareBundles = 'list_incoming_share_bundles',
  ListNoteVersions = 'list_note_versions',
  ListNotes = 'list_notes',
  ListProfiles = 'list_profiles',
  ListSignatures = 'list_signatures',
  LoadNote = 'load_note',
  LoadNoteVersion = 'load_note_version',
  MoveMany = 'move_many',
  NoteRoomInfo = 'note_room_info',
  NoteWordCount = 'note_word_count',
  NotesExportPickDir = 'notes_export_pick_dir',
  NotesExportWriteFile = 'notes_export_write_file',
  OpenDataFolder = 'open_data_folder',
  OpenFolder = 'open_folder',
  PdfNoteNeedsText = 'pdf_note_needs_text',
  PdfNotesMissingText = 'pdf_notes_missing_text',
  PruneNoteVersions = 'prune_note_versions',
  PurgeCorruptRemoteNote = 'purge_corrupt_remote_note',
  PurgeMany = 'purge_many',
  PurgeNote = 'purge_note',
  RejectCollectionInvitation = 'reject_collection_invitation',
  RemoveCollectionMember = 'remove_collection_member',
  RenameProfile = 'rename_profile',
  RestartApp = 'restart_app',
  RestoreMany = 'restore_many',
  RestoreNote = 'restore_note',
  SaveNote = 'save_note',
  SavePdfExport = 'save_pdf_export',
  SaveSignature = 'save_signature',
  SearchNotes = 'search_notes',
  SetCloseToTray = 'set_close_to_tray',
  SetCollectionMemberAccess = 'set_collection_member_access',
  SetCustomWindowDecorations = 'set_custom_window_decorations',
  SetDesktopLanguage = 'set_desktop_language',
  SetDesktopThemeMode = 'set_desktop_theme_mode',
  SetHotkeyDisplays = 'set_hotkey_displays',
  SetPdfText = 'set_pdf_text',
  SetStartInTray = 'set_start_in_tray',
  SetSyncSchedule = 'set_sync_schedule',
  SetTrashRetention = 'set_trash_retention',
  StopSharingCollection = 'stop_sharing_collection',
  SweepTrashRetention = 'sweep_trash_retention',
  SweepUnreferencedMarkdownAssets = 'sweep_unreferenced_markdown_assets',
  SwitchProfile = 'switch_profile',
  SyncGlobalShortcuts = 'sync_global_shortcuts',
  SyncNow = 'sync_now',
  TrashCounts = 'trash_counts',
  TrashMany = 'trash_many',
  TrashNote = 'trash_note',
  UpdateCollection = 'update_collection',
  UploadDrawingAsset = 'upload_drawing_asset'
}

export type IpcValidator<T> = (value: unknown) => T;

export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

export async function invokeOrFallback<T>(
  command: TauriCommandName,
  args: Record<string, unknown> | undefined,
  fallback: () => T | Promise<T>,
  validate: IpcValidator<T>
): Promise<T> {
  if (!isTauri()) return await fallback();
  return validate(await tauriInvoke<unknown>(command, args));
}

export function assertRecord(
  value: unknown,
  context: string
): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${context} must be an object`);
  }
  return value as Record<string, unknown>;
}

export function assertString(value: unknown, context: string): string {
  if (typeof value !== 'string') throw new Error(`${context} must be a string`);
  return value;
}

export function assertNumber(value: unknown, context: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${context} must be a finite number`);
  }
  return value;
}

export function assertBoolean(value: unknown, context: string): boolean {
  if (typeof value !== 'boolean') {
    throw new Error(`${context} must be a boolean`);
  }
  return value;
}

export function assertVoid(value: unknown, context: string): void {
  if (value !== null && value !== undefined) {
    throw new Error(`${context} must not return a value`);
  }
}

export function assertStringArray(value: unknown, context: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${context} must be an array`);
  return value.map((item, index) => assertString(item, `${context}[${index}]`));
}

export function assertNumberArray(value: unknown, context: string): number[] {
  if (!Array.isArray(value)) throw new Error(`${context} must be an array`);
  return value.map((item, index) => assertNumber(item, `${context}[${index}]`));
}

export function optionalString(value: unknown, context: string): string | null {
  if (value === null || value === undefined) return null;
  return assertString(value, context);
}
