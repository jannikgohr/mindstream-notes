/**
 * Affine transforms applied to selected strokes: validation, identity
 * detection, inversion (for undo) and point application.
 */

import type { InkPoint } from '$lib/ink/page';
import type { StrokeTransform } from './stroke-types';

export function validTransform(transform: StrokeTransform): boolean {
  return (
    Number.isFinite(transform.a) &&
    Number.isFinite(transform.b) &&
    Number.isFinite(transform.c) &&
    Number.isFinite(transform.d) &&
    Number.isFinite(transform.e) &&
    Number.isFinite(transform.f) &&
    Number.isFinite(transform.widthScale) &&
    transform.widthScale > 0
  );
}

export function transformIsIdentity(transform: StrokeTransform): boolean {
  return (
    Math.abs(transform.a - 1) < 0.0001 &&
    Math.abs(transform.b) < 0.0001 &&
    Math.abs(transform.c) < 0.0001 &&
    Math.abs(transform.d - 1) < 0.0001 &&
    Math.abs(transform.e) < 0.001 &&
    Math.abs(transform.f) < 0.001 &&
    Math.abs(transform.widthScale - 1) < 0.0001
  );
}

export function invertTransform(
  transform: StrokeTransform
): StrokeTransform | null {
  const det = transform.a * transform.d - transform.b * transform.c;
  if (Math.abs(det) < 1e-8) return null;
  return {
    a: transform.d / det,
    b: -transform.b / det,
    c: -transform.c / det,
    d: transform.a / det,
    e: (transform.c * transform.f - transform.d * transform.e) / det,
    f: (transform.b * transform.e - transform.a * transform.f) / det,
    widthScale: 1 / transform.widthScale
  };
}

export function transformPoint(
  point: InkPoint,
  transform: StrokeTransform
): InkPoint {
  return {
    x: point.x * transform.a + point.y * transform.c + transform.e,
    y: point.x * transform.b + point.y * transform.d + transform.f,
    pressure: point.pressure
  };
}
