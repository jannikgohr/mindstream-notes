/**
 * First-party plugins that ship inside the app bundle. These are trusted (they
 * are part of the app), so they don't go through the install/approval flow —
 * the loader registers them directly at startup. Third-party discovery/install
 * is a later slice.
 */

import type { PluginManifest } from '../types';
import { TEMPLATES_CORE_MANIFEST } from './templates-core';

export const BUILTIN_PLUGIN_MANIFESTS: readonly PluginManifest[] = [
  TEMPLATES_CORE_MANIFEST
];
