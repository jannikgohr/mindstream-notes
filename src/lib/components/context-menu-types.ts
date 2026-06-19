import type { Component } from 'svelte';

export interface MenuItem {
  id?: string;
  label: string;
  icon?: Component<any>;
  /** Optional shortcut hint shown right-aligned. */
  shortcut?: string;
  /** Mark as destructive - gets red styling. */
  destructive?: boolean;
  disabled?: boolean;
  onSelect?: () => void;
  children?: MenuItem[];
}
