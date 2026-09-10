/**
 * Diagnostics for failed app-tier tests.
 *
 * A WebDriver failure message ("element not displayed") says nothing about
 * *why* the element wasn't there, and the app tier runs headless in CI where
 * nobody can look. So every failed test drops a bundle into the run's
 * `outputDir`, which the workflow already uploads as an artifact:
 *
 *   <test>.png    what the window actually showed
 *   <test>.html   the full document, headed by a comment with the vitals
 *   <test>.json   everything the markup doesn't say — see FailureReport
 *
 * The JSON is where the answers usually are. Three fields carry most of the
 * weight:
 *
 *   `viewport`    layout bugs that only reproduce on one platform (a narrower
 *                 webview, a wider fallback font) are invisible in markup.
 *   `names`       every accessible name on the page with its displayed and
 *                 clipped state. A "not displayed" failure is nearly always
 *                 answered by this list: the control was renamed, never
 *                 rendered, or rendered and clipped out of view.
 *   `console`     errors and warnings the page logged during the test,
 *                 collected by `installPageDiagnostics`.
 *
 * Capture is best-effort by construction. It runs while the session is already
 * unhappy — the app may be gone, the driver may be wedged — and a throw here
 * would replace the real assertion failure with a confusing one, so every step
 * swallows its own error and records what it can.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** The slice of a wdio browser this module drives. */
interface CapturableClient {
  saveScreenshot(filepath: string): Promise<unknown>;
  execute<T>(script: () => T): Promise<T>;
}

/** A multiremote browser exposes its clients by name. */
interface MultiremoteClient {
  instances: string[];
  getInstance(name: string): CapturableClient;
}

/** One accessible name on the page, and whether it was actually reachable. */
export interface NameEntry {
  name: string;
  role: string;
  /** Rendered with a non-empty box and no `visibility`/`display` hiding it. */
  displayed: boolean;
  /** Rendered, but cut off by an ancestor's `overflow` — visible to no one. */
  clipped: boolean;
}

export interface PageProbe {
  url: string;
  title: string;
  userAgent: string;
  language: string;
  viewport: {
    innerWidth: number;
    innerHeight: number;
    devicePixelRatio: number;
  };
  names: NameEntry[];
  console: string[];
  storage: Record<string, string>;
  html: string;
}

interface FailureReport extends Omit<PageProbe, 'html'> {
  test: string;
  client?: string;
  error: { message: string; stack?: string };
}

function isMultiremote(client: unknown): client is MultiremoteClient {
  return (
    !!client &&
    typeof client === 'object' &&
    Array.isArray((client as MultiremoteClient).instances) &&
    typeof (client as MultiremoteClient).getInstance === 'function'
  );
}

/**
 * File-name stem for one capture: the test title, flattened to something every
 * filesystem and artifact uploader accepts.
 */
function slugify(title: string): string {
  const slug = title
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
    .slice(0, 80);
  return slug || 'test';
}

/**
 * Start recording page-side errors.
 *
 * WebKitWebDriver serves no log endpoint, so the only way to see what the app
 * complained about is to keep the messages in the page. Buffers console
 * error/warn calls, uncaught errors and unhandled rejections into a capped
 * ring on `window`, which the probe reads back on failure.
 *
 * Idempotent, and safe to call on a page that has already been instrumented —
 * which matters because a `reloadSession()` or in-app restart drops the
 * buffer, so this is called again from `waitForShell()`.
 */
export async function installPageDiagnostics(client: unknown): Promise<void> {
  const install = () => {
    const key = '__mindstreamDiagnostics';
    const target = window as unknown as Record<string, unknown>;
    if (target[key]) return;
    const buffer: string[] = [];
    target[key] = buffer;
    const record = (kind: string, parts: unknown[]) => {
      if (buffer.length >= 200) return;
      const text = parts
        .map((part) => {
          if (part instanceof Error) return `${part.message}\n${part.stack}`;
          if (typeof part === 'string') return part;
          try {
            return JSON.stringify(part);
          } catch {
            return String(part);
          }
        })
        .join(' ');
      buffer.push(`[${kind}] ${text.slice(0, 2000)}`);
    };
    for (const kind of ['error', 'warn'] as const) {
      const original = console[kind].bind(console);
      console[kind] = (...parts: unknown[]) => {
        record(kind, parts);
        original(...parts);
      };
    }
    window.addEventListener('error', (event) =>
      record('uncaught', [event.error ?? event.message])
    );
    window.addEventListener('unhandledrejection', (event) =>
      record('rejection', [event.reason])
    );
  };

  const clients = isMultiremote(client)
    ? client.instances.map((name) => client.getInstance(name))
    : [client as CapturableClient];
  for (const one of clients) {
    await one
      .execute(install)
      .catch(() => {}) /* a page that can't run scripts can't be probed */;
  }
}

/**
 * Read the page state in one round trip — the session may not survive two.
 *
 * Exported so the Playwright browser tier can run it against a real DOM
 * (e2e-tests/browser/file-tree-toolbar-overflow.spec.ts): it is the one part
 * of this module that can be wrong in a way no type checks, and a probe that
 * throws would take a failure's diagnostics down with it. It must stay
 * closure-free — both wdio and Playwright serialise it into the page.
 */
export function probePage(): PageProbe {
  const names: NameEntry[] = [];
  const selector =
    '[aria-label], button, [role="menuitem"], [role="button"], [role="listitem"]';
  for (const element of Array.from(document.querySelectorAll(selector))) {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    const displayed =
      rect.width > 0 &&
      rect.height > 0 &&
      style.visibility !== 'hidden' &&
      style.display !== 'none' &&
      style.opacity !== '0';

    // Walk the ancestors that clip, and see whether this element survives
    // them. This is the state WebDriver's `isDisplayed` fails on and CSS
    // inspection alone never shows.
    let clipped = false;
    let parent = element.parentElement;
    while (parent && !clipped) {
      const parentStyle = getComputedStyle(parent);
      if (/hidden|clip|auto|scroll/.test(parentStyle.overflow)) {
        const box = parent.getBoundingClientRect();
        clipped =
          rect.right <= box.left + 0.5 ||
          rect.left >= box.right - 0.5 ||
          rect.bottom <= box.top + 0.5 ||
          rect.top >= box.bottom - 0.5;
      }
      parent = parent.parentElement;
    }

    const name =
      element.getAttribute('aria-label') ??
      (element.textContent ?? '').trim().slice(0, 80);
    if (!name) continue;
    names.push({
      name,
      role: element.getAttribute('role') ?? element.tagName.toLowerCase(),
      displayed,
      clipped
    });
  }

  // App state that decides what the UI renders — sidebar widths, toolbar
  // layout, the active profile. Values are capped; nothing here is a secret,
  // but a stray token has no business in an artifact either.
  const storage: Record<string, string> = {};
  try {
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (!key?.startsWith('notes-app:')) continue;
      storage[key] = (localStorage.getItem(key) ?? '').slice(0, 500);
    }
  } catch {
    storage['<unavailable>'] = 'localStorage threw';
  }

  const buffer = (window as unknown as Record<string, unknown>)[
    '__mindstreamDiagnostics'
  ];

  return {
    url: window.location.href,
    title: document.title,
    userAgent: navigator.userAgent,
    language: document.documentElement.lang || navigator.language,
    viewport: {
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      devicePixelRatio: window.devicePixelRatio
    },
    names,
    console: Array.isArray(buffer) ? (buffer as string[]) : [],
    storage,
    html: document.documentElement.outerHTML
  };
}

function describeError(error: unknown): { message: string; stack?: string } {
  if (error instanceof Error) {
    return { message: error.message, stack: error.stack };
  }
  return { message: String(error ?? 'unknown') };
}

async function captureClient(
  client: CapturableClient,
  outputDir: string,
  stem: string,
  report: Pick<FailureReport, 'test' | 'client' | 'error'>
): Promise<void> {
  await client
    .saveScreenshot(join(outputDir, `${stem}.png`))
    .catch((err: unknown) =>
      console.warn(`[capture] screenshot failed for ${stem}:`, err)
    );

  const probe = await client
    .execute(probePage)
    .catch((err: unknown) =>
      console.warn(`[capture] page probe failed for ${stem}:`, err)
    );
  if (!probe) return;

  const { html, ...rest } = probe;
  const header = [
    '<!--',
    `  test:      ${report.test}`,
    `  url:       ${probe.url}`,
    `  viewport:  ${probe.viewport.innerWidth}x${probe.viewport.innerHeight} @ dpr ${probe.viewport.devicePixelRatio}`,
    `  userAgent: ${probe.userAgent}`,
    `  error:     ${report.error.message}`,
    '-->',
    ''
  ].join('\n');
  writeFileSync(join(outputDir, `${stem}.html`), header + html, 'utf8');
  writeFileSync(
    join(outputDir, `${stem}.json`),
    JSON.stringify({ ...report, ...rest }, null, 2),
    'utf8'
  );
}

/**
 * Save a screenshot, the DOM and a diagnostics report for every client in the
 * session.
 *
 * Multiremote runs capture each client separately (`…-browserA.png`), because
 * a two-client failure is usually about the difference between them.
 */
export async function captureFailureArtifacts(options: {
  client: unknown;
  outputDir: string;
  title: string;
  error?: unknown;
}): Promise<void> {
  const { client, outputDir, title, error } = options;
  try {
    mkdirSync(outputDir, { recursive: true });
    const stem = `${slugify(title)}-${Date.now()}`;
    const base = { test: title, error: describeError(error) };
    if (isMultiremote(client)) {
      for (const name of client.instances) {
        await captureClient(
          client.getInstance(name),
          outputDir,
          `${stem}-${name}`,
          { ...base, client: name }
        );
      }
      return;
    }
    await captureClient(client as CapturableClient, outputDir, stem, base);
  } catch (err) {
    console.warn('[capture] failure artifacts unavailable:', err);
  }
}
