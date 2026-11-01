import { isTauri } from './core';

/**
 * Open a link from note content in the system browser. Only navigational
 * schemes go through; a file: or javascript: URL written into a document
 * is ignored.
 */
export async function openExternalUrl(url: string): Promise<void> {
  if (!/^(https?:|mailto:)/i.test(url)) return;
  try {
    if (isTauri()) {
      const { open } = await import('@tauri-apps/plugin-shell');
      await open(url);
    } else if (typeof window !== 'undefined') {
      window.open(url, '_blank', 'noopener,noreferrer');
    }
  } catch (err) {
    console.warn('[openExternalUrl] failed to open link', url, err);
  }
}
