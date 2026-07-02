import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  prefersReducedMotion,
  reduceMotionSetting,
  setOsPrefersReducedMotionForTesting
} from './reduce-motion.svelte';
import { settings } from './settings/store.svelte';

beforeEach(() => {
  for (const key of Object.keys(settings.values)) delete settings.values[key];
  localStorage.clear();
  setOsPrefersReducedMotionForTesting(false);
});

describe('reduceMotionSetting', () => {
  it('defaults to system when nothing is stored', () => {
    expect(reduceMotionSetting()).toBe('system');
  });

  it('passes through the tri-state values', () => {
    settings.values['appearance.reduceMotion'] = 'on';
    expect(reduceMotionSetting()).toBe('on');
    settings.values['appearance.reduceMotion'] = 'off';
    expect(reduceMotionSetting()).toBe('off');
    settings.values['appearance.reduceMotion'] = 'system';
    expect(reduceMotionSetting()).toBe('system');
  });

  it('coerces the legacy boolean values', () => {
    settings.values['appearance.reduceMotion'] = true;
    expect(reduceMotionSetting()).toBe('on');
    // Legacy `false` meant "no app override, OS pref still honoured".
    settings.values['appearance.reduceMotion'] = false;
    expect(reduceMotionSetting()).toBe('system');
  });

  it('treats garbage values as system', () => {
    settings.values['appearance.reduceMotion'] = 'sometimes';
    expect(reduceMotionSetting()).toBe('system');
  });
});

describe('prefersReducedMotion', () => {
  it('follows the OS preference when set to system', () => {
    settings.values['appearance.reduceMotion'] = 'system';
    expect(prefersReducedMotion()).toBe(false);
    setOsPrefersReducedMotionForTesting(true);
    expect(prefersReducedMotion()).toBe(true);
  });

  it('lets "on" force reduced motion even when the OS allows motion', () => {
    settings.values['appearance.reduceMotion'] = 'on';
    setOsPrefersReducedMotionForTesting(false);
    expect(prefersReducedMotion()).toBe(true);
  });

  it('lets "off" force motion even when the OS prefers reduced', () => {
    settings.values['appearance.reduceMotion'] = 'off';
    setOsPrefersReducedMotionForTesting(true);
    expect(prefersReducedMotion()).toBe(false);
  });

  it('tracks matchMedia change events when the module boots with a media query', async () => {
    const originalMatchMedia = window.matchMedia;
    const listeners: Array<(event: MediaQueryListEvent) => void> = [];

    vi.resetModules();
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: () => {
        const query: MediaQueryList = {
          matches: false,
          media: '(prefers-reduced-motion: reduce)',
          onchange: null,
          addEventListener: (
            _type: string,
            listener: EventListenerOrEventListenerObject
          ) => {
            if (typeof listener === 'function') {
              listeners.push(listener as (event: MediaQueryListEvent) => void);
            }
          },
          removeEventListener: vi.fn(),
          addListener: vi.fn(),
          removeListener: vi.fn(),
          dispatchEvent: vi.fn()
        };
        return query;
      }
    });

    try {
      const { settings: freshSettings } =
        await import('./settings/store.svelte');
      const motion = await import('./reduce-motion.svelte');

      freshSettings.values['appearance.reduceMotion'] = 'system';
      expect(motion.prefersReducedMotion()).toBe(false);

      listeners[0]({
        matches: true,
        media: '(prefers-reduced-motion: reduce)'
      } as MediaQueryListEvent);
      expect(motion.prefersReducedMotion()).toBe(true);
    } finally {
      Object.defineProperty(window, 'matchMedia', {
        configurable: true,
        value: originalMatchMedia
      });
      vi.resetModules();
    }
  });
});
