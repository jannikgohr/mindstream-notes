import { expect, test, type Page } from '@playwright/test';

/**
 * Regression: the mobile editor must survive an autosave.
 *
 * MobileEditor is the only NoteKindRenderer caller that passes a *live*
 * `noteKind` (`note.note_kind`, read out of `tree.notesById`) — the desktop
 * dock hardcodes the kind per renderer and SingleNoteWindow snapshots it at
 * load. Every autosave replaces `tree.notesById[noteId]` with a fresh object,
 * so NoteKindRenderer's loader effect used to be invalidated by that object's
 * identity, null out its LoadedComponent and remount the whole editor —
 * blurring the caret roughly every `editor.autoSaveDebounce` (800ms) and
 * flashing "Loading note…" while the remounted editor refetched. That made
 * notes essentially uneditable on a phone.
 *
 * The mobile shell is chosen from navigator.userAgent (see lib/platform.ts),
 * so the UA override below is what puts us on MobileLayout in the
 * browser-fallback SPA.
 */

const ANDROID_UA =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36';

test.use({ userAgent: ANDROID_UA, viewport: { width: 412, height: 915 } });

/** The live Milkdown (ProseMirror) contenteditable surface. */
function editor(page: Page) {
  return page.locator('.ProseMirror').first();
}

test('typing through an autosave keeps focus and never remounts the editor', async ({
  page
}) => {
  await page.goto('/');

  // Mobile home list → open the seeded Welcome note.
  const welcome = page.getByRole('button', { name: /Welcome/ });
  await expect(welcome.first()).toBeVisible();
  await welcome.first().click();

  const ed = editor(page);
  await expect(ed).toBeVisible();
  await ed.click();

  // Brand this specific DOM node. A remount builds a fresh ProseMirror
  // element, which would drop the marker — that's the assertion that
  // distinguishes "editor survived" from "editor was rebuilt fast enough
  // to look fine".
  await ed.evaluate((el: HTMLElement) => {
    el.dataset.remountProbe = 'original';
  });

  await page.keyboard.type('first');

  // Sit past the 800ms autosave debounce — this is the window in which the
  // editor used to be torn down.
  await expect(async () => {
    await expect(page.getByText('Loading note…')).toHaveCount(0);
    await expect(editor(page)).toHaveAttribute(
      'data-remount-probe',
      'original'
    );
  }).toPass({ timeout: 3_000 });
  await page.waitForTimeout(1_500);

  await expect(page.getByText('Loading note…')).toHaveCount(0);
  await expect(editor(page)).toHaveAttribute('data-remount-probe', 'original');
  await expect(editor(page)).toBeFocused();

  // The caret is still live where the user left it: typing continues the
  // same word instead of landing in a fresh document.
  await page.keyboard.type('second');
  await expect(editor(page).getByText('firstsecond')).toBeVisible();
});

/**
 * The flip side of the fix above: NoteKindRenderer must still rebuild when the
 * *note* changes. The lazy editors resolve their note once in onMount and
 * never react to the prop, so a stale mount would leave the previous note's
 * text on screen. Both notes here are markdown — same kind, different id — so
 * only the explicit noteId dependency can catch the switch.
 */
test('switching to another note of the same kind remounts the editor', async ({
  page
}) => {
  await page.goto('/');

  await page
    .getByRole('button', { name: /Welcome/ })
    .first()
    .click();
  await expect(editor(page).getByText('browser fallback mode')).toBeVisible();

  await page.getByRole('button', { name: 'Back to notes' }).click();
  await page.getByRole('button', { name: /Work/ }).first().click();
  await page
    .getByRole('button', { name: /Sprint planning/ })
    .first()
    .click();

  await expect(
    editor(page).getByText('Carry-over from last sprint')
  ).toBeVisible();
  await expect(editor(page).getByText('browser fallback mode')).toHaveCount(0);
});
