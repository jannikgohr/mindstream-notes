import { afterEach, describe, expect, it } from 'vitest';
import { applyAccentColor, clearAccentColor } from './accent';

const root = () => document.documentElement;

afterEach(() => clearAccentColor());

describe('applyAccentColor', () => {
  it('sets the three accent CSS vars for a valid hex', () => {
    applyAccentColor('#3b82f6');
    expect(root().style.getPropertyValue('--primary')).toBe('#3b82f6');
    expect(root().style.getPropertyValue('--primary-foreground')).toBe(
      '#ffffff'
    );
    expect(root().style.getPropertyValue('--ring')).toBe('#3b82f6');
  });

  it('accepts 3-, 4-, 6- and 8-digit hex', () => {
    for (const c of ['#abc', '#abcd', '#aabbcc', '#aabbccdd']) {
      applyAccentColor(c);
      expect(root().style.getPropertyValue('--primary')).toBe(c);
    }
  });

  it('clears the vars for an invalid or empty colour', () => {
    applyAccentColor('#3b82f6');
    applyAccentColor('not-a-color');
    expect(root().style.getPropertyValue('--primary')).toBe('');

    applyAccentColor('#3b82f6');
    applyAccentColor('');
    expect(root().style.getPropertyValue('--ring')).toBe('');
  });
});

describe('clearAccentColor', () => {
  it('removes all three vars', () => {
    applyAccentColor('#10b981');
    clearAccentColor();
    expect(root().style.getPropertyValue('--primary')).toBe('');
    expect(root().style.getPropertyValue('--primary-foreground')).toBe('');
    expect(root().style.getPropertyValue('--ring')).toBe('');
  });
});
