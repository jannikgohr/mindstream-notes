import { test as base, expect } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const test = base.extend({
  context: async (
    {
      context,
      browserName,
      playwright,
      baseURL,
      userAgent,
      viewport,
      hasTouch
    },
    use
  ) => {
    if (browserName !== 'webkit') {
      await use(context);
      return;
    }
    // WebKit disables OPFS in ephemeral contexts. Each test gets its own
    // persistent profile, including independent OPFS storage and Web Locks.
    const profile = await mkdtemp(join(tmpdir(), 'sqlite-proof-'));
    let persistent;
    try {
      persistent = await playwright.webkit.launchPersistentContext(profile, {
        baseURL,
        userAgent,
        viewport: viewport ?? { width: 1280, height: 720 },
        hasTouch
      });
      await use(persistent);
    } finally {
      await persistent?.close();
      await rm(profile, { recursive: true, force: true });
    }
  }
});

export { expect };
