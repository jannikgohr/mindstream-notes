/**
 * Migration walker behaviour + authoring-rule enforcement.
 *
 * Two angles:
 *
 *   1. `applyMigrations` is a pure function over a values map and a
 *      migration table. Drive it with synthetic input to exercise
 *      every branch (move, skip, conflict-with-existing, no-op)
 *      without touching the live settings store.
 *
 *   2. The canonical `MIGRATIONS` table has rules: targets must be
 *      real command ids, sources must NOT be, no chains. Violations
 *      land here as failed expects rather than a runtime surprise
 *      after the rename PR merges.
 */
import { describe, expect, it } from 'vitest';
import { applyMigrations, MIGRATIONS } from './migrations';
import { COMMAND_BY_ID } from './catalogue';

describe('applyMigrations', () => {
  it('moves the old key to the new one when only the old exists', () => {
    const values: Record<string, unknown> = {
      'hotkey.old.id': 'mod+x'
    };
    applyMigrations(values, { 'old.id': 'new.id' });
    expect(values).toEqual({ 'hotkey.new.id': 'mod+x' });
  });

  it('preserves the new value and drops the old when both exist', () => {
    // User upgraded once (old → new), then changed the binding on
    // new. A second hydrate must not overwrite their later choice.
    const values: Record<string, unknown> = {
      'hotkey.old.id': 'mod+x',
      'hotkey.new.id': 'mod+y'
    };
    applyMigrations(values, { 'old.id': 'new.id' });
    expect(values).toEqual({ 'hotkey.new.id': 'mod+y' });
  });

  it('is a no-op when the old key is absent', () => {
    const values: Record<string, unknown> = {
      'hotkey.new.id': 'mod+y'
    };
    applyMigrations(values, { 'old.id': 'new.id' });
    expect(values).toEqual({ 'hotkey.new.id': 'mod+y' });
  });

  it('preserves explicit null (the unset signal) when moving', () => {
    const values: Record<string, unknown> = { 'hotkey.old.id': null };
    applyMigrations(values, { 'old.id': 'new.id' });
    expect(values).toEqual({ 'hotkey.new.id': null });
  });

  it('processes every entry in the table', () => {
    const values: Record<string, unknown> = {
      'hotkey.a': 'mod+a',
      'hotkey.b': 'mod+b'
    };
    applyMigrations(values, { a: 'a2', b: 'b2' });
    expect(values).toEqual({ 'hotkey.a2': 'mod+a', 'hotkey.b2': 'mod+b' });
  });

  it('leaves unrelated keys alone', () => {
    const values: Record<string, unknown> = {
      'hotkey.old.id': 'mod+x',
      'hotkey.unrelated': 'mod+u',
      'unrelated.entirely': 42
    };
    applyMigrations(values, { 'old.id': 'new.id' });
    expect(values).toEqual({
      'hotkey.new.id': 'mod+x',
      'hotkey.unrelated': 'mod+u',
      'unrelated.entirely': 42
    });
  });
});

describe('MIGRATIONS authoring rules', () => {
  // These tests pass trivially while MIGRATIONS is empty, but they
  // become the guardrails the moment a rename ships. The error
  // messages are written so a failing CI tells the author exactly
  // what to fix.

  it('every target is a real command id', () => {
    const invalidTargets: string[] = [];
    for (const [oldId, newId] of Object.entries(MIGRATIONS)) {
      if (!(newId in COMMAND_BY_ID)) {
        invalidTargets.push(`${oldId} → ${newId} (target not in catalogue)`);
      }
    }
    expect(invalidTargets).toEqual([]);
  });

  it('no source is a live command id', () => {
    // A live command id cannot also be the "old name" of another
    // command — the matcher would dispatch the live one and the
    // migration would be unreachable. Catch the contradiction at
    // PR review.
    const liveSources: string[] = [];
    for (const oldId of Object.keys(MIGRATIONS)) {
      if (oldId in COMMAND_BY_ID) liveSources.push(oldId);
    }
    expect(liveSources).toEqual([]);
  });

  it('no chains: a source must not appear as another target', () => {
    // Chains are tempting (A → B, B → C means a very-old A can hop
    // to current C) but introduce ordering hazards. Authors should
    // express the chain as two direct entries: A → C, B → C.
    const targets = new Set(Object.values(MIGRATIONS));
    const chained: string[] = [];
    for (const source of Object.keys(MIGRATIONS)) {
      if (targets.has(source)) chained.push(source);
    }
    expect(chained).toEqual([]);
  });

  it('no self-references', () => {
    const selves: string[] = [];
    for (const [oldId, newId] of Object.entries(MIGRATIONS)) {
      if (oldId === newId) selves.push(oldId);
    }
    expect(selves).toEqual([]);
  });
});
