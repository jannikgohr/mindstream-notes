export interface MenuItem {
  id?: string;
  label: string;
  /** Optional shortcut hint shown right-aligned. */
  shortcut?: string;
  /** Mark as destructive - gets red styling. */
  destructive?: boolean;
  disabled?: boolean;
  onSelect?: () => void;
  children?: MenuItem[];
}
