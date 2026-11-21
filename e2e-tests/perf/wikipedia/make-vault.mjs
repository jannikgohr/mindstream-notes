/**
 * Builds an Obsidian-style vault from the start of the Simple English
 * Wikipedia dump, for performance tests: one note per article, `[[links]]`
 * between them, categories as tags and redirects as aliases.
 *
 *   node e2e-tests/perf/wikipedia/make-vault.mjs [--articles 20000] [--out DIR]
 *
 * Only as much of the dump is downloaded as the article count needs: it is a
 * series of bzip2 streams, read through `bzip2 -dc` until enough articles are
 * in. The vault is cached in DIR (by default under ~/.cache) and reused while
 * its marker file matches the arguments. Prints the vault path last.
 */
import { spawn } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

// A dated dump, so two runs build the same vault. Wikimedia keeps a few
// months of them; pass --dump to use a newer one.
const DEFAULT_DUMP =
  'https://dumps.wikimedia.org/simplewiki/20261101/simplewiki-20261101-pages-articles-multistream.xml.bz2';

const { values } = parseArgs({
  options: {
    articles: { type: 'string', default: '20000' },
    out: { type: 'string' },
    dump: { type: 'string', default: DEFAULT_DUMP }
  }
});
const wanted = Number(values.articles);
if (!Number.isInteger(wanted) || wanted < 1)
  throw new Error('--articles must be a positive whole number');
const out =
  values.out ??
  join(homedir(), '.cache', 'mindstream-perf', `simplewiki-${wanted}`);
const marker = join(out, '.vault.json');
const params = { dump: values.dump, articles: wanted, version: 1 };

function describe(s) {
  return `${s.notes} notes, ${s.links} links, ${s.tags} tags, ${(s.bytes / 1e6).toFixed(1)} MB`;
}

/** Stream pages out of the dump until `count` articles are read. */
async function readDump(url, count) {
  const articles = [];
  const redirects = [];
  const controller = new AbortController();
  const response = await fetch(url, { signal: controller.signal });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  const bzip2 = spawn('bzip2', ['-dc'], { stdio: ['pipe', 'pipe', 'ignore'] });
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    controller.abort();
    bzip2.kill();
  };
  const feeding = (async () => {
    try {
      for await (const chunk of response.body) {
        if (done) break;
        if (!bzip2.stdin.write(chunk))
          await new Promise((resolve) => bzip2.stdin.once('drain', resolve));
      }
      bzip2.stdin.end();
    } catch (error) {
      if (!done) throw error;
    }
  })();
  bzip2.stdin.on('error', () => {});

  let buffer = '';
  let downloaded = 0;
  bzip2.stdout.setEncoding('utf8');
  for await (const text of bzip2.stdout) {
    buffer += text;
    downloaded += text.length;
    let end;
    while ((end = buffer.indexOf('</page>')) !== -1) {
      const page = buffer.slice(buffer.indexOf('<page>'), end);
      buffer = buffer.slice(end + 7);
      const parsed = parsePage(page);
      if (!parsed) continue;
      if (parsed.redirect) redirects.push(parsed);
      else articles.push(parsed);
      if (articles.length % 2000 === 0)
        console.error(
          `${articles.length} articles (${(downloaded / 1e6).toFixed(0)} MB of XML)`
        );
      if (articles.length >= count) break;
    }
    if (articles.length >= count) break;
  }
  finish();
  await feeding;
  if (articles.length < count)
    console.error(`The dump ended after ${articles.length} articles.`);
  return { articles, redirects };
}

const ENTITIES = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
function unescapeXml(s) {
  return s.replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-f]+);/gi, (m, e) =>
    e[0] === '#'
      ? String.fromCodePoint(
          e[1] === 'x' || e[1] === 'X'
            ? parseInt(e.slice(2), 16)
            : Number(e.slice(1))
        )
      : ENTITIES[e]
  );
}

function parsePage(page) {
  if (!/<ns>0<\/ns>/.test(page)) return null;
  const title = unescapeXml(/<title>([^<]*)<\/title>/.exec(page)?.[1] ?? '');
  if (!title) return null;
  const redirect = /<redirect title="([^"]*)"/.exec(page)?.[1];
  if (redirect) return { title, redirect: unescapeXml(redirect) };
  const text = /<text[^>]*>([\s\S]*?)<\/text>/.exec(page)?.[1] ?? '';
  return { title, text: unescapeXml(text) };
}

/** Remove `open … close` spans, nested ones included. */
function stripNested(s, open, close) {
  let out = '';
  let depth = 0;
  let i = 0;
  while (i < s.length) {
    if (s.startsWith(open, i)) {
      depth++;
      i += open.length;
    } else if (depth && s.startsWith(close, i)) {
      depth--;
      i += close.length;
    } else {
      if (!depth) out += s[i];
      i++;
    }
  }
  return out;
}

/** Remove `[[File:…]]` and `[[Image:…]]`, whose captions hold links. */
function stripFiles(s) {
  const start = /\[\[(?:File|Image):/gi;
  let out = '';
  let from = 0;
  let match;
  while ((match = start.exec(s))) {
    out += s.slice(from, match.index);
    let depth = 0;
    let i = match.index;
    for (; i < s.length; i++) {
      if (s.startsWith('[[', i)) {
        depth++;
        i++;
      } else if (s.startsWith(']]', i)) {
        depth--;
        i++;
        if (!depth) break;
      }
    }
    from = i + 1;
    start.lastIndex = from;
  }
  return out + s.slice(from);
}

function tagFor(category) {
  return category
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
}

/** Wikitext to Markdown, roughly: enough for realistic text, links and tags. */
function convert(text) {
  const tags = new Set();
  let links = 0;
  let s = text
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<ref[^>]*\/>/gi, '')
    .replace(/<ref[^>]*>[\s\S]*?<\/ref>/gi, '');
  s = stripNested(s, '{{', '}}');
  s = stripNested(s, '{|', '|}');
  s = stripFiles(s);
  s = s.replace(/\[\[Category:([^\]|]+)(?:\|[^\]]*)?\]\]/gi, (_, category) => {
    const tag = tagFor(category);
    if (tag) tags.add(tag);
    return '';
  });
  s = s
    // Interlanguage and interwiki links.
    .replace(/\[\[:?[a-z-]{2,12}:[^\]]*\]\]/g, '')
    .replace(
      /\[\[([^\]|]+)(?:\|([^\]]*))?\]\]([a-z]*)/g,
      (_, to, label, tail) => {
        const target = to.split('#')[0].trim();
        const shown = (label?.trim() || to.trim()) + tail;
        if (!target) return shown;
        links++;
        return shown === target ? `[[${target}]]` : `[[${target}|${shown}]]`;
      }
    )
    .replace(/\[(https?:\/\/[^\s\]]+)\s+([^\]]+)\]/g, '[$2]($1)')
    .replace(/\[(https?:\/\/[^\s\]]+)\]/g, '<$1>')
    // Lists before headings and bold, whose Markdown starts with # and *.
    .replace(
      /^([*#]+)\s*/gm,
      (_, marks) =>
        `${'  '.repeat(marks.length - 1)}${marks.endsWith('#') ? '1.' : '-'} `
    )
    .replace(
      /^(={2,6})\s*(.+?)\s*\1\s*$/gm,
      (_, marks, heading) => `${'#'.repeat(marks.length)} ${heading}`
    )
    .replace(/'''''(.+?)'''''/g, '***$1***')
    .replace(/'''(.+?)'''/g, '**$1**')
    .replace(/''(.+?)''/g, '*$1*')
    .replace(/<\/?[a-z][^>]*>/gi, '')
    .replace(/__[A-Z]+__/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { body: s, tags: [...tags], links };
}

function yamlString(s) {
  return JSON.stringify(s);
}

function folderFor(title) {
  const first = title[0].toUpperCase();
  if (/[A-Z]/.test(first)) return first;
  if (/[0-9]/.test(first)) return '0-9';
  return 'Other';
}

async function writeVault(articles, redirects) {
  await rm(out, { recursive: true, force: true });
  await mkdir(join(out, '.obsidian'), { recursive: true });
  await writeFile(join(out, '.obsidian', 'app.json'), '{}');
  const aliases = new Map();
  for (const { title, redirect } of redirects) {
    const list = aliases.get(redirect) ?? [];
    list.push(title);
    aliases.set(redirect, list);
  }
  const used = new Set();
  const stats = { notes: 0, links: 0, tags: 0, bytes: 0 };
  const allTags = new Set();
  const folders = new Set();
  for (const { title, text } of articles) {
    const { body, tags, links } = convert(text);
    const folder = folderFor(title);
    let name = title.replace(/[/\\:*?"<>|]/g, '-');
    for (let n = 2; used.has(`${folder}/${name}`.toLowerCase()); n++)
      name = `${title.replace(/[/\\:*?"<>|]/g, '-')} (${n})`;
    used.add(`${folder}/${name}`.toLowerCase());
    const front = [`title: ${yamlString(title)}`];
    if (tags.length)
      front.push('tags:', ...tags.map((tag) => `  - ${yamlString(tag)}`));
    const alias = aliases.get(title);
    if (alias?.length)
      front.push('aliases:', ...alias.map((a) => `  - ${yamlString(a)}`));
    const file = `---\n${front.join('\n')}\n---\n\n${body}\n`;
    if (!folders.has(folder)) {
      folders.add(folder);
      await mkdir(join(out, folder), { recursive: true });
    }
    await writeFile(join(out, folder, `${name}.md`), file);
    stats.notes++;
    stats.links += links;
    stats.bytes += Buffer.byteLength(file);
    for (const tag of tags) allTags.add(tag);
  }
  stats.tags = allTags.size;
  return stats;
}

const cached = await readFile(marker, 'utf8')
  .then((text) => JSON.parse(text))
  .catch(() => null);
if (JSON.stringify(cached?.params) === JSON.stringify(params)) {
  console.error(`Using the cached vault (${describe(cached.stats)}).`);
  console.log(out);
  process.exit(0);
}

const { articles, redirects } = await readDump(values.dump, wanted);
const stats = await writeVault(articles, redirects);
await writeFile(marker, JSON.stringify({ params, stats }, null, 2));
console.error(`Wrote ${describe(stats)}.`);
console.log(out);
