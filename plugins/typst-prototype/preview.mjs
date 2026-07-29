function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderLine(line) {
  if (line.startsWith('== ')) {
    return `<h2>${escapeHtml(line.slice(3))}</h2>`;
  }
  if (line.startsWith('= ')) {
    return `<h1>${escapeHtml(line.slice(2))}</h1>`;
  }
  if (line === '') return '<div class="gap"></div>';
  return `<p>${escapeHtml(line)
    .replace(/\*([^*]+)\*/g, '<strong>$1</strong>')
    .replace(/_([^_]+)_/g, '<em>$1</em>')}</p>`;
}

export async function render(input) {
  const body = input?.body ?? '';
  const diagnostics = [];
  if (body.includes('#import')) {
    diagnostics.push({
      severity: 'warning',
      message: 'Prototype iframe renderer does not resolve imports yet.'
    });
  }

  const html = [
    '<style>',
    'body{margin:0;background:#fff;color:#1f2937}',
    '#plugin-preview-root{box-sizing:border-box;min-height:100%;padding:28px}',
    'main{max-width:760px;margin:0 auto}',
    'h1{font-size:30px;line-height:1.15;margin:0 0 18px;color:#111827}',
    'h2{font-size:21px;margin:24px 0 10px;color:#111827}',
    'p{margin:0 0 12px}.gap{height:10px}',
    '.badge{font-size:11px;color:#64748b;border-bottom:1px solid #e5e7eb;margin-bottom:22px;padding-bottom:10px}',
    '</style>',
    '<main><div class="badge">Typst plugin iframe preview</div>'
  ];
  for (const line of `${body}\n`.split('\n')) {
    if (line === '' && html.at(-1) === '<div class="gap"></div>') continue;
    html.push(renderLine(line));
  }
  html.push('</main>');

  return {
    preview: { mime: 'text/html', text: html.join('') },
    diagnostics
  };
}
