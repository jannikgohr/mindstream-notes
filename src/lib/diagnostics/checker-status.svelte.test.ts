import { beforeEach, describe, expect, it } from 'vitest';
import {
  checkerStatus,
  clearCheckerStatus,
  reportCheckerStatus
} from './checker-status.svelte';

/**
 * Status exists so that "this checker is contributing nothing" stops
 * looking identical to "your document is fine". Three bugs in this feature
 * have had that shape, so the states themselves are the contract.
 */
const ID = 'plugins.com.example.lt.grammar';

beforeEach(() => {
  clearCheckerStatus(ID);
});

describe('checkerStatus', () => {
  it('starts idle for a checker that has never run', () => {
    expect(checkerStatus(ID).state).toBe('idle');
  });

  it('reports the last outcome', () => {
    reportCheckerStatus(ID, 'active');
    expect(checkerStatus(ID).state).toBe('active');
  });

  it('distinguishes unconfigured from failing', () => {
    // Two very different fixes: fill in a URL, or go find out why the
    // server is down.
    reportCheckerStatus(ID, 'unconfigured');
    expect(checkerStatus(ID).state).toBe('unconfigured');

    reportCheckerStatus(ID, 'failed', 'connection refused');
    expect(checkerStatus(ID)).toMatchObject({
      state: 'failed',
      detail: 'connection refused'
    });
  });

  it('keeps a timestamp so staleness is visible', () => {
    reportCheckerStatus(ID, 'active');
    expect(checkerStatus(ID).at).toBeGreaterThan(0);
  });

  it('does not rewrite when nothing changed', () => {
    // Every keystroke drives a check; a write per paragraph per keystroke
    // would redraw the settings pane continuously for no new information.
    reportCheckerStatus(ID, 'active');
    const first = checkerStatus(ID);
    reportCheckerStatus(ID, 'active');
    expect(checkerStatus(ID)).toBe(first);
  });

  it('does rewrite when the detail changes', () => {
    reportCheckerStatus(ID, 'failed', 'connection refused');
    const first = checkerStatus(ID);
    reportCheckerStatus(ID, 'failed', 'timed out');
    expect(checkerStatus(ID)).not.toBe(first);
    expect(checkerStatus(ID).detail).toBe('timed out');
  });

  it('forgets a checker whose plugin unregistered', () => {
    reportCheckerStatus(ID, 'active');
    clearCheckerStatus(ID);
    expect(checkerStatus(ID).state).toBe('idle');
  });

  it('tracks checkers independently', () => {
    const other = 'plugins.com.other.lt.grammar';
    reportCheckerStatus(ID, 'active');
    reportCheckerStatus(other, 'failed', 'nope');
    expect(checkerStatus(ID).state).toBe('active');
    expect(checkerStatus(other).state).toBe('failed');
    clearCheckerStatus(other);
  });
});
