/**
 * Mock vault data so the file explorer and editor have something to render
 * before persistence is wired up. Replace with real disk reads in a follow-up.
 */

export type NoteId = string;

export interface NoteSummary {
  id: NoteId;
  title: string;
  /** ISO timestamp — used by the metadata panel. */
  modified: string;
  tags: string[];
  /** Markdown body. */
  body: string;
}

export interface FolderNode {
  kind: 'folder';
  name: string;
  children: TreeNode[];
}

export interface NoteNode {
  kind: 'note';
  id: NoteId;
  name: string;
}

export type TreeNode = FolderNode | NoteNode;

export const MOCK_NOTES: Record<NoteId, NoteSummary> = {
  welcome: {
    id: 'welcome',
    title: 'Welcome',
    modified: '2026-04-28T09:14:00Z',
    tags: ['intro', 'pinned'],
    body: `# Welcome

This is a **local-first** note-taking boilerplate built on Tauri v2, SvelteKit
(SPA mode), Svelte 5 runes, dockview, and Milkdown's Crepe editor.

- The left sidebar is the file tree
- The right sidebar shows metadata for the active note
- The middle area is a \`dockview\` instance — drag tabs to split panes

> Persistence is currently stubbed in Rust. Open \`src-tauri/src/lib.rs\`
> to wire up real disk I/O.
`
  },
  meeting: {
    id: 'meeting',
    title: 'Sprint planning',
    modified: '2026-04-27T17:42:00Z',
    tags: ['work', 'meetings'],
    body: `# Sprint planning

## Agenda

1. Carry-over from last sprint
2. Capacity check
3. Commit
`
  },
  ideas: {
    id: 'ideas',
    title: 'Ideas',
    modified: '2026-04-25T08:02:00Z',
    tags: ['scratch'],
    body: `# Ideas

- Try a graph view
- Backlinks panel
- Daily notes
`
  }
};

export const MOCK_TREE: TreeNode[] = [
  { kind: 'note', id: 'welcome', name: 'Welcome.md' },
  {
    kind: 'folder',
    name: 'Work',
    children: [{ kind: 'note', id: 'meeting', name: 'Sprint planning.md' }]
  },
  {
    kind: 'folder',
    name: 'Personal',
    children: [{ kind: 'note', id: 'ideas', name: 'Ideas.md' }]
  }
];
