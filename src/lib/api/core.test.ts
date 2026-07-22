import { describe, expect, it } from 'vitest';
import { TauriCommandName } from './core';

describe('TauriCommandName', () => {
  it('matches Rust command wire names across API surfaces', () => {
    expect(TauriCommandName.EtebaseLogin).toBe('etebase_login');
    expect(TauriCommandName.SaveNote).toBe('save_note');
    expect(TauriCommandName.SetSyncSchedule).toBe('set_sync_schedule');
    expect(TauriCommandName.ListSignatures).toBe('list_signatures');
    expect(TauriCommandName.NotesExportWriteFile).toBe(
      'notes_export_write_file'
    );
  });
});
