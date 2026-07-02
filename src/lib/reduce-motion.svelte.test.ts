import { beforeEach, describe, expect, it } from 'vitest';
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
});
