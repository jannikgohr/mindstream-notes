/**
 * Measuring helpers shared by the large-vault bench and the competitor
 * benches, so every app is timed the same way.
 */
import { execFileSync, spawn } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

export { chromium };

/**
 * Chromium switches that keep a window drawing at full rate when it is
 * covered or unfocused: Windows tracks occlusion and stops a hidden
 * window's frames. Joplin rejects them, and it draws no graph.
 */
export const foreground = [
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--disable-background-timer-throttling'
];

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)];
}

/**
 * Every process as pid → [parent pid, bytes]. The bytes are the private
 * working set (Task Manager's "Memory") on Windows and 0 on Linux, where
 * PSS is read per process.
 */
function processes() {
  const table = new Map();
  if (process.platform === 'win32') {
    const out = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        'Get-CimInstance Win32_PerfRawData_PerfProc_Process -Property IDProcess,CreatingProcessID,WorkingSetPrivate | % { "$($_.IDProcess) $($_.CreatingProcessID) $($_.WorkingSetPrivate)" }'
      ],
      { encoding: 'utf8' }
    );
    for (const line of out.split(/\r?\n/)) {
      const [pid, ppid, bytes] = line.split(' ').map(Number);
      if (pid) table.set(pid, [ppid, bytes]);
    }
    return table;
  }
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const stat = readFileSync(`/proc/${name}/stat`, 'utf8');
      const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
      table.set(Number(name), [ppid, 0]);
    } catch {
      // The process exited while we looked.
    }
  }
  return table;
}

/** `pid` and all its descendants. */
function processTree(pid, table = processes()) {
  const children = new Map();
  for (const [p, [ppid]] of table) {
    if (!children.has(ppid)) children.set(ppid, []);
    children.get(ppid).push(p);
  }
  const out = [];
  const walk = (p) => {
    out.push(p);
    for (const child of children.get(p) ?? []) if (child !== p) walk(child);
  };
  walk(pid);
  return out;
}

/** What the memory numbers mean on this platform, for the results. */
export const memoryKind =
  process.platform === 'win32' ? 'private working set' : 'PSS';

/**
 * Memory of a process tree in MiB. On Linux it is the proportional set
 * size: pages shared between the processes are split between them, so a
 * Chromium or Electron app's many processes add up to what the app costs.
 * On Windows it is the private working set, which leaves shared pages out.
 * null on other platforms.
 */
export function pssMB(pid) {
  if (process.platform === 'win32') {
    const table = processes();
    const bytes = processTree(pid, table).reduce(
      (sum, p) => sum + (table.get(p)?.[1] ?? 0),
      0
    );
    return Math.round(bytes / 1048576);
  }
  if (process.platform !== 'linux') return null;
  let kb = 0;
  for (const p of processTree(pid)) {
    try {
      const rollup = readFileSync(`/proc/${p}/smaps_rollup`, 'utf8');
      kb += Number(rollup.match(/^Pss:\s+(\d+)/m)?.[1] ?? 0);
    } catch {
      // The process exited while we looked.
    }
  }
  return Math.round(kb / 1024);
}

/** The GPU the page renders with, as WebGL names it. */
export function gpu(page) {
  return page.evaluate(() => {
    const gl = document.createElement('canvas').getContext('webgl');
    const info = gl?.getExtension('WEBGL_debug_renderer_info');
    return info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : null;
  });
}

/**
 * Evaluates `fn` in the page every 50 ms until it returns something truthy,
 * and returns the milliseconds since `t0`. Each probe waits behind the
 * page's current task, so this is when the page could first answer, not
 * just when the DOM changed.
 */
export async function until(
  page,
  fn,
  arg,
  { t0 = performance.now(), timeout = 30 * 60_000, every = 50 } = {}
) {
  const end = performance.now() + timeout;
  for (;;) {
    if (await page.evaluate(fn, arg).catch(() => false))
      return Math.round(performance.now() - t0);
    if (performance.now() > end)
      throw new Error(`timed out waiting for ${String(fn).slice(0, 120)}`);
    await sleep(every);
  }
}

/** Frame intervals and main-thread long tasks over `ms`. */
export function frames(page, ms) {
  return page.evaluate(
    (ms) =>
      new Promise((resolve) => {
        const intervals = [];
        let longTasks = 0;
        const observer = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) longTasks += entry.duration;
        });
        observer.observe({ type: 'longtask', buffered: false });
        const start = performance.now();
        let last = start;
        const step = (now) => {
          intervals.push(now - last);
          last = now;
          if (now < start + ms) requestAnimationFrame(step);
          else {
            observer.disconnect();
            intervals.sort((a, b) => a - b);
            const at = (q) =>
              Math.round(intervals[Math.floor(q * (intervals.length - 1))]);
            resolve({
              fps: Math.round((intervals.length / (now - start)) * 1000),
              p50: at(0.5),
              p95: at(0.95),
              max: Math.round(intervals[intervals.length - 1]),
              longTaskMs: Math.round(longTasks)
            });
          }
        };
        requestAnimationFrame(step);
      }),
    ms
  );
}

/**
 * Ten wheel steps in, then ten out, over two seconds, at the centre of the
 * biggest canvas under `selector`, sent to whatever element is on top there,
 * as a real wheel would be. Dispatched from inside the page: input sent
 * through the browser waits for each frame, and a frame of a big graph
 * rasterised in software can take seconds. Measure with `frames` right
 * after.
 */
export function zoom(page, selector) {
  return page.evaluate((selector) => {
    const canvas = [...document.querySelectorAll(`${selector} canvas`)].sort(
      (a, b) => b.width * b.height - a.width * a.height
    )[0];
    const { left, top, width, height } = canvas.getBoundingClientRect();
    const [x, y] = [left + width / 2, top + height / 2];
    const target = document.elementFromPoint(x, y) ?? canvas;
    const end = performance.now() + 2000;
    let sent = 0;
    const timer = setInterval(() => {
      if (performance.now() > end || sent === 20) return clearInterval(timer);
      target.dispatchEvent(
        new WheelEvent('wheel', {
          deltaY: sent++ < 10 ? -120 : 120,
          clientX: x,
          clientY: y,
          bubbles: true,
          cancelable: true
        })
      );
    }, 100);
  }, selector);
}

/**
 * Resolves once `proc` and, on Linux and Windows, everything it started
 * have exited: a WebView2 or Chromium process left behind holds the profile
 * the next start wants.
 */
async function exited(proc) {
  if (process.platform !== 'linux' && process.platform !== 'win32') {
    if (proc.exitCode === null && proc.signalCode === null)
      await new Promise((r) => proc.once('exit', r));
    return;
  }
  const pids = processTree(proc.pid);
  const alive = () =>
    pids.filter((p) => {
      try {
        process.kill(p, 0);
        return (
          process.platform === 'win32' ||
          !readFileSync(`/proc/${p}/stat`, 'utf8').includes(') Z ')
        );
      } catch {
        return false;
      }
    });
  const t0 = performance.now();
  while (alive().length) {
    const waited = performance.now() - t0;
    if (waited > 15_000)
      for (const p of alive()) {
        try {
          process.kill(p, waited > 25_000 ? 'SIGKILL' : 'SIGTERM');
        } catch {
          // Already gone.
        }
      }
    await sleep(100);
  }
}

/**
 * Starts a Chromium-based app (Chromium itself, an Electron app, or a
 * WebView2 host) with the DevTools protocol on `port`, and resolves with the
 * first window for which `pick` returns true. A WebView2 host takes the
 * port through its environment, so `portFlag: false` leaves the flags out.
 * `quit` replaces the default way of closing the app. `t0` is taken before the process starts, so it times
 * a cold start the way a user sees one.
 *
 * `close` asks Chromium to quit over the protocol when `cdpClose` is set,
 * since Chrome for Testing restores the last session's tabs after a
 * SIGTERM. Electron apps get a SIGTERM after the protocol disconnects:
 * Obsidian answers it with a beforeunload dialog that Playwright would
 * otherwise try to handle on a closing page.
 */
export async function launch(
  bin,
  args,
  {
    env = {},
    port,
    pick = async () => true,
    cdpClose = false,
    portFlag = true,
    quit
  }
) {
  const t0 = performance.now();
  const proc = spawn(
    bin,
    [
      ...(portFlag ? ['--no-sandbox', `--remote-debugging-port=${port}`] : []),
      ...args
    ],
    {
      env: { ...process.env, LC_ALL: 'C.UTF-8', ...env },
      stdio: ['ignore', 'ignore', 'pipe']
    }
  );
  let stderr = '';
  proc.stderr.on('data', (chunk) => (stderr = (stderr + chunk).slice(-4000)));
  let browser;
  let page;
  try {
    while (!browser) {
      if (proc.exitCode !== null)
        throw new Error(`${bin} exited with ${proc.exitCode}: ${stderr}`);
      if (performance.now() - t0 > 120_000)
        throw new Error(`${bin} opened no DevTools port`);
      browser = await chromium
        .connectOverCDP(`http://127.0.0.1:${port}`)
        .catch(() => null);
      if (!browser) await sleep(50);
    }
    while (!page) {
      for (const context of browser.contexts())
        for (const candidate of context.pages())
          if (
            !candidate.url().startsWith('devtools') &&
            (await pick(candidate).catch(() => false))
          )
            page = candidate;
      if (!page) await sleep(50);
      if (performance.now() - t0 > 120_000)
        throw new Error(`${bin}: no window`);
    }
  } catch (error) {
    await browser?.close().catch(() => {});
    proc.kill('SIGTERM');
    await exited(proc);
    throw error;
  }
  return {
    proc,
    browser,
    page,
    t0,
    async close() {
      if (quit) {
        await quit(page).catch(() => {});
        await browser.close().catch(() => {});
      } else if (cdpClose)
        // The reply may never come: the socket closes first.
        browser
          .newBrowserCDPSession()
          .then((cdp) => cdp.send('Browser.close'))
          .catch(() => {});
      else {
        await browser.close().catch(() => {});
        proc.kill('SIGTERM');
      }
      await exited(proc);
    }
  };
}
