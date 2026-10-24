import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const directory = join(
  dirname(require.resolve('@excalidraw/excalidraw')),
  'fonts'
);

/** @returns {string[]} */
function fontFiles(root = directory) {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    return entry.isDirectory()
      ? fontFiles(path)
      : entry.name.endsWith('.woff2')
        ? [path]
        : [];
  });
}

/**
 * Serve and package Excalidraw fonts locally for offline image exports.
 * @returns {import('vite').Plugin}
 */
export function excalidrawFonts() {
  let ssr = false;
  return {
    name: 'excalidraw-fonts',
    configResolved(config) {
      ssr = Boolean(config.build.ssr);
    },
    configureServer(server) {
      const files = new Map(
        fontFiles().map((path) => [
          `/excalidraw/fonts/${relative(directory, path).split(sep).join('/')}`,
          path
        ])
      );
      server.middlewares.use((request, response, next) => {
        const path = files.get((request.url ?? '').split('?')[0]);
        if (!path) return next();
        response.setHeader('Content-Type', 'font/woff2');
        response.end(readFileSync(path));
      });
    },
    generateBundle() {
      if (ssr) return;
      for (const path of fontFiles()) {
        this.emitFile({
          type: 'asset',
          fileName: `excalidraw/fonts/${relative(directory, path).split(sep).join('/')}`,
          source: readFileSync(path)
        });
      }
    }
  };
}
