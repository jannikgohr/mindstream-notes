// Generate the guest declarations from WIT, adapting jco's JavaScript types
// to the QuickJS ABI: nullable options, required record fields and numeric i64/u64.
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateGuestTypes } from '@bytecodealliance/jco-transpile';
import ts from 'typescript';
import { createRequire } from 'node:module';
const prettier = createRequire(import.meta.url)('prettier');
import { witDir, WORLD } from '../lib/wit.js';

const here = dirname(fileURLToPath(import.meta.url));
export async function generateWitDeclarations() {
  const files = await generateGuestTypes(witDir(), {
    name: 'plugin',
    worldName: WORLD
  });
  const sources = [];
  for (const [name, bytes] of Object.entries(files).sort(([a], [b]) =>
    a.localeCompare(b)
  )) {
    if (!name.startsWith('interfaces/')) continue;
    const text = new TextDecoder()
      .decode(bytes)
      .replace(/^\/\/\/ <reference[^\n]*\n/gm, '');
    const source = ts.createSourceFile(
      name,
      text,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS
    );
    const transformed = ts.transform(source, [
      (context) => {
        const { factory } = context;
        const nullable = (type) =>
          factory.createUnionTypeNode([
            type,
            factory.createLiteralTypeNode(factory.createNull())
          ]);
        const visit = (node) => {
          if (node.kind === ts.SyntaxKind.BigIntKeyword)
            return factory.createKeywordTypeNode(ts.SyntaxKind.NumberKeyword);
          if (node.kind === ts.SyntaxKind.UndefinedKeyword)
            return factory.createLiteralTypeNode(factory.createNull());
          if (ts.isPropertySignature(node) && node.questionToken) {
            return factory.updatePropertySignature(
              node,
              node.modifiers,
              node.name,
              undefined,
              nullable(ts.visitNode(node.type, visit))
            );
          }
          if (ts.isParameter(node) && node.questionToken) {
            return factory.updateParameterDeclaration(
              node,
              node.modifiers,
              node.dotDotDotToken,
              node.name,
              undefined,
              nullable(ts.visitNode(node.type, visit)),
              node.initializer
            );
          }
          return ts.visitEachChild(node, visit, context);
        };
        return (root) => ts.visitNode(root, visit);
      }
    ]);
    sources.push(ts.createPrinter().printFile(transformed.transformed[0]));
    transformed.dispose();
  }
  const config = JSON.parse(
    await readFile(
      join(here, '../../../.config/prettier/.prettierrc.json'),
      'utf8'
    )
  );
  return prettier.format(
    '// Generated from plugin-sdk/wit by scripts/generate-types.mjs.\n' +
      '// QuickJS uses null for options and number for i64/u64. Do not edit by hand.\n\n' +
      sources.join('\n'),
    { ...config, parser: 'typescript' }
  );
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await writeFile(
    join(here, '../src/wit.d.ts'),
    await generateWitDeclarations()
  );
}
