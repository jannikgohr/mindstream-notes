import { describe, expect, it } from 'vitest';
import { TauriCommandName } from '$lib/api/core';
import { commandAccess, commandWrites } from './command-access';

describe('command access', () => {
  it('classifies every command', () => {
    for (const command of Object.values(TauriCommandName))
      expect(['read', 'write', 'exempt'], command).toContain(
        commandAccess(command)
      );
  });

  it('holds writes and lets reads, lifecycle and window commands through', () => {
    expect(commandWrites('save_note')).toBe(true);
    expect(commandWrites('patch_ui_setting')).toBe(true);
    expect(commandWrites('load_tree')).toBe(false);
    expect(commandWrites('vault_worker_ready')).toBe(false);
    expect(commandWrites('open_folder')).toBe(false);
  });

  it('holds a read command that stores what it was given', () => {
    expect(commandWrites('pdf_page_text', { assetId: 'a', pageIndex: 0 })).toBe(
      false
    );
    expect(
      commandWrites('pdf_page_text', { assetId: 'a', pageIndex: 0, text: '' })
    ).toBe(true);
  });

  it('treats a command missing from the table as a write', () => {
    expect(commandWrites('not_a_command' as 'load_tree')).toBe(true);
  });
});
