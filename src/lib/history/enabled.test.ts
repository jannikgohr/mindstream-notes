import { describe, expect, it, vi } from 'vitest';

// Real isSupportedNoteKind semantics (built-in kinds + `plugin.<id>.<kind>`),
// without dragging the Tauri-bound `$lib/api` barrel into a unit test.
vi.mock('$lib/api', () => ({
  isSupportedNoteKind: (k: unknown): boolean =>
    typeof k === 'string' &&
    (['markdown', 'freeform', 'ink', 'pdf', 'kanban'].includes(k) ||
      /^plugin\.[a-z0-9-]+(?:\.[a-z0-9-]+){2,}$/.test(k))
}));

const { noteHistoryEnabled } = await import('./enabled');

describe('noteHistoryEnabled', () => {
  it('is on for every built-in kind by default', () => {
    for (const kind of ['markdown', 'freeform', 'ink', 'pdf', 'kanban']) {
      expect(noteHistoryEnabled(kind)).toBe(true);
    }
  });

  it('is on for plugin-owned kinds (e.g. a Typst document)', () => {
    expect(noteHistoryEnabled('plugin.com.mindstream.typst.document')).toBe(
      true
    );
  });

  it('is off for an unsupported or missing kind', () => {
    expect(noteHistoryEnabled('totally-unknown')).toBe(false);
    expect(noteHistoryEnabled(null)).toBe(false);
    expect(noteHistoryEnabled(undefined)).toBe(false);
  });
});
