/**
 * T3 — flow 5.4 (docs/e2e/flows.md): a plugin-contributed checking service.
 *
 * Three things only meet at runtime here — a plugin contributing a
 * `textChecker`, the endpoint the user configures for it, and the host that
 * makes every request. The wire client is unit-tested against a loopback
 * socket and the wiring against stubs; what no unit test can show is the app
 * actually reaching a server the user pointed it at and drawing what came back
 * over a live document.
 *
 * The server is a stub in this process rather than a real LanguageTool: a real
 * one is a multi-gigabyte download, and a stub can additionally assert what it
 * RECEIVED. That matters more than the findings it returns — that the app never
 * sends note text to an unverified server is a privacy property, and the only
 * place it is observable is the server's side.
 *
 * Run: pnpm test:e2e:app
 */

import { expect } from '@wdio/globals';
import { createServer, type Server } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import {
  byName,
  clickElement,
  clickName,
  closeSettings,
  dictionaryDir,
  insertText,
  pressElementKey,
  setElementValue,
  setPluginEnabledByName,
  waitForShell
} from '../helpers/harness.js';

const PLUGIN_NAME = 'LanguageTool';
const PROVIDER_ID = 'plugins.com.mindstream.languagetool.grammar';
/** The word the stub always flags, so the assertions do not depend on a rule. */
const FLAGGED = 'teh';

/**
 * A dictionary that knows every word this spec types.
 *
 * Without one the built-in checker flags the whole sentence, and its spelling
 * findings take precedence over the service's on the same word — so the
 * assertions would be about the dictionary, not about the server.
 */
function seedDictionary(): void {
  const dir = dictionaryDir();
  mkdirSync(dir, { recursive: true });
  const words = ['I', 'saw', FLAGGED, 'the', 'cat', 'today', 'another', 'line'];
  writeFileSync(
    join(dir, 'en_US.aff'),
    ['SET UTF-8', 'TRY esianrtolcdugmphbyfvkwz', ''].join('\n'),
    'utf8'
  );
  writeFileSync(
    join(dir, 'en_US.dic'),
    [`${words.length}`, ...words, ''].join('\n'),
    'utf8'
  );
}

/** One request the stub answered, kept so the spec can assert what was sent. */
interface Received {
  path: string;
  body: string;
}

let server: Server;
let endpoint = '';
const received: Received[] = [];

/**
 * A LanguageTool-shaped stub.
 *
 * `/v2/languages` is the probe the "Check" button uses — a plain GET carrying
 * no text. `/v2/check` is the real thing; it flags whatever occurrence of
 * `teh` the submitted text contains, computing the offset from the text it was
 * actually given so the squiggle has to land on the right word.
 */
function startStub(): Promise<void> {
  return new Promise((resolve) => {
    server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        const path = (request.url ?? '').split('?')[0];
        const body = Buffer.concat(chunks).toString('utf8');
        received.push({ path, body });
        response.setHeader('content-type', 'application/json');

        if (path === '/v2/languages') {
          response.end(
            JSON.stringify([
              { name: 'English (US)', code: 'en', longCode: 'en-US' }
            ])
          );
          return;
        }
        if (path === '/v2/check') {
          const text = decodeURIComponent(
            (body.split('&').find((f) => f.startsWith('text=')) ?? '')
              .slice('text='.length)
              .replace(/\+/g, ' ')
          );
          const offset = text.indexOf(FLAGGED);
          response.end(
            JSON.stringify({
              language: { detectedLanguage: { code: 'en', confidence: 0.99 } },
              matches:
                offset === -1
                  ? []
                  : [
                      {
                        message: 'Stub rule: did you mean "the"?',
                        offset,
                        length: FLAGGED.length,
                        // The flagged word leads the list on purpose. Real
                        // services do return a replacement identical to what
                        // they flagged, and applying it does nothing at all —
                        // so the popover has to drop it and offer `the` first.
                        replacements: [{ value: FLAGGED }, { value: 'the' }],
                        rule: { id: 'STUB_RULE', category: { id: 'GRAMMAR' } }
                      }
                    ]
            })
          );
          return;
        }
        response.statusCode = 404;
        response.end('{}');
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      endpoint = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
}

/** Open one plugin's own settings pane. Several cards carry this button. */
async function openPluginSettings(name: string): Promise<void> {
  await browser.execute((pluginName: string) => {
    const buttons = Array.from(
      document.querySelectorAll<HTMLButtonElement>(
        'button[aria-label="Plugin settings"]'
      )
    );
    // Same containment rule as the enable toggle: stay inside the one row
    // that owns this button, or the list's own text matches every plugin.
    const found = buttons.find((button) => {
      let row: HTMLElement | null = button.parentElement;
      while (
        row &&
        row.querySelectorAll('button[aria-label="Plugin settings"]').length ===
          1
      ) {
        if (row.textContent?.includes(pluginName)) return true;
        row = row.parentElement;
      }
      return false;
    });
    if (!found) throw new Error(`no settings button for ${pluginName}`);
    found.click();
  }, name);
}

/**
 * Type into the text input of the settings row carrying this label.
 *
 * The control has no accessible name of its own — the label sits beside it as
 * ordinary text, not wrapped around it and not linked by `for` — so it is
 * reached through the row rather than by name. Values are written through the
 * native setter and announced with `input`, which is what the row's handler
 * listens for.
 */
async function setSettingText(label: string, value: string): Promise<void> {
  await browser.execute(
    (name: string, next: string) => {
      const labelled = Array.from(document.querySelectorAll('*')).find(
        (element) =>
          element.children.length === 0 && element.textContent?.trim() === name
      );
      let row = labelled?.parentElement ?? null;
      let input: HTMLInputElement | null = null;
      for (let up = 0; up < 5 && row && !input; up++) {
        input = row.querySelector<HTMLInputElement>('input[type="text"]');
        row = row.parentElement;
      }
      if (!input) throw new Error(`no text input for ${name}`);
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value'
      )?.set;
      setter?.call(input, next);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    },
    label,
    value
  );
}

async function openPluginsCategory(): Promise<void> {
  await clickName('Open settings');
  await clickName('Plugins');
  await expect(byName('Enable plugin')).toBeDisplayed();
}

/**
 * Everything the Settings dialog currently says, as one line.
 *
 * The checker row reports its outcome as a short phrase next to the Check
 * button. Read through the DOM rather than matched with a text selector: the
 * settings panel scrolls, and an element scrolled out of the pane is not
 * "displayed" as far as WebDriver is concerned even though it is on the page.
 */
async function settingsText(): Promise<string> {
  return browser.execute(() => {
    const dialog = document.querySelector('[role="dialog"]');
    return (dialog?.textContent ?? '<no settings dialog>')
      .replace(/\s+/g, ' ')
      .trim();
  });
}

/** The words carrying a squiggle attributed to the plugin's checker. */
async function checkerFindings(): Promise<string[]> {
  return browser.execute((source: string) => {
    const nodes = document.querySelectorAll(
      `.ProseMirror [data-diagnostic-source="${source}"]`
    );
    return Array.from(nodes).map((node) => node.textContent ?? '');
  }, PROVIDER_ID);
}

async function createRootNote(title: string): Promise<void> {
  await clickName('New note');
  const draft = $('input[placeholder="New note"]');
  await draft.waitForDisplayed();
  await setElementValue(draft, title);
  await pressElementKey(draft, 'Enter');
  await expect(byName(title)).toBeDisplayed();
}

describe('T3 plugin text checker', function () {
  before(async () => {
    seedDictionary();
    await startStub();
    await waitForShell();
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('reaches the configured server without sending note text', async () => {
    // The plugin ships disabled: a checker that sends every paragraph to a
    // server is not something to switch on for the user.
    await openPluginsCategory();
    await setPluginEnabledByName(PLUGIN_NAME, true);
    await openPluginSettings(PLUGIN_NAME);

    await browser.waitUntil(
      async () => (await settingsText()).includes('Server URL'),
      { timeout: 15_000, timeoutMsg: 'the plugin settings pane never opened' }
    );
    await setSettingText('Server URL', endpoint);

    received.length = 0;
    await clickName('Check');
    await browser.waitUntil(
      async () => (await settingsText()).includes('Server reachable'),
      {
        timeout: 30_000,
        timeoutMsg: `checker never reported a reachable server: ${await settingsText()}`
      }
    );

    // Reachability went through the probe path — a plain GET carrying no body
    // at all, which is the point: the common question is "is my container
    // up?", and answering it must not transmit anything.
    //
    // Deliberately not asserted here: that NO check request arrived. Once a
    // server is configured the editor starts checking whatever note is open,
    // which is the feature working rather than the button leaking. What the
    // button itself sends is the assertion above, plus the fixed probe string
    // covered by the Rust tests for the credentialed path.
    const probes = received.filter((r) => r.path === '/v2/languages');
    expect(probes.length).toBeGreaterThan(0);
    expect(probes.every((probe) => probe.body === '')).toBe(true);
    await closeSettings();
  });

  it('draws the findings the server returned', async () => {
    await createRootNote(`Checker ${Date.now()}`);
    await insertText($('.ProseMirror'), `I saw ${FLAGGED} cat today.`);

    await browser.waitUntil(
      async () => (await checkerFindings()).includes(FLAGGED),
      {
        timeout: 45_000,
        timeoutMsg: `expected "${FLAGGED}" to carry a finding from ${PROVIDER_ID}`
      }
    );

    // The offset came back relative to the text the host submitted, so a
    // squiggle on the right word also proves the host rebased it correctly.
    const checks = received.filter((r) => r.path === '/v2/check');
    expect(checks.length).toBeGreaterThan(0);
    expect(checks.at(-1)?.body).toContain('text=');
  });

  it('names the selected language instead of asking the server to guess', async () => {
    // One dictionary is selected here, so there is nothing to detect and
    // nothing to get wrong. Detection is what once had a lone German compound
    // checked against the English speller and underlined as a misspelling; the
    // server's side is the only place the language actually sent is visible.
    const checks = received.filter((r) => r.path === '/v2/check');
    expect(checks.length).toBeGreaterThan(0);
    expect(checks.every((check) => check.body.includes('language=en-US'))).toBe(
      true
    );
    expect(checks.some((check) => check.body.includes('language=auto'))).toBe(
      false
    );
  });

  it('offers the server’s own replacement in the popover', async () => {
    await clickElement(
      $(`.ProseMirror [data-diagnostic-source="${PROVIDER_ID}"]`),
      {
        button: 'right'
      }
    );
    await $('[data-diagnostic-popover]').waitForDisplayed({ timeout: 15_000 });

    // The message is the server's sentence, not one of ours, and so is the
    // replacement list: the app re-ranks only the dictionary's own
    // suggestions, and edits the server's list only as below.
    await expect($('[data-diagnostic-popover]')).toHaveText(
      expect.stringContaining('Stub rule')
    );

    // The one thing the app does edit out of that list: a replacement equal to
    // the word it is replacing. The stub offers it first, so before the filter
    // the click below applied `teh` over `teh` and the sentence never changed.
    const offered = await browser.execute(() =>
      Array.from(
        document.querySelectorAll('[data-diagnostic-action="replace"]')
      ).map((node) => node.textContent?.trim() ?? '')
    );
    expect(offered).not.toContain(FLAGGED);

    await clickElement($('[data-diagnostic-action="replace"]'));

    await expect($('.ProseMirror')).toHaveText(
      expect.stringContaining('I saw the cat today.')
    );
  });

  it('stops checking when the plugin is switched off', async () => {
    await openPluginsCategory();
    await setPluginEnabledByName(PLUGIN_NAME, false);
    await closeSettings();

    await insertText($('.ProseMirror'), ` Another ${FLAGGED} line.`);
    received.length = 0;

    // Nothing more reaches the server, and the findings it produced are gone
    // with the provider that owned them.
    await browser.pause(3_000);
    expect(received.some((r) => r.path === '/v2/check')).toBe(false);
    expect(await checkerFindings()).toEqual([]);
  });
});
