import { afterEach, describe, expect, it } from 'vitest';
import { applyUiFontSize } from './appearance';

const root = () => document.documentElement;

afterEach(() => {
  root().style.removeProperty('--ui-font-size');
});

describe('applyUiFontSize', () => {
  it('writes the clamped size to --ui-font-size in px', () => {
    applyUiFontSize(16);
    expect(root().style.getPropertyValue('--ui-font-size')).toBe('16px');
  });

  it('clamps out-of-range values to the schema bounds (12–18)', () => {
    applyUiFontSize(4);
    expect(root().style.getPropertyValue('--ui-font-size')).toBe('12px');
    applyUiFontSize(99);
    expect(root().style.getPropertyValue('--ui-font-size')).toBe('18px');
  });

  it('coerces numeric strings and falls back to the default for garbage', () => {
    applyUiFontSize('15');
    expect(root().style.getPropertyValue('--ui-font-size')).toBe('15px');
    applyUiFontSize('nonsense');
    expect(root().style.getPropertyValue('--ui-font-size')).toBe('14px');
  });
});
