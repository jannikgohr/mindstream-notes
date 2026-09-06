import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

interface TauriConfig {
  app?: {
    windows?: Array<{
      label?: string;
      additionalBrowserArgs?: string;
    }>;
  };
}

function mainWindowBrowserArgs(): string {
  const configPath = resolve(process.cwd(), 'src-tauri', 'tauri.conf.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8')) as TauriConfig;
  const mainWindow = config.app?.windows?.find(
    (window) => window.label === 'main'
  );

  if (!mainWindow) throw new Error('tauri.conf.json has no main window');
  return mainWindow.additionalBrowserArgs ?? '';
}

describe('Tauri WebView2 configuration', () => {
  it('keeps popout windows in one renderer process', () => {
    expect(mainWindowBrowserArgs()).toContain('--renderer-process-limit=1');
  });

  it('does not disable browser protections or process isolation', () => {
    const args = mainWindowBrowserArgs();
    const forbidden = [
      'msSmartScreenProtection',
      'NetworkServiceInProcess2',
      'AudioServiceOutOfProcess',
      '--disable-background-networking',
      '--disable-component-update'
    ];

    for (const flag of forbidden) expect(args).not.toContain(flag);
  });

  it('does not move GPU work onto the browser UI thread', () => {
    expect(mainWindowBrowserArgs()).not.toContain('--in-process-gpu');
  });
});
