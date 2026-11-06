import { browserStorageEnabled } from './commands';

export function isBrowserDemo(): boolean {
  return (
    import.meta.env.VITE_BROWSER_DEMO === '1' &&
    typeof window !== 'undefined' &&
    !('__TAURI_INTERNALS__' in window) &&
    browserStorageEnabled()
  );
}
