import { afterEach, describe, expect, it } from 'vitest';
import {
  applyDensity,
  applyEditorTypography,
  applyUiFontSize
} from './appearance';

const root = () => document.documentElement;

afterEach(() => {
  root().style.removeProperty('--ui-font-size');
  root().style.removeProperty('--editor-font-size');
  root().style.removeProperty('--editor-line-height');
  delete root().dataset.density;
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

describe('applyEditorTypography', () => {
  it('writes editor font size (px) and unitless line height', () => {
    applyEditorTypography(20, 1.8);
    expect(root().style.getPropertyValue('--editor-font-size')).toBe('20px');
    expect(root().style.getPropertyValue('--editor-line-height')).toBe('1.8');
  });

  it('clamps both values to their schema bounds', () => {
    applyEditorTypography(2, 5);
    expect(root().style.getPropertyValue('--editor-font-size')).toBe('12px');
    expect(root().style.getPropertyValue('--editor-line-height')).toBe('2');
    applyEditorTypography(99, 0.1);
    expect(root().style.getPropertyValue('--editor-font-size')).toBe('24px');
    expect(root().style.getPropertyValue('--editor-line-height')).toBe('1.2');
  });

  it('falls back to defaults for non-numeric input', () => {
    applyEditorTypography('x', 'y');
    expect(root().style.getPropertyValue('--editor-font-size')).toBe('16px');
    expect(root().style.getPropertyValue('--editor-line-height')).toBe('1.6');
  });
});

describe('applyDensity', () => {
  it('reflects a valid density onto html[data-density]', () => {
    for (const d of ['compact', 'cozy', 'roomy']) {
      applyDensity(d);
      expect(root().dataset.density).toBe(d);
    }
  });

  it('falls back to cozy for an unknown value', () => {
    applyDensity('ultra');
    expect(root().dataset.density).toBe('cozy');
  });
});
