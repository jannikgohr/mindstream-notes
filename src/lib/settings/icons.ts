import type { Component } from 'svelte';
import {
  Database,
  Info,
  Keyboard,
  Languages,
  Palette,
  PencilLine,
  Settings as SettingsIcon,
  Shield,
  UserRound
} from '@lucide/svelte';

/**
 * Lookup table for the Lucide icon names referenced in schema.json.
 * @lucide/svelte's exported components don't match Svelte 5's strict
 * `Component<{}, {}, string>` shape (the `class` prop in particular),
 * so we widen to `Component<any>` here. We only use them for rendering
 * with a class attribute — no event handlers — so it's safe.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type IconComponent = Component<any>;

export const SETTINGS_ICONS: Record<string, IconComponent> = {
  database: Database as unknown as IconComponent,
  info: Info as unknown as IconComponent,
  keyboard: Keyboard as unknown as IconComponent,
  languages: Languages as unknown as IconComponent,
  palette: Palette as unknown as IconComponent,
  'pencil-line': PencilLine as unknown as IconComponent,
  shield: Shield as unknown as IconComponent,
  'user-round': UserRound as unknown as IconComponent
};

export const FALLBACK_ICON: IconComponent =
  SettingsIcon as unknown as IconComponent;
