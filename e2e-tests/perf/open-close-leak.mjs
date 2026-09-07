/**
 * Retention check: open a note, close its dock tab, repeat. A healthy editor
 * returns to (roughly) the same heap and DOM-node count every cycle; steady
 * growth means the editor, its Yjs doc, or a listener survives teardown.
 */
import { chromium } from '@playwright/test';

const CYCLES = Number(process.env.BENCH_CYCLES ?? 12);
const URL = process.env.BENCH_URL ?? 'http://localhost:1440/';

const browser = await chromium.launch({
  args: ['--js-flags=--expose-gc', '--enable-precise-memory-info']
});
const page = await browser.newPage();
await page.goto(URL);
await page
  .getByRole('button', { name: 'Welcome', exact: true })
  .first()
  .waitFor();
await page.waitForTimeout(2500);

async function snap(label) {
  for (let i = 0; i < 3; i++) {
    await page.evaluate(() => window.gc?.());
    await page.waitForTimeout(300);
  }
  const s = await page.evaluate(() => ({
    heapMB: +(performance.memory.usedJSHeapSize / 1048576).toFixed(1),
    nodes: document.getElementsByTagName('*').length,
    detached: 0,
    tabs: document.querySelectorAll('.dv-tab').length
  }));
  console.log(
    `${label.padEnd(16)} heap=${String(s.heapMB).padStart(6)} MB  nodes=${String(s.nodes).padStart(5)}  tabs=${s.tabs}`
  );
  return s;
}

// Open "Ideas" (seeded under Personal) and close it, over and over.
await page.getByRole('button', { name: 'Personal', exact: true }).click();
await page.waitForTimeout(500);

const base = await snap('warm');
for (let i = 1; i <= CYCLES; i++) {
  await page
    .getByRole('button', { name: 'Ideas', exact: true })
    .first()
    .click();
  await page.waitForTimeout(1200);
  // Close every dock tab that isn't the first.
  const closes = page.locator('.dv-tab .dv-default-tab-action');
  const n = await closes.count();
  for (let k = n - 1; k >= 1; k--) {
    await closes
      .nth(k)
      .click({ force: true })
      .catch(() => {});
    await page.waitForTimeout(200);
  }
  await page.waitForTimeout(600);
  if (i % 3 === 0 || i === CYCLES) await snap(`cycle ${i}`);
}
const end = await snap('final');
console.log(
  `\nretained after ${CYCLES} open/close cycles: ${(end.heapMB - base.heapMB).toFixed(1)} MB heap, ${end.nodes - base.nodes} DOM nodes`
);
await browser.close();
