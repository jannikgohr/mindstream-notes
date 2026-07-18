import {
  devices,
  expect,
  test,
  type Locator,
  type Page
} from '@playwright/test';

/**
 * View-mode availability across form factors.
 *
 * All three surfaces are offered on every platform — mobile included. The only
 * constraint is that Split needs the viewport width for two side-by-side panes,
 * so below `SPLIT_MIN_WIDTH` (768) it drops out of both the mode toggle's cycle
 * and the `editor.defaultMode` options.
 *
 * The rule is width-based rather than `isMobile()`-based, which is why these
 * cases are split by viewport rather than by device: a phone and a narrow
 * desktop window get the same answer, and so do a landscape tablet and a
 * desktop.
 */

/**
 * A device descriptor minus `defaultBrowserType` — Playwright rejects that key
 * in a describe-level `use()` because it would force a new worker, and we only
 * want the UA / viewport / touch emulation anyway.
 */
function emulate(name: string) {
  const { defaultBrowserType: _ignored, ...rest } = devices[name];
  return rest;
}

function modeButton(page: Page): Locator {
  return page.getByRole('button', { name: /^Editor view mode:/ });
}

function sourcePane(page: Page): Locator {
  return page.locator('.cm-content');
}

function wysiwygPane(page: Page): Locator {
  return page.locator('.ProseMirror').first();
}

async function boot(page: Page) {
  await page.goto('/');
  const welcome = page.getByRole('button', { name: 'Welcome' });
  await expect(welcome).toBeVisible();
  // Narrow layouts (phone, small window) open on the note LIST — the editor
  // mounts only once a note is picked. Wide layouts restore the Welcome note
  // already open, where this branch is skipped.
  if (!(await wysiwygPane(page).isVisible())) await welcome.click();
  await expect(wysiwygPane(page)).toBeVisible();
  await expect(modeButton(page)).toBeVisible();
}

async function currentMode(page: Page): Promise<string> {
  const label = await modeButton(page).getAttribute('aria-label');
  return (label ?? '').replace('Editor view mode: ', '');
}

/** Click the toggle `n` times, collecting the mode after each click. */
async function cycle(page: Page, n: number): Promise<string[]> {
  const seen: string[] = [];
  for (let i = 0; i < n; i++) {
    await modeButton(page).click();
    seen.push(await currentMode(page));
  }
  return seen;
}

/** Open Settings and land on the Editor category. */
async function openEditorSettings(page: Page) {
  await page.getByRole('button', { name: 'Open settings' }).click();
  await page.getByRole('button', { name: 'Editor', exact: true }).click();
}

function modeOption(page: Page, name: string): Locator {
  return page.getByRole('button', { name, exact: true });
}

test.describe('wide viewport', () => {
  test('cycles through all three modes', async ({ page }) => {
    await boot(page);
    expect(await currentMode(page)).toBe('WYSIWYG');
    expect(await cycle(page, 3)).toEqual(['Source', 'Split', 'WYSIWYG']);
  });

  test('split shows both panes at once', async ({ page }) => {
    await boot(page);
    await cycle(page, 2);
    expect(await currentMode(page)).toBe('Split');
    await expect(sourcePane(page)).toBeVisible();
    await expect(wysiwygPane(page)).toBeVisible();
  });

  test('settings offers Split', async ({ page }) => {
    await boot(page);
    await openEditorSettings(page);
    await expect(modeOption(page, 'Split')).toBeVisible();
    await expect(modeOption(page, 'Source')).toBeVisible();
  });
});

test.describe('narrow viewport', () => {
  test.use({ viewport: { width: 700, height: 800 } });

  test('cycles WYSIWYG <-> Source, skipping Split', async ({ page }) => {
    await boot(page);
    expect(await currentMode(page)).toBe('WYSIWYG');
    expect(await cycle(page, 4)).toEqual([
      'Source',
      'WYSIWYG',
      'Source',
      'WYSIWYG'
    ]);
  });

  test('settings withholds Split but still offers Source', async ({ page }) => {
    await boot(page);
    await openEditorSettings(page);
    await expect(modeOption(page, 'Source')).toBeVisible();
    await expect(modeOption(page, 'Split')).toBeHidden();
  });

  test('Source is fully usable', async ({ page }) => {
    await boot(page);
    await modeButton(page).click();
    expect(await currentMode(page)).toBe('Source');
    await expect(sourcePane(page)).toBeVisible();
    await sourcePane(page).click();
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.insertText('typed in source');
    await expect(sourcePane(page)).toContainText('typed in source');
  });
});

test.describe('resizing across the threshold', () => {
  // Shrinking out of Split falls back to the pane the user was last in, so
  // their work stays in front of them instead of jumping to the other surface.
  test('an open Split falls back to the source pane the user was in', async ({
    page
  }) => {
    await boot(page);
    // WYSIWYG → Source (activeSurface becomes source) → Split.
    await cycle(page, 2);
    expect(await currentMode(page)).toBe('Split');

    await page.setViewportSize({ width: 700, height: 800 });
    await expect.poll(() => currentMode(page)).toBe('Source');
    await expect(sourcePane(page)).toBeVisible();
  });

  test('an open Split falls back to the WYSIWYG pane the user was in', async ({
    page
  }) => {
    await boot(page);
    await cycle(page, 2);
    expect(await currentMode(page)).toBe('Split');
    // Click into the rendered pane so it becomes the active surface.
    await wysiwygPane(page).click();

    await page.setViewportSize({ width: 700, height: 800 });
    await expect.poll(() => currentMode(page)).toBe('WYSIWYG');
    await expect(wysiwygPane(page)).toBeVisible();
  });

  test('Split returns to the cycle when the viewport grows back', async ({
    page
  }) => {
    await page.setViewportSize({ width: 700, height: 800 });
    await boot(page);
    expect(await cycle(page, 2)).toEqual(['Source', 'WYSIWYG']);

    await page.setViewportSize({ width: 1280, height: 800 });
    expect(await cycle(page, 2)).toEqual(['Source', 'Split']);
  });

  test('settings Split option follows the viewport live', async ({ page }) => {
    await boot(page);
    await openEditorSettings(page);
    await expect(modeOption(page, 'Split')).toBeVisible();

    // The dialog stays open across the resize — the option list is derived
    // from the live width, so it updates in place.
    await page.setViewportSize({ width: 700, height: 800 });
    await expect(modeOption(page, 'Split')).toBeHidden();

    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(modeOption(page, 'Split')).toBeVisible();
  });
});

test.describe('mobile phone', () => {
  test.use(emulate('Pixel 5'));

  test('exposes the mode toggle in the editor header', async ({ page }) => {
    // Previously mobile was locked to WYSIWYG with no toggle at all.
    await boot(page);
    await expect(modeButton(page)).toBeVisible();
  });

  /**
   * Regression: NoteKindRenderer used to re-run its loader effect on every
   * tree-store write, nulling the loaded component and remounting NoteEditor
   * — roughly twice a second on mobile, because the remount itself wrote to
   * the tree. Each remount re-seeded the view mode from `editor.defaultMode`,
   * so Source silently reverted to WYSIWYG about a second after you picked it.
   *
   * The assertion has to WAIT: checking right after the click passes even with
   * the bug, which is exactly how it went unnoticed. Holding the mode across a
   * few seconds of idle is the property that matters.
   */
  test('stays in Source instead of reverting a second later', async ({
    page
  }) => {
    await boot(page);
    await modeButton(page).click();
    expect(await currentMode(page)).toBe('Source');

    await page.waitForTimeout(3000);
    expect(await currentMode(page)).toBe('Source');
    await expect(sourcePane(page)).toBeVisible();
  });

  test('keeps the editor mounted while idle', async ({ page }) => {
    await boot(page);
    // A remount loop replaces the ProseMirror element; a stable editor keeps
    // the same node. Tracking identity catches the loop even if the mode
    // happens to survive.
    const marker = 'data-remount-probe';
    await wysiwygPane(page).evaluate(
      (el, attr) => el.setAttribute(attr, '1'),
      marker
    );
    await page.waitForTimeout(3000);
    await expect(wysiwygPane(page)).toHaveAttribute(marker, '1');
  });

  test('reaches Source, and Split stays withheld on a phone', async ({
    page
  }) => {
    await boot(page);
    expect(await cycle(page, 1)).toEqual(['Source']);
    await expect(sourcePane(page)).toBeVisible();
    // Pixel 5 is 393px wide — nowhere near enough for two panes.
    expect(await cycle(page, 1)).toEqual(['WYSIWYG']);
  });
});

test.describe('mobile tablet in landscape', () => {
  // A mobile UA (isMobile() is true — iPads report as mobile) with the width
  // for two panes: Split is about the viewport, not the platform.
  test.use({
    ...emulate('iPad (gen 7) landscape'),
    viewport: { width: 1080, height: 810 }
  });

  test('offers Split despite being mobile', async ({ page }) => {
    await boot(page);
    expect(await cycle(page, 2)).toEqual(['Source', 'Split']);
    await expect(sourcePane(page)).toBeVisible();
    await expect(wysiwygPane(page)).toBeVisible();
  });
});
