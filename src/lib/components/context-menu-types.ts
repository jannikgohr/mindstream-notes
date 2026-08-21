import type { Component } from 'svelte';

export interface MenuItem {
  id?: string;
  label: string;
  icon?: Component<any>;
  /** Render through the central note-kind icon resolver. */
  noteKind?: string;
  /** Plugin-owned SVG icon rendered as a safe CSS mask. */
  pluginIcon?: { pluginId: string; file: string };
  /** Optional shortcut hint shown right-aligned. */
  shortcut?: string;
  /** Mark as destructive - gets red styling. */
  destructive?: boolean;
  disabled?: boolean;
  onSelect?: () => void;
  children?: MenuItem[];
}
