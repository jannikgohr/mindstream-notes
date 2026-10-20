// @vitest-environment node
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { generateWitDeclarations } from '../scripts/generate-types.mjs';

const wit = join(__dirname, '..', '..', 'wit');
const declarations = readFileSync(
  join(__dirname, '..', 'src', 'wit.d.ts'),
  'utf8'
);

const camel = (name: string) =>
  name.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());

/** `interface name { ... }` blocks and the function names inside them. */
function witFunctions(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const file of readdirSync(wit).filter((f) => f.endsWith('.wit'))) {
    const text = readFileSync(join(wit, file), 'utf8');
    for (const match of text.matchAll(/interface ([\w-]+) \{([\s\S]*?)\n\}/g)) {
      const names = [...match[2].matchAll(/^\s*%?([\w-]+): func/gm)].map((m) =>
        camel(m[1])
      );
      out.set(match[1], names);
    }
  }
  return out;
}

describe('generated QuickJS WIT declarations', () => {
  it('match the current WIT, including field and option types', async () => {
    expect((await generateWitDeclarations()).replace(/\r\n/g, '\n')).toBe(
      declarations.replace(/\r\n/g, '\n')
    );
  });
  it('declare every function of every interface', () => {
    const interfaces = witFunctions();
    expect([...interfaces.keys()].sort()).toEqual(
      [
        'clock',
        'markdown',
        'native-tools',
        'notes',
        'runtime',
        'storage',
        'types'
      ].sort()
    );
    for (const [name, functions] of interfaces) {
      const block = declarations.match(
        new RegExp(
          `declare module 'mindstream:plugin/${name}@0\\.1\\.0' \\{([\\s\\S]*?)\\n\\}`
        )
      );
      expect(block, name).not.toBeNull();
      for (const fn of functions) {
        const declared =
          fn === 'delete'
            ? /function _delete\(/.test(block![1])
            : new RegExp(`function ${fn}\\(`).test(block![1]);
        expect(declared, `${name}.${fn}`).toBe(true);
      }
    }
  });
});
