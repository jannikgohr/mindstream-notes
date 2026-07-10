import { describe, expect, it } from 'vitest';
import {
  CUSTOM_WINDOW_DECORATIONS_CHANGED_EVENT,
  CUSTOM_WINDOW_DECORATIONS_SETTING_ID,
  customWindowDecorationsFromEventPayload,
  defaultCustomWindowDecorations
} from './chrome-preferences';

describe('window chrome preferences', () => {
  it('defaults to native decorations on macOS', () => {
    expect(defaultCustomWindowDecorations('macos')).toBe(false);
  });

  it.each(['windows', 'linux', 'freebsd', 'android', 'ios', null] as const)(
    'defaults to custom decorations on %s',
    (platform) => {
      expect(defaultCustomWindowDecorations(platform)).toBe(true);
    }
  );

  it('coerces native event payloads to a strict boolean', () => {
    expect(customWindowDecorationsFromEventPayload(true)).toBe(true);
    expect(customWindowDecorationsFromEventPayload(false)).toBe(false);
    expect(customWindowDecorationsFromEventPayload('true')).toBe(false);
    expect(customWindowDecorationsFromEventPayload(1)).toBe(false);
  });

  it('keeps the Rust/frontend contract ids stable', () => {
    expect(CUSTOM_WINDOW_DECORATIONS_CHANGED_EVENT).toBe(
      'custom-window-decorations-changed'
    );
    expect(CUSTOM_WINDOW_DECORATIONS_SETTING_ID).toBe(
      'appearance.customWindowDecorations'
    );
  });
});
