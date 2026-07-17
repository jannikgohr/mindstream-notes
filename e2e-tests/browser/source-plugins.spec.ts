import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * The source-mode plugins from `src/lib/editor/plugins/source`, driven through
 * the real CodeMirror editor and the real popup components.
 *
 * The unit tests cover the scan rules and the commit path against a bare
 * EditorState. What they can't reach is everything this file exists for: that
 * the extensions are actually REGISTERED on the source pane, that the caret
 * rect published from the measure cycle positions a popup (happy-dom has no
 * layout, so the unit tests deliberately skip it), that the popup's candidate
 * list and the plugin's keyboard handling meet correctly, and that Enter picks
 * a note instead of inserting a newline.
 *
 * The picker writes plain markdown — `[Title](mindstream://note/<id>)` — rather
 * than a decorated `[[Title]]`. That's the point of the source surface: the
 * link is meant to be visible and editable as text.
 */

function modeButton(page: Page): Locator {
  return page.getByRole('button', { name: /^Editor view mode:/ });
}

function sourcePane(page: Page): Locator {
  return page.locator('.cm-content');
}

function wysiwygPane(page: Page): Locator {
  return page.locator('.ProseMirror').first();
}

function wikilinkMenu(page: Page): Locator {
  return page.locator('.wikilink-menu');
}

function mentionMenu(page: Page): Locator {
  return page.locator('.user-mention-menu');
}

async function boot(page: Page) {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Welcome' })).toBeVisible();
  await expect(wysiwygPane(page)).toBeVisible();
  await expect(modeButton(page)).toBeVisible();
}

/** Cycle the single view-mode button until it reports `target`. */
async function setMode(page: Page, target: 'WYSIWYG' | 'Source' | 'Split') {
  for (let i = 0; i < 4; i++) {
    const label = await modeButton(page).getAttribute('aria-label');
    if (label === `Editor view mode: ${target}`) return;
    await modeButton(page).click();
  }
  throw new Error(`could not reach view mode ${target}`);
}

/** The Source pane's exact text, reconstructed from CodeMirror's line divs. */
async function sourceText(page: Page): Promise<string> {
  const lines = await page.locator('.cm-line').allTextContents();
  return lines.join('\n');
}

/** Empty the Source document and leave the caret in it. */
async function clearSource(page: Page) {
  await sourcePane(page).click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.press('Delete');
}

async function bootSource(page: Page) {
  await boot(page);
  await setMode(page, 'Source');
  await expect(sourcePane(page)).toBeVisible();
  await clearSource(page);
}

test.describe('source auto-pair', () => {
  test('closes a bracket and puts the caret inside', async ({ page }) => {
    await bootSource(page);
    await page.keyboard.type('a(');
    expect(await sourceText(page)).toBe('a()');
    // Caret between the pair: what we type next lands inside.
    await page.keyboard.type('x');
    expect(await sourceText(page)).toBe('a(x)');
  });

  test('types through a closer instead of duplicating it', async ({ page }) => {
    await bootSource(page);
    await page.keyboard.type('(x)');
    expect(await sourceText(page)).toBe('(x)');
  });

  test('backspaces a whole pair in one stroke', async ({ page }) => {
    await bootSource(page);
    await page.keyboard.type('[');
    expect(await sourceText(page)).toBe('[]');
    await page.keyboard.press('Backspace');
    expect(await sourceText(page)).toBe('');
  });

  test('leaves brackets alone inside a fenced code block', async ({ page }) => {
    await bootSource(page);
    // insertText, so the fence arrives without the keymap reinterpreting it.
    await page.keyboard.insertText('```js\nfn\n```');
    // Put the caret after `fn`, inside the fence.
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('End');
    await page.keyboard.type('(');
    expect(await sourceText(page)).toBe('```js\nfn(\n```');
  });
});

test.describe('source wikilink picker', () => {
  test('`[[` opens the note picker and Enter writes a markdown link', async ({
    page
  }) => {
    await bootSource(page);
    await page.keyboard.type('see [[');
    await expect(wikilinkMenu(page)).toBeVisible();

    // The seeded demo vault has a Welcome note; filter down to it.
    await page.keyboard.type('Welcome');
    const option = wikilinkMenu(page).getByRole('option', { name: /Welcome/ });
    await expect(option).toBeVisible();

    // Enter commits the highlighted note rather than inserting a newline.
    await page.keyboard.press('Enter');
    await expect(wikilinkMenu(page)).toBeHidden();

    const text = await sourceText(page);
    expect(text).toMatch(/^see \[Welcome\]\(mindstream:\/\/note\/[^)]+\)$/);
  });

  test('auto-pair and the picker cooperate on the `]]` half', async ({
    page
  }) => {
    await bootSource(page);
    // Typing `[[` auto-pairs into `[[]]` with the caret in the middle; the
    // picker must still open, and committing must swallow the trailing `]]`.
    await page.keyboard.type('[[');
    expect(await sourceText(page)).toBe('[[]]');
    await expect(wikilinkMenu(page)).toBeVisible();

    await page.keyboard.type('Welcome');
    await page.keyboard.press('Enter');

    const text = await sourceText(page);
    expect(text).toMatch(/^\[Welcome\]\(mindstream:\/\/note\/[^)]+\)$/);
  });

  test('clicking a suggestion commits it', async ({ page }) => {
    await bootSource(page);
    await page.keyboard.type('[[Welcome');
    await wikilinkMenu(page)
      .getByRole('option', { name: /Welcome/ })
      .click();
    expect(await sourceText(page)).toMatch(
      /^\[Welcome\]\(mindstream:\/\/note\/[^)]+\)$/
    );
  });

  test('Escape closes the picker and leaves the text alone', async ({
    page
  }) => {
    await bootSource(page);
    await page.keyboard.type('[[Wel');
    await expect(wikilinkMenu(page)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(wikilinkMenu(page)).toBeHidden();
    expect(await sourceText(page)).toBe('[[Wel]]');

    // Dismissed means dismissed — typing more must not resurrect it.
    await page.keyboard.type('c');
    await expect(wikilinkMenu(page)).toBeHidden();
  });

  test('stays shut inside a fenced code block', async ({ page }) => {
    await bootSource(page);
    await page.keyboard.insertText('```js\nconst a = 1\n```');
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('End');
    await page.keyboard.insertText('[[');
    await expect(wikilinkMenu(page)).toBeHidden();
  });
});

test.describe('source user-mention picker', () => {
  /**
   * Candidates are "who can view this note", which is derived from the signed-in
   * user and the note's share scope. The browser-fallback mock store has no
   * session, so the list is legitimately empty here and the menu shows its
   * empty state — the WYSIWYG pane behaves identically under these conditions.
   * That still proves what this file is for: the extension is registered, the
   * `@` trigger fires, the caret rect measured, and the popup positions itself.
   * Committing a picked user is covered against a populated bridge in
   * src/lib/editor/plugins/source/user-mention.test.ts.
   */
  test('`@` opens the user picker', async ({ page }) => {
    await bootSource(page);
    await page.keyboard.type('hi @');
    await expect(mentionMenu(page)).toBeVisible();
    await expect(mentionMenu(page)).toContainText('No one with access');
    // The document is untouched — opening the menu is not an edit.
    expect(await sourceText(page)).toBe('hi @');
  });

  test('stays shut inside an email address', async ({ page }) => {
    await bootSource(page);
    await page.keyboard.type('mail@example');
    await expect(mentionMenu(page)).toBeHidden();
  });

  test('Escape closes the picker', async ({ page }) => {
    await bootSource(page);
    await page.keyboard.type('hi @al');
    await expect(mentionMenu(page)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(mentionMenu(page)).toBeHidden();
    expect(await sourceText(page)).toBe('hi @al');
  });
});

test.describe('split mode', () => {
  test('the source picker commits into the source pane only', async ({
    page
  }) => {
    await boot(page);
    await setMode(page, 'Source');
    await clearSource(page);
    await setMode(page, 'Split');

    // Both panes are live here — the bridges are per-surface, so the menu the
    // source pane opens must be the one wired to the source pane.
    await sourcePane(page).click();
    await page.keyboard.type('[[Welcome');
    await expect(wikilinkMenu(page)).toBeVisible();
    await page.keyboard.press('Enter');

    expect(await sourceText(page)).toMatch(
      /^\[Welcome\]\(mindstream:\/\/note\/[^)]+\)$/
    );
    // And the edit reaches the shared document: the WYSIWYG pane renders the
    // committed link as a decorated wikilink.
    await expect(wysiwygPane(page).locator('.wikilink')).toContainText(
      'Welcome',
      { timeout: 5_000 }
    );
  });
});
