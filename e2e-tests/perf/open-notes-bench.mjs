/**
 * Renderer-memory bench: open N markdown notes in the desktop shell (browser
 * fallback mode) and report JS heap / DOM nodes / live editors after each one.
 * Run against a `vite preview` on :1440.
 */
import { chromium } from '@playwright/test';

const N = Number(process.env.BENCH_NOTES ?? 6);
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

async function snap(label) {
  await page.evaluate(() => window.gc?.());
  await page.waitForTimeout(600);
  const s = await page.evaluate(() => ({
    heapMB: +(performance.memory.usedJSHeapSize / 1048576).toFixed(1),
    nodes: document.getElementsByTagName('*').length,
    editors: document.querySelectorAll('.ProseMirror').length,
    tabs: document.querySelectorAll('.dv-tab').length,
    listeners: 0
  }));
  console.log(
    `${label.padEnd(22)} heap=${String(s.heapMB).padStart(6)} MB  nodes=${String(s.nodes).padStart(6)}  editors=${s.editors}  tabs=${s.tabs}`
  );
  return s;
}

async function newNote(title) {
  const more = page
    .getByRole('complementary')
    .first()
    .getByRole('button', { name: 'More actions', exact: true });
  let action = page
    .getByRole('button', { name: 'New note', exact: true })
    .or(page.getByRole('menuitem', { name: 'New note', exact: true }));
  if (!(await action.isVisible())) await more.click();
  await action.click();
  const draft = page.getByRole('textbox', { name: 'New note' });
  await draft.waitFor();
  await draft.fill(title);
  await draft.press('Enter');
  await page.getByRole('button', { name: title, exact: true }).first().click();
  await page.waitForTimeout(1500);
}

const base = await snap('start (1 note)');
const rows = [base];
for (let i = 1; i <= N; i++) {
  await newNote(`Bench ${i}`);
  rows.push(await snap(`+note ${i}`));
}
await page.waitForTimeout(3000);
const settled = await snap('settled');

const per = (settled.heapMB - base.heapMB) / N;
const perNodes = (settled.nodes - base.nodes) / N;
console.log(
  `\nmarginal per open note: ${per.toFixed(2)} MB heap, ${perNodes.toFixed(0)} DOM nodes`
);

await browser.close();
