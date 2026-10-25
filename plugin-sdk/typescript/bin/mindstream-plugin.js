#!/usr/bin/env node
// mindstream-plugin: create, build, package and check a Mindstream plugin.

import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { buildComponent } from '../lib/build.js';
import { checkPackage } from '../lib/check.js';
import { createProject } from '../lib/create.js';
import { packagePlugin } from '../lib/package.js';

const usage = `Usage: mindstream-plugin <command> [options]

Commands:
  create <dir>   Start a new plugin project from the starter template.
                 --id <id>       plugin id (default com.example.<dir>)
                 --name <name>   display name (default <dir>)
                 --sdk <spec>    @mindstream/plugin-sdk dependency to write
  build          Bundle the source and build the WebAssembly component.
                 --source <file> entry module (default src/main.ts)
                 --out <file>    component to write (default dist/<entry>)
                 --minify        minify the bundled JavaScript
                 --fast          the larger, faster QuickJS build
  package        Assemble the folder to install: manifest, component, assets.
                 --component <file>  (default dist/<entry>)
                 --out <dir>         (default dist/package)
  check [dir]    Check a plugin folder before installing (default dist/package).
`;

async function entryName() {
  try {
    const manifest = JSON.parse(await readFile('manifest.json', 'utf8'));
    return manifest.entry ?? 'plugin.wasm';
  } catch {
    return 'plugin.wasm';
  }
}

async function main(argv) {
  const [command, ...rest] = argv;
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      id: { type: 'string' },
      name: { type: 'string' },
      sdk: { type: 'string' },
      source: { type: 'string' },
      out: { type: 'string' },
      component: { type: 'string' },
      minify: { type: 'boolean' },
      fast: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' }
    }
  });
  if (!command || values.help || command === 'help') {
    process.stdout.write(usage);
    return 0;
  }
  switch (command) {
    case 'create': {
      const target = positionals[0];
      if (!target) throw new Error('create needs a directory');
      const files = await createProject(target, values);
      console.log(`created ${resolve(target)} (${files.length} files)`);
      console.log(`next: cd ${target} && npm install && npm test`);
      return 0;
    }
    case 'build': {
      const out = values.out ?? join('dist', await entryName());
      const bytes = await buildComponent({
        source: values.source ?? 'src/main.ts',
        out,
        minify: values.minify,
        optSize: !values.fast
      });
      console.log(`built ${out} (${(bytes.length / 1024).toFixed(0)} KiB)`);
      return 0;
    }
    case 'package': {
      const out = values.out ?? join('dist', 'package');
      const files = await packagePlugin({
        root: '.',
        component: values.component ?? join('dist', await entryName()),
        out
      });
      console.log(`packaged ${out}: ${files.join(', ')}`);
      return 0;
    }
    case 'check': {
      const dir = positionals[0] ?? join('dist', 'package');
      const problems = await checkPackage(dir);
      if (problems.length === 0) {
        console.log(`${dir}: ok`);
        return 0;
      }
      for (const problem of problems) console.error(`${dir}: ${problem}`);
      return 1;
    }
    default:
      process.stderr.write(`unknown command "${command}"\n\n${usage}`);
      return 2;
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    console.error(`mindstream-plugin: ${error.message}`);
    process.exitCode = 1;
  }
);
