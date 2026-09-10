import { expect, test } from '@playwright/test';
import { probePage } from '../app/helpers/failure-capture';
import { revealFileTreeCreateAction } from './file-tree-toolbar';

/**
 * The create toolbar under a squeezed file-tree header.
 *
 * The header lays out as `[sort control][create toolbar]`, and the sort
 * control is `shrink-0` — so the create toolbar absorbs every missing pixel.
 * It used to absorb them silently: `justify-end` + `overflow-hidden` clipped
 * the leading buttons out of view while the overflow maths still counted them
 * as shown, so those actions appeared neither in the row nor in the ⋯ menu.
 * "New note" is first in the default order, which made creating a note
 * impossible — the failure the Linux app-tier run hit, where a wider fallback
 * font pushed the sort control past the point the Windows dev machine ever
 * reached.
 *
 * These tests reproduce that squeeze on purpose: the narrowest sidebar the app
 * allows (160px), every action pinned into the toolbar rather than the menu,
 * and extra tracking on the sort control's label to stand in for a wider
 * platform font.
 */

const PREFERENCES_KEY = 'notes-app:preferences:v1';
const TOOLBAR_KEY = 'notes-app:file-tree-create-toolbar:v1';

const ALL_ACTIONS = [
  'New note',
  'New folder',
  'New drawing canvas',
  'New handwritten note',
  'New Kanban board',
  'Import PDF'
];

test.beforeEach(async ({ page }) => {
  await page.addInitScript(
    ([preferencesKey, toolbarKey]) => {
      localStorage.setItem(
        preferencesKey,
        JSON.stringify({ leftSidebarWidth: 160 })
      );
      // Everything inline, nothing pre-assigned to the ⋯ menu: the toolbar has
      // to make its own room, which is the case that used to clip.
      localStorage.setItem(
        toolbarKey,
        JSON.stringify({
          toolbar: ['note', 'folder', 'drawing', 'ink', 'kanban', 'pdf'],
          more: []
        })
      );
    },
    [PREFERENCES_KEY, TOOLBAR_KEY] as const
  );
  await page.goto('/');
  await expect(
    page.getByRole('button', { name: 'Welcome', exact: true })
  ).toBeVisible();
  // Stand in for a wider platform font — the sort control is the header's
  // greediest element and its label is what varies between platforms.
  await page.addStyleTag({
    content: '[aria-label="Choose how to sort"] { letter-spacing: 0.12em; }'
  });
});

test('keeps every create action reachable in the narrowest sidebar', async ({
  page
}) => {
  for (const action of ALL_ACTIONS) {
    const control = await revealFileTreeCreateAction(page, action);
    // `toBeVisible` is not enough: a button clipped by an ancestor's
    // `overflow-hidden` still counts as visible to Playwright (which is why
    // this only ever failed in the WebDriver app tier, whose `isDisplayed` is
    // stricter). `toBeInViewport` uses IntersectionObserver, so ancestor
    // clipping actually registers.
    await expect(control).toBeInViewport();
    await page.keyboard.press('Escape');
  }
});

test('moves create buttons into the ⋯ menu instead of clipping them', async ({
  page
}) => {
  // Runs the app tier's own failure probe (e2e-tests/app/helpers/failure-capture.ts)
  // against a real DOM. Two things at once: the create buttons are unclipped,
  // and the probe that has to explain the next CI failure still works — it is
  // serialised into the page by both tiers and can only be verified here.
  const probe = await page.evaluate(probePage);
  // Scoped to the create actions on purpose: plenty of UI parks controls in a
  // closed menu or a scrolled overflow, and the probe reports those as clipped
  // too (correctly — that is what the flag is for).
  const clipped = probe.names
    .filter((entry) => entry.clipped && ALL_ACTIONS.includes(entry.name))
    .map((entry) => entry.name);
  expect(clipped).toEqual([]);

  // Sanity-check the probe itself: a page it reports nothing about explains
  // nothing about a failure.
  expect(probe.viewport.innerWidth).toBeGreaterThan(0);
  expect(probe.names.map((entry) => entry.name)).toContain('Welcome');
  expect(Object.keys(probe.storage)).toContain(
    'notes-app:file-tree-create-toolbar:v1'
  );
});
