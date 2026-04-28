// Disable SSR — Tauri ships a static SPA. dockview, Milkdown, and the Tauri
// API are all browser-only, so there's no server to render against.
export const ssr = false;
export const prerender = true;
export const trailingSlash = 'always';
