import { describe, expect, it } from 'vitest';
import { resolveInlineListEdit } from './inline-list-edit';

describe('inline Kanban list editing', () => {
  it('commits a trimmed value only on Enter', () => {
    expect(resolveInlineListEdit('  In progress  ', 'enter')).toEqual({
      type: 'commit',
      value: 'In progress'
    });
  });

  it('cancels on blur', () => {
    expect(resolveInlineListEdit('Uncommitted', 'blur')).toEqual({
      type: 'cancel'
    });
  });

  it('cancels on Escape or an empty Enter', () => {
    expect(resolveInlineListEdit('Uncommitted', 'escape')).toEqual({
      type: 'cancel'
    });
    expect(resolveInlineListEdit('   ', 'enter')).toEqual({ type: 'cancel' });
  });
});
