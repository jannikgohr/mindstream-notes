/**
 * Interaction-latency probe for the settings rail.
 *
 * Not an assertion suite — it prints numbers. It exists because "the hover
 * highlight lags behind the mouse" is a claim about input-to-paint latency,
 * which nothing else in the repo can measure: unit tests do not paint, and
 * the browser-fallback suite runs in a different compositor than WebView2.
 *
 * Method: open Settings, then drive a real WebDriver mouse sweep down the
 * category rail while a rAF loop in the page records frame intervals. A
 * compositor keeping up shows a tight cluster at the display's frame time;
 * a starved one shows a long tail, which is exactly what a highlight
 * trailing the cursor looks like.
 *
 * Run: pnpm test:e2e:app -- --spec e2e-tests/perf/settings-hover-latency.e2e.ts
 */

import { browser, $, $$ } from '@wdio/globals';
import { clickElement, waitForShell } from '../app/helpers/harness.js';

declare global {
  interface Window {
    __frames?: number[];
    __inputDelays?: number[];
    __transition?: string;
    __stopFrames?: () => void;
  }
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[i];
}

describe('settings rail hover latency', function () {
  it('reports frame intervals during a rail mouse sweep', async () => {
    await waitForShell();

    await clickElement($('button[aria-label="Open settings"]'));
    await $('nav button').waitForDisplayed({ timeout: 10_000 });

    const rows = await $$('nav button');
    const boxes: { x: number; y: number }[] = [];
    for (const row of rows.slice(0, 8)) {
      const loc = await row.getLocation();
      const size = await row.getSize();
      boxes.push({
        x: Math.round(loc.x + size.width / 2),
        y: Math.round(loc.y + size.height / 2)
      });
    }

    await browser.execute(() => {
      window.__frames = [];
      window.__inputDelays = [];
      window.__transition = '';
      const rail = document.querySelector('nav button');
      if (rail) {
        const style = getComputedStyle(rail);
        window.__transition = `${style.transitionProperty} ${style.transitionDuration} ${style.transitionTimingFunction}`;
      }
      // How long a pointer event sat between the OS timestamping it and JS
      // seeing it. This is the number a lagging highlight is made of; frame
      // cadence can look perfect while this climbs.
      const onMove = (e: MouseEvent) => {
        window.__inputDelays?.push(performance.now() - e.timeStamp);
      };
      document.addEventListener('mousemove', onMove, true);
      let last = performance.now();
      let running = true;
      const tick = (now: number) => {
        window.__frames?.push(now - last);
        last = now;
        if (running) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      window.__stopFrames = () => {
        running = false;
        document.removeEventListener('mousemove', onMove, true);
      };
    });

    // Three passes down and up the rail, in small steps so the pointer
    // actually crosses each row rather than teleporting between them.
    for (let pass = 0; pass < 3; pass++) {
      const order = pass % 2 === 0 ? boxes : [...boxes].reverse();
      for (const box of order) {
        await browser.performActions([
          {
            type: 'pointer',
            id: 'mouse',
            parameters: { pointerType: 'mouse' },
            actions: [
              { type: 'pointerMove', duration: 40, x: box.x, y: box.y },
              { type: 'pause', duration: 40 }
            ]
          }
        ]);
        await browser.releaseActions();
      }
    }

    const result: {
      frames: number[];
      inputDelays: number[];
      transition: string;
    } = await browser.execute(() => {
      window.__stopFrames?.();
      return {
        frames: window.__frames ?? [],
        inputDelays: window.__inputDelays ?? [],
        transition: window.__transition ?? ''
      };
    });
    const frames = result.frames;

    // The first few frames cover the dialog's own open animation.
    const sample = frames.slice(5).sort((a, b) => a - b);
    const long = sample.filter((f) => f > 32).length;
    const delays = [...result.inputDelays].sort((a, b) => a - b);
    console.log(`[hover-latency] hover transition = ${result.transition}`);
    console.log(
      `[hover-latency] input delay: n=${delays.length}  ` +
        `p50=${percentile(delays, 50).toFixed(1)}ms  ` +
        `p95=${percentile(delays, 95).toFixed(1)}ms  ` +
        `max=${(delays[delays.length - 1] ?? 0).toFixed(1)}ms`
    );
    console.log(
      `[hover-latency] frames=${sample.length}  ` +
        `p50=${percentile(sample, 50).toFixed(1)}ms  ` +
        `p95=${percentile(sample, 95).toFixed(1)}ms  ` +
        `p99=${percentile(sample, 99).toFixed(1)}ms  ` +
        `max=${(sample[sample.length - 1] ?? 0).toFixed(1)}ms  ` +
        `>32ms=${long} (${((100 * long) / (sample.length || 1)).toFixed(1)}%)`
    );
  });
});
