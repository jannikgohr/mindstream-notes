import {
  definePlugin,
  hasPermission,
  nativeTools,
  type Diagnostic,
  type RenderInput,
  type RenderResult
} from '../../typescript/src/index';

function parseStderr(stderr: string): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  for (const raw of stderr.split('\n')) {
    const line = raw.replace(/[\t\n\v\f\r ]+$/g, '');
    if (!line) continue;
    const start = /^(error|warning):\s*(.*)$/.exec(line);
    if (start) {
      diagnostics.push({
        severity: start[1] as 'error' | 'warning',
        message: start[2]
      });
    } else if (diagnostics.length) {
      diagnostics[diagnostics.length - 1].message += '\n' + line;
    } else {
      diagnostics.push({ severity: 'error', message: line });
    }
  }
  return diagnostics;
}

function renderDocument(input: RenderInput): RenderResult {
  if (
    !hasPermission('nativeTools.runDeclared') ||
    !nativeTools.available('typst')
  ) {
    return { sourceOnly: true, diagnostics: [] };
  }
  const result = nativeTools.run('typst', {
    args: ['compile', '--format', 'pdf', '-', '-'],
    stdin: input.body ?? '',
    outputBase64: true,
    timeoutMs: 30_000
  });
  if (result.timedOut) {
    return {
      preview: { mime: 'application/pdf', dataBase64: '' },
      diagnostics: [
        { severity: 'error', message: 'Typst timed out while compiling.' }
      ]
    };
  }
  return {
    preview: {
      mime: 'application/pdf',
      dataBase64: result.statusCode === 0 ? result.stdoutBase64 : ''
    },
    diagnostics: parseStderr(result.stderr)
  };
}

export const invoke = definePlugin({
  renderDocument,
  exportDocument: renderDocument
});
