# Upstream tracking

This package is a focused fork of
[`@svar-ui/svelte-kanban`](https://github.com/svar-widgets/kanban), licensed
under the MIT license included in `LICENSE`.

- Upstream version: `2.6.0`
- Upstream commit: `363c6cf1016705ab033a1a7094b922cbf5761efa`
- Imported package: `apps/widget`
- Imported on: `2026-08-20`

Mindstream keeps the upstream store, provider, locales, editor, menu, and core
packages as regular npm dependencies. This workspace package owns the Svelte
board renderer so list management and future mobile interactions can evolve
with the application.

## Mindstream changes

- Expose a custom column-header snippet.
- Expose a board-end snippet for controls after the final column.
- Add stable column data attributes for list reordering.
