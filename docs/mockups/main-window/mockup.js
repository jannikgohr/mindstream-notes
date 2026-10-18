// A local, temporary design prototype. No app APIs, network requests, or storage.
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const icon = (name, className = '') =>
  `<svg class="${className}" aria-hidden="true"><use href="#i-${name}" /></svg>`;
const escapeHtml = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        character
      ]
  );

const noteTypes = {
  markdown: {
    label: 'Markdown note',
    shortLabel: 'Markdown',
    icon: 'note',
    description: 'Every thought starts somewhere.'
  },
  freeform: {
    label: 'Drawing canvas',
    shortLabel: 'Drawing',
    icon: 'drawing',
    description: 'A little space for the bigger picture.'
  },
  ink: {
    label: 'Handwritten note',
    shortLabel: 'Handwriting',
    icon: 'pen',
    description: 'Think it through, one pen stroke at a time.'
  },
  kanban: {
    label: 'Kanban board',
    shortLabel: 'Kanban',
    icon: 'board',
    description: 'A clear view of what comes next.'
  },
  pdf: {
    label: 'PDF document',
    shortLabel: 'PDF',
    icon: 'pdf',
    description: 'Read closely. Keep what matters.'
  }
};
const typeOf = (note) => noteTypes[note?.kind || 'markdown'];
let createKind = 'markdown';

const notes = [
  {
    id: 'workspace',
    title: 'A calmer workspace',
    description: 'Less friction. More room for what’s on your mind.',
    folder: 'Mindstream',
    favorite: true,
    tags: ['design', 'ideas'],
    shared: false,
    body: `<h2>The feeling we’re after</h2>
      <p>A good workspace gets out of the way. Open a note, pick up a thought, and let one idea lead to the next. Everything you need should feel like it belongs.</p>
      <div class="callout" contenteditable="false">${icon('logo')}<div><strong>A quieter kind of productive.</strong><p>One familiar rhythm, from your first note to your next big idea.</p></div></div>
      <h2>A few things to keep in mind</h2>
      <p>Make the everyday things effortless. Keep the structure clear, the details close, and the focus on <strong>the note in front of you.</strong></p>
      <div class="checklist" contenteditable="false">
        <label><input type="checkbox" checked /><span>Give every panel the same visual language</span></label>
        <label><input type="checkbox" checked /><span>Keep navigation and writing comfortably separate</span></label>
        <label><input type="checkbox" /><span>Make space for the little details</span></label>
      </div>
      <h2>Where this goes next</h2>
      <p>A few loose thoughts are becoming a plan. Collect the references, connect the dots, and work through the <a href="#note=launch" data-note-link="launch">launch checklist ↗</a> when it’s time.</p>
      <p class="closing">No rush. Good things take a little space.</p>`
  },
  {
    id: 'launch',
    title: 'Launch checklist',
    description: 'Small steps toward something worth sharing.',
    folder: 'Mindstream',
    favorite: true,
    tags: ['planning', 'mindstream'],
    shared: false,
    body: `<h2>Make it feel right</h2><p>A short list to keep the next release focused. Start with the things people touch every day.</p><div class="checklist" contenteditable="false"><label><input type="checkbox" checked /><span>Bring the main window into one consistent system</span></label><label><input type="checkbox" /><span>Review the light and dark themes side by side</span></label><label><input type="checkbox" /><span>Walk through creating, finding, and editing a note</span></label><label><input type="checkbox" /><span>Check the layout at smaller window sizes</span></label></div><h2>Before sharing</h2><p>Take a step back and revisit <a href="#note=workspace" data-note-link="workspace">A calmer workspace ↗</a>. Does the experience still feel simple?</p><blockquote>The best tools leave you thinking about your work.</blockquote><h2>After launch</h2><p>Listen, take notes, and make the next small improvement.</p>`
  },
  {
    id: 'research',
    title: 'Research & references',
    description: 'A few useful threads to come back to.',
    folder: 'Mindstream',
    favorite: false,
    tags: ['research'],
    shared: false,
    body: '<h2>Patterns worth keeping</h2><p>Familiar navigation. Predictable controls. A document that feels like a place to write.</p><ul><li>Use a single accent for selection and links.</li><li>Let spacing explain which things belong together.</li><li>Keep properties in the sidebar, within easy reach.</li></ul><h2>Questions to explore</h2><p>Can someone find a note without learning a new system? Does the window still feel calm with both sidebars open?</p><h2>Next reading session</h2><p>Look at how writing tools handle the space between navigation and the page. Take notes on what feels natural.</p>'
  },
  {
    id: 'daily',
    title: 'A few things for today',
    description: 'Friday, October 16. A fresh page.',
    folder: 'Personal',
    favorite: false,
    tags: ['daily'],
    shared: false,
    body: '<h2>On my mind</h2><p>Leave a little more space between the things that need doing. There’s room for a walk, a good coffee, and an idea that isn’t fully formed yet.</p><h2>A small intention</h2><div class="checklist" contenteditable="false"><label><input type="checkbox" /><span>Finish one thing before starting the next</span></label><label><input type="checkbox" /><span>Write down something worth remembering</span></label></div><h2>For later</h2><p>Keep this space open.</p>'
  },
  {
    id: 'reading',
    title: 'The reading shelf',
    description: 'Good words have a way of staying with you.',
    folder: 'Reading',
    favorite: false,
    tags: ['books', 'inspiration'],
    shared: false,
    body: '<h2>What I’m collecting</h2><p>Passages, questions, and ideas that deserve a second read. A small personal index of things that made me pause.</p><h2>A note to myself</h2><blockquote>Read slowly enough to notice what you think.</blockquote><h2>Connections</h2><p>The most useful notes connect something new to something you already care about.</p>'
  },
  {
    id: 'shared',
    title: 'Ideas for the next chapter',
    description: 'A shared starting point for a new project.',
    folder: 'Shared',
    favorite: false,
    tags: ['team', 'ideas'],
    shared: true,
    body: '<h2>A place to start</h2><p>Every good project starts with a conversation. Collect the questions first, then make room for a few surprising answers.</p><h2>Open questions</h2><ul><li>What would make the biggest difference?</li><li>What can we make simpler?</li><li>What should we try first?</li></ul><h2>Next conversation</h2><p>Bring one idea and one question.</p>'
  }
];

notes.push(
  {
    id: 'board',
    kind: 'kanban',
    title: 'Project board',
    description: noteTypes.kanban.description,
    folder: 'Mindstream',
    favorite: false,
    tags: ['planning'],
    shared: false
  },
  {
    id: 'drawing',
    kind: 'freeform',
    title: 'Connected ideas',
    description: noteTypes.freeform.description,
    folder: 'Mindstream',
    favorite: false,
    tags: ['ideas'],
    shared: false
  },
  {
    id: 'ink',
    kind: 'ink',
    title: 'Thinking on paper',
    description: noteTypes.ink.description,
    folder: 'Mindstream',
    favorite: false,
    tags: ['sketchbook'],
    shared: false
  }
);

function typePreview(note) {
  if (note.kind === 'kanban')
    return `<div class="board-preview type-preview" aria-label="Kanban board layout preview">${[
      [
        'To do',
        'Make the everyday things effortless',
        'Review the small-window layout'
      ],
      ['In progress', 'Bring the workspace together'],
      ['Done', 'Find a calmer visual direction']
    ]
      .map(
        ([title, ...cards]) =>
          `<section class="board-column"><h2><span class="board-dot"></span>${title}<span>${cards.length}</span></h2>${cards.map((card) => `<div class="board-card"><span class="board-card-tag">Design</span><p>${card}</p><small>${icon('note')}Mindstream</small></div>`).join('')}<div class="preview-add">${icon('plus')}Add a card</div></section>`
      )
      .join('')}</div>`;
  if (note.kind === 'freeform')
    return `<div class="drawing-preview type-preview" aria-label="Drawing canvas layout preview"><div class="diagram-node main-node">A calmer workspace</div><div class="diagram-branches"><div class="diagram-node">Clear navigation</div><div class="diagram-node">Room to write</div><div class="diagram-node">Details nearby</div></div><p class="preview-caption">Shapes, connections, and a little room to think.</p></div>`;
  if (note.kind === 'ink')
    return `<div class="ink-preview type-preview" aria-label="Handwritten page layout preview"><span class="paper-page">01</span><p class="handwritten">Make room<br>for the next idea.</p><div class="ink-underline"></div><p class="handwritten small-handwriting">Start with the things that matter.</p></div>`;
  return `<div class="pdf-preview type-preview" aria-label="PDF annotation layout preview"><span class="paper-page">1 / 1</span><p class="pdf-eyebrow">READING NOTES</p><h2>A little more perspective</h2><p>A page is a place to pause. Follow the thought, keep the useful parts, and come back when you need them.</p><p><mark>Good ideas deserve a second look.</mark></p><p>This is a sample page showing the PDF layout. The selected file is not rendered in this mockup.</p></div>`;
}

const folders = [
  { name: 'Projects', level: 0, open: true, parent: null },
  { name: 'Mindstream', level: 1, open: true, parent: 'Projects' },
  { name: 'Personal', level: 0, open: false, parent: null },
  { name: 'Reading', level: 0, open: false, parent: null }
];
let activeId = 'workspace';
let openIds = ['workspace', 'board'];
let view = 'all';
let sourceView = false;
let inputAction = null;
let toastTimer;
let searchIndex = 0;
let focusLayout = null;
let editorSelection = null;

function activeNote() {
  return notes.find((note) => note.id === activeId);
}
function visibleNotes() {
  if (view === 'trash') return [];
  return notes.filter((note) =>
    view === 'favorites'
      ? note.favorite
      : view === 'shared'
        ? note.shared
        : !note.shared
  );
}

function noteRow(note, level = 0) {
  return `<button class="tree-row note level-${level}${note.id === activeId ? ' active' : ''}" data-open-note="${note.id}"${note.id === activeId ? ' aria-current="page"' : ''}>${icon(typeOf(note).icon)}<span>${escapeHtml(note.title)}</span>${note.favorite ? icon('star', 'tiny-star') : ''}</button>`;
}

function renderTree() {
  $('#note-count').textContent = notes.filter((note) => !note.shared).length;
  $('#favorite-count').textContent = notes.filter(
    (note) => note.favorite
  ).length;
  $('#tree-heading').textContent = {
    all: 'WORKSPACE',
    favorites: 'FAVORITES',
    shared: 'SHARED NOTES',
    trash: 'TRASH'
  }[view];
  $('#new-folder').hidden = view !== 'all';
  const visible = visibleNotes();
  if (view !== 'all') {
    $('#note-tree').innerHTML = visible.length
      ? visible.map((note) => noteRow(note)).join('')
      : '<p class="tree-empty">A little less clutter.<br>No notes here.</p>';
    return;
  }
  let html = '';
  for (const folder of folders) {
    if (
      folder.parent &&
      !folders.find((parent) => parent.name === folder.parent)?.open
    )
      continue;
    html += `<button class="tree-row folder level-${folder.level}" data-folder="${escapeHtml(folder.name)}" aria-expanded="${folder.open}">${icon(folder.open ? 'down' : 'chevron', 'tree-chevron')}${icon('folder')}<span>${escapeHtml(folder.name)}</span></button>`;
    if (folder.open)
      html += visible
        .filter((note) => note.folder === folder.name)
        .map((note) => noteRow(note, folder.level + 1))
        .join('');
  }
  $('#note-tree').innerHTML = html;
}

function renderTabs() {
  $('#tabs').innerHTML = openIds
    .map((id) => {
      const note = notes.find((item) => item.id === id);
      return `<div class="tab" role="presentation" data-tab="${id}"><button class="tab-label" id="tab-${id}" role="tab" aria-selected="${id === activeId}" tabindex="${id === activeId ? '0' : '-1'}" data-open-note="${id}" aria-controls="document">${icon(typeOf(note).icon)}<span>${escapeHtml(note.title)}</span></button><button class="icon-button" data-close-note="${id}" aria-label="Close ${escapeHtml(note.title)}">${icon('close')}</button></div>`;
    })
    .join('');
  // Paint the entire tab background while keeping its semantics on the button.
  $$('.tab').forEach((tab) =>
    tab.classList.toggle('active', tab.dataset.tab === activeId)
  );
}

function renderDocument() {
  const note = activeNote();
  $('#document').hidden = !note;
  $('#empty-editor').hidden = Boolean(note);
  $('#editor-toolbar').inert = !note;
  if (!note) {
    $('#document').innerHTML = '';
    $('#detail-title').textContent = 'No note selected';
    $('#word-count').textContent = '0 words';
    $('#read-time').textContent = '0 min read';
    $('#details-panel').hidden = true;
    return;
  }
  $('#details-panel').hidden = false;
  const markdown = !note.kind || note.kind === 'markdown';
  const type = typeOf(note);
  $('#document').classList.toggle('visual-document', !markdown);
  $$(
    '#editor-toolbar > button:not(#favorite-note), #editor-toolbar > .action-divider'
  ).forEach((control) => {
    control.hidden = !markdown;
  });
  $('#type-toolbar-label').hidden = markdown;
  $('#type-toolbar-label').innerHTML =
    `${icon(type.icon)}${type.label}<span>Layout preview</span>`;
  $('#outline-section').hidden = !markdown;
  $('.document-type').innerHTML =
    `${icon(type.icon)}${type.label.toUpperCase()}`;
  $('#status-type').textContent = type.shortLabel;
  $('#document').innerHTML =
    `<div class="note-eyebrow">${icon('folder')}<span>${escapeHtml(note.folder.toUpperCase())}</span></div><h1 class="note-title" contenteditable="plaintext-only" aria-label="Note title" spellcheck="false">${escapeHtml(note.title)}</h1><p class="note-description">${escapeHtml(note.description)}</p><div class="note-meta"><span>${icon('clock')}Edited ${note.edited ? 'just now' : 'today at 10:34'}</span><span>${icon(type.icon)}${type.shortLabel}</span><span class="meta-tag">${escapeHtml(note.tags[0] || 'note')}</span></div>${markdown ? `<div class="editor-body" contenteditable="true" role="textbox" aria-label="Note body" aria-multiline="true" spellcheck="false">${note.body}</div>` : typePreview(note)}`;
  $('#source-toggle').setAttribute('aria-pressed', 'false');
  sourceView = false;
  editorSelection = null;
  $('#text-style-label').textContent = 'Text';
  $('#document-scroller').scrollTop = 0;
  $('#detail-title').textContent = note.title;
  $('#detail-location').textContent = note.folder;
  $('.note-summary p').textContent = note.shared
    ? 'Shared with your workspace.'
    : 'A place for the next good idea.';
  $('.inspector-note span').textContent = note.shared
    ? 'Shared demo note · sample access.'
    : 'Only you have access to this note.';
  $('#detail-edited').textContent = note.edited ? 'Just now' : 'Today, 10:34';
  $('#history-time').textContent = note.edited
    ? 'Edited just now'
    : 'Today at 10:34';
  $('#save-indicator span').textContent = note.edited
    ? 'In this session'
    : 'Demo note';
  renderFavorite();
  renderTags();
  updateContentDetails();
}

function renderFavorite() {
  const favorite = Boolean(activeNote()?.favorite);
  $('#favorite-note').setAttribute('aria-pressed', String(favorite));
  $('#favorite-note').setAttribute(
    'aria-label',
    favorite ? 'Remove from favorites' : 'Add to favorites'
  );
}

function renderTags() {
  $('#tag-list').innerHTML = (activeNote()?.tags || [])
    .map(
      (tag, index) =>
        `<button class="tag" data-remove-tag="${index}" title="Remove ${escapeHtml(tag)} tag" aria-label="Remove ${escapeHtml(tag)} tag"><span>#</span>${escapeHtml(tag)}</button>`
    )
    .join('');
}

function updateContentDetails() {
  const body = $('.editor-body');
  $('#read-time').hidden = !body;
  $('#read-time').nextElementSibling.hidden = !body;
  if (!body) {
    $('#word-count').textContent =
      activeNote()?.kind === 'kanban'
        ? '3 columns'
        : activeNote()?.kind === 'freeform'
          ? 'Infinite canvas'
          : '1 page';
    return;
  }
  const words = body.innerText.trim().split(/\s+/).filter(Boolean).length;
  $('#word-count').textContent = `${words} words`;
  $('#read-time').textContent =
    `${Math.max(1, Math.ceil(words / 200))} min read`;
  const headings = [...body.querySelectorAll('h2, h3')];
  const outline = headings
    .map((heading, index) => {
      heading.id = `section-${index}`;
      return `<button data-outline-target="section-${index}"${heading.tagName === 'H3' ? ' style="padding-left:24px"' : ''}>${escapeHtml(heading.textContent)}</button>`;
    })
    .join('');
  $('#mini-outline').innerHTML =
    outline ||
    '<span class="tree-empty">Add a heading to start an outline.</span>';
  $('#outline-count').textContent = headings.length;
}

function saveDocument() {
  const note = activeNote();
  const body = $('.editor-body');
  if (!note || !body) return;
  body
    .querySelectorAll('input[type="checkbox"]')
    .forEach((checkbox) =>
      checkbox.toggleAttribute('checked', checkbox.checked)
    );
  note.body = body.innerHTML;
  note.edited = true;
  $('#save-indicator span').textContent = 'In this session';
  $('#edit-status').textContent = 'Demo edits · kept until reload';
  $('#detail-edited').textContent = 'Just now';
  $('#history-time').textContent = 'Edited just now';
  updateContentDetails();
}

function openNote(id) {
  if (!notes.some((note) => note.id === id)) return;
  saveCurrentTitle();
  activeId = id;
  if (!openIds.includes(id)) openIds.push(id);
  const folder = folders.find((item) => item.name === activeNote().folder);
  if (folder) {
    folder.open = true;
    if (folder.parent)
      folders.find((item) => item.name === folder.parent).open = true;
  }
  renderTree();
  renderTabs();
  renderDocument();
  $(`#tab-${id}`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  if (window.innerWidth <= 620) $('#app').classList.remove('sidebar-overlay');
}

function saveCurrentTitle() {
  const title = $('.note-title');
  if (!title || !activeNote()) return;
  const value = title.textContent.trim() || 'Untitled note';
  if (activeNote().title !== value) {
    activeNote().title = value;
    activeNote().edited = true;
    $('#detail-title').textContent = value;
    renderTree();
    renderTabs();
  }
}

function setView(nextView) {
  view = nextView;
  $$('.nav-row').forEach((row) => {
    row.classList.toggle('active', row.dataset.view === view);
    if (row.dataset.view === view) row.setAttribute('aria-current', 'page');
    else row.removeAttribute('aria-current');
  });
  renderTree();
}

function toast(message) {
  clearTimeout(toastTimer);
  $('#toast').textContent = message;
  $('#toast').hidden = false;
  toastTimer = setTimeout(() => {
    $('#toast').hidden = true;
  }, 3200);
}

function requestName(action) {
  inputAction = action;
  const labels = {
    note: [
      `New ${noteTypes[createKind].label.toLowerCase()}`,
      'Note title',
      'Create note'
    ],
    folder: ['New folder', 'Folder name', 'Create folder'],
    tag: ['Add a tag', 'Tag name', 'Add tag'],
    link: ['Insert a link', 'URL (https://…)', 'Insert link']
  }[action];
  if (action === 'link') rememberSelection();
  $('#input-title').textContent = labels[0];
  $('#input-label').textContent = labels[1];
  $('#confirm-input').textContent = labels[2];
  $('#name-input').value = '';
  $('#name-input').setCustomValidity('');
  $('#input-dialog').showModal();
  $('#name-input').focus();
}

function rememberSelection() {
  const selection = window.getSelection();
  if (
    selection?.rangeCount &&
    $('.editor-body')?.contains(selection.anchorNode)
  )
    editorSelection = selection.getRangeAt(0).cloneRange();
}

function restoreSelection() {
  $('.editor-body')?.focus();
  if (
    editorSelection &&
    $('.editor-body')?.contains(editorSelection.commonAncestorContainer)
  ) {
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(editorSelection);
  }
}

function format(command, value) {
  if (
    sourceView ||
    !activeNote() ||
    (activeNote().kind && activeNote().kind !== 'markdown')
  )
    return;
  restoreSelection();
  document.execCommand(command, false, value);
  rememberSelection();
  saveDocument();
}

function toggleInspector() {
  const app = $('#app');
  if (window.innerWidth <= 900) app.classList.toggle('inspector-overlay');
  else app.classList.toggle('hide-inspector');
  updatePanelControls();
}

function updatePanelControls() {
  const app = $('#app');
  const inspectorVisible =
    window.innerWidth <= 900
      ? app.classList.contains('inspector-overlay')
      : !app.classList.contains('hide-inspector');
  const sidebarVisible =
    window.innerWidth <= 620
      ? app.classList.contains('sidebar-overlay')
      : !app.classList.contains('hide-sidebar');
  $('#toggle-inspector').classList.toggle('selected', inspectorVisible);
  $('#toggle-inspector').setAttribute(
    'aria-expanded',
    String(inspectorVisible)
  );
  $('#toggle-inspector').setAttribute(
    'aria-label',
    inspectorVisible ? 'Hide note details' : 'Show note details'
  );
  $('#toggle-sidebar').setAttribute('aria-expanded', String(sidebarVisible));
  $('#toggle-sidebar').setAttribute(
    'aria-label',
    sidebarVisible ? 'Hide navigation' : 'Show navigation'
  );
}

function openSearch() {
  $('#search-dialog').showModal();
  $('#search-input').value = '';
  searchIndex = 0;
  renderSearch();
  $('#search-input').focus();
}

function renderSearch() {
  const query = $('#search-input').value.trim().toLowerCase();
  const matches = notes.filter((note) =>
    `${note.title} ${note.description} ${note.tags.join(' ')}`
      .toLowerCase()
      .includes(query)
  );
  searchIndex = Math.max(0, Math.min(searchIndex, matches.length - 1));
  $('#search-results').innerHTML = matches.length
    ? matches
        .map(
          (note, index) =>
            `<button class="search-result${index === searchIndex ? ' highlighted' : ''}" data-search-note="${note.id}">${icon(typeOf(note).icon)}<span><strong>${escapeHtml(note.title)}</strong><small>${escapeHtml(note.folder)} · ${note.shared ? 'Shared · ' : ''}${typeOf(note).label}</small></span>${icon('arrow', 'result-arrow')}</button>`
        )
        .join('')
    : '<p class="tree-empty">No notes found. Try another thought.</p>';
}

function sourcePreview() {
  const source = $('.editor-body').cloneNode(true);
  source
    .querySelectorAll('h2')
    .forEach((node) => node.replaceWith(`\n## ${node.textContent}\n`));
  source
    .querySelectorAll('h3')
    .forEach((node) => node.replaceWith(`\n### ${node.textContent}\n`));
  source
    .querySelectorAll('strong')
    .forEach((node) => node.replaceWith(`**${node.textContent}**`));
  source
    .querySelectorAll('a')
    .forEach((node) =>
      node.replaceWith(`[${node.textContent}](${node.getAttribute('href')})`)
    );
  source
    .querySelectorAll('.checklist label')
    .forEach((node) =>
      node.replaceWith(
        `\n- [${node.querySelector('input').checked ? 'x' : ' '}] ${node.textContent.trim()}`
      )
    );
  source
    .querySelectorAll('p, .callout, blockquote, ul, li')
    .forEach((node) => node.append(document.createTextNode('\n\n')));
  return `# ${activeNote().title}\n\n${activeNote().description}\n\n${source.textContent.trim().replace(/\n{3,}/g, '\n\n')}`;
}

$('#note-tree').addEventListener('click', (event) => {
  const row = event.target.closest('[data-folder]');
  if (row) {
    const folder = folders.find((item) => item.name === row.dataset.folder);
    folder.open = !folder.open;
    renderTree();
  }
});
document.addEventListener('click', (event) => {
  const open = event.target.closest('[data-open-note], [data-note-link]');
  if (open) {
    event.preventDefault();
    openNote(open.dataset.openNote || open.dataset.noteLink);
    return;
  }
  const close = event.target.closest('[data-close-note]');
  if (close) {
    saveCurrentTitle();
    const index = openIds.indexOf(close.dataset.closeNote);
    openIds = openIds.filter((id) => id !== close.dataset.closeNote);
    if (activeId === close.dataset.closeNote)
      activeId = openIds[Math.min(index, openIds.length - 1)] || null;
    renderTree();
    renderTabs();
    renderDocument();
  }
  const outline = event.target.closest('[data-outline-target]');
  if (outline) {
    const target = document.getElementById(outline.dataset.outlineTarget);
    target?.scrollIntoView({
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches
        ? 'instant'
        : 'smooth',
      block: 'start'
    });
  }
  const tag = event.target.closest('[data-remove-tag]');
  if (tag && activeNote()) {
    activeNote().tags.splice(Number(tag.dataset.removeTag), 1);
    renderTags();
  }
  const result = event.target.closest('[data-search-note]');
  if (result) {
    $('#search-dialog').close();
    const note = notes.find((item) => item.id === result.dataset.searchNote);
    setView(note.shared ? 'shared' : 'all');
    openNote(note.id);
  }
});
document.addEventListener('selectionchange', rememberSelection);
$('#document').addEventListener('input', (event) => {
  if (event.target.closest('.editor-body')) saveDocument();
});
$('#document').addEventListener('change', (event) => {
  if (event.target.matches('input[type="checkbox"]')) saveDocument();
});
$('#document').addEventListener('focusout', (event) => {
  if (event.target.matches('.note-title')) saveCurrentTitle();
});
$('#document').addEventListener('keydown', (event) => {
  if (event.target.matches('.note-title') && event.key === 'Enter') {
    event.preventDefault();
    $('.editor-body')?.focus();
  }
});
// Paste plain text so copied web markup cannot import styles or executable content.
$('#document').addEventListener('paste', (event) => {
  if (event.target.closest('[contenteditable]')) {
    event.preventDefault();
    document.execCommand(
      'insertText',
      false,
      event.clipboardData.getData('text/plain')
    );
  }
});
$$('.nav-row').forEach((button) =>
  button.addEventListener('click', () => setView(button.dataset.view))
);
['#new-note', '#tab-new-note', '#empty-new-note'].forEach((selector) =>
  $(selector).addEventListener('click', (event) =>
    openCreateMenu(event.currentTarget)
  )
);
$('#new-folder').addEventListener('click', () => requestName('folder'));
$('#add-tag').addEventListener('click', () => {
  if (activeNote()) requestName('tag');
});
$('#insert-link').addEventListener('click', () => requestName('link'));
$('#cancel-input').addEventListener('click', () => $('#input-dialog').close());
$('#name-input').addEventListener('input', () =>
  $('#name-input').setCustomValidity('')
);
$('#input-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const value = $('#name-input').value.trim();
  if (!value) {
    $('#name-input').setCustomValidity('Please enter a name.');
    $('#name-input').reportValidity();
    return;
  }
  if (inputAction === 'link') {
    let url;
    try {
      url = new URL(value);
    } catch {
      /* Handled by the validation message below. */
    }
    if (!url || !['http:', 'https:'].includes(url.protocol)) {
      $('#name-input').setCustomValidity('Enter an http or https URL.');
      $('#name-input').reportValidity();
      return;
    }
    $('#input-dialog').close();
    format('createLink', url.href);
    return;
  }
  if (inputAction === 'folder') {
    if (
      folders.some(
        (folder) => folder.name.toLowerCase() === value.toLowerCase()
      )
    ) {
      $('#name-input').setCustomValidity(
        'A folder with that name already exists.'
      );
      $('#name-input').reportValidity();
      return;
    }
    folders.push({ name: value, level: 0, open: true, parent: null });
    setView('all');
  }
  if (inputAction === 'note') {
    createDemoNote(createKind, value);
  }
  if (inputAction === 'tag' && activeNote()) {
    if (!activeNote().tags.includes(value)) activeNote().tags.push(value);
    renderTags();
  }
  $('#input-dialog').close();
});
$('#favorite-note').addEventListener('click', () => {
  const note = activeNote();
  if (!note) return;
  note.favorite = !note.favorite;
  renderFavorite();
  renderTree();
});
$$('[data-format]').forEach((button) => {
  button.addEventListener('mousedown', (event) => event.preventDefault());
  button.addEventListener('click', () => format(button.dataset.format));
});
$('#insert-quote').addEventListener('mousedown', (event) =>
  event.preventDefault()
);
$('#insert-quote').addEventListener('click', () =>
  format('formatBlock', 'blockquote')
);
$('#text-style').addEventListener('mousedown', (event) =>
  event.preventDefault()
);
$('#text-style').addEventListener('click', () => {
  const heading = $('#text-style-label').textContent === 'Text';
  format('formatBlock', heading ? 'h2' : 'p');
  $('#text-style-label').textContent = heading ? 'Heading' : 'Text';
});
$('#source-toggle').addEventListener('click', () => {
  if (!activeNote()) return;
  if (sourceView) {
    renderDocument();
    return;
  }
  const source = sourcePreview();
  $('.editor-body').hidden = true;
  const textarea = document.createElement('textarea');
  textarea.className = 'source-editor';
  textarea.readOnly = true;
  textarea.value = source;
  textarea.setAttribute('aria-label', 'Markdown source preview (read only)');
  $('#document').append(textarea);
  sourceView = true;
  $('#source-toggle').setAttribute('aria-pressed', 'true');
});
$('#toggle-theme').addEventListener('click', () => {
  const dark = document.documentElement.dataset.theme !== 'dark';
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  $('#toggle-theme use').setAttribute('href', dark ? '#i-sun' : '#i-moon');
  $('#toggle-theme').setAttribute(
    'aria-label',
    `Switch to ${dark ? 'light' : 'dark'} theme`
  );
});
$('#open-settings').addEventListener('click', () => {
  $('#toggle-theme').click();
  toast(
    `${document.documentElement.dataset.theme === 'dark' ? 'Dark' : 'Light'} appearance`
  );
});
$('#toggle-sidebar').addEventListener('click', () => {
  $('#app').classList.toggle(
    window.innerWidth <= 620 ? 'sidebar-overlay' : 'hide-sidebar'
  );
  updatePanelControls();
});
$('#toggle-inspector').addEventListener('click', toggleInspector);
$('#close-inspector').addEventListener('click', toggleInspector);
$('#focus-mode').addEventListener('click', () => {
  const app = $('#app');
  if (!focusLayout) {
    focusLayout = {
      sidebar: app.classList.contains('hide-sidebar'),
      inspector: app.classList.contains('hide-inspector')
    };
    app.classList.add('hide-sidebar', 'hide-inspector');
  } else {
    app.classList.toggle('hide-sidebar', focusLayout.sidebar);
    app.classList.toggle('hide-inspector', focusLayout.inspector);
    focusLayout = null;
  }
  $('#focus-mode').setAttribute('aria-pressed', String(Boolean(focusLayout)));
  $('#focus-mode').setAttribute(
    'aria-label',
    focusLayout ? 'Leave focus mode' : 'Enter focus mode'
  );
  updatePanelControls();
});
$('#show-history').addEventListener('click', () => {
  if (!activeNote()) return;
  $('#history-preview').textContent =
    activeNote().kind && activeNote().kind !== 'markdown'
      ? `${activeNote().title}\n\n${typeOf(activeNote()).label} · visual layout sample`
      : sourceView
        ? $('.source-editor').value
        : sourcePreview();
  $('#history-dialog').showModal();
});
$('#vault-info').addEventListener('click', () =>
  toast('Personal workspace · temporary sample notes for this concept.')
);
$('#open-search').addEventListener('click', openSearch);
$('#search-input').addEventListener('input', () => {
  searchIndex = 0;
  renderSearch();
});
$('#search-input').addEventListener('keydown', (event) => {
  if (['ArrowDown', 'ArrowUp'].includes(event.key)) {
    event.preventDefault();
    searchIndex += event.key === 'ArrowDown' ? 1 : -1;
    renderSearch();
    $('.search-result.highlighted')?.scrollIntoView({ block: 'nearest' });
  }
  if (event.key === 'Enter') {
    event.preventDefault();
    $('.search-result.highlighted')?.click();
  }
});
$('#tabs').addEventListener('keydown', (event) => {
  if (
    !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key) ||
    !event.target.matches('[role="tab"]')
  )
    return;
  event.preventDefault();
  let index = openIds.indexOf(activeId);
  if (event.key === 'Home') index = 0;
  else if (event.key === 'End') index = openIds.length - 1;
  else
    index =
      (index + (event.key === 'ArrowRight' ? 1 : -1) + openIds.length) %
      openIds.length;
  openNote(openIds[index]);
  $(`#tab-${activeId}`).focus();
});
document.addEventListener('keydown', (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    if ($('#search-dialog').open) $('#search-dialog').close();
    else if (!$('dialog[open]')) openSearch();
  }
  if (
    (event.ctrlKey || event.metaKey) &&
    event.key.toLowerCase() === 'n' &&
    !$('dialog[open]')
  ) {
    event.preventDefault();
    createKind = 'markdown';
    requestName('note');
  }
  if (event.key === 'Escape' && !$('dialog[open]')) {
    if (focusLayout) $('#focus-mode').click();
    $('#app').classList.remove('sidebar-overlay', 'inspector-overlay');
    updatePanelControls();
  }
});
window.addEventListener('resize', updatePanelControls);
renderTree();
renderTabs();
renderDocument();
updatePanelControls();

function openCreateMenu(anchor = $('#new-note')) {
  const menu = $('#create-menu');
  if (menu.matches(':popover-open')) {
    menu.hidePopover();
    return;
  }
  const rect = anchor.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(rect.left, innerWidth - 292))}px`;
  menu.style.top = `${rect.bottom + 6}px`;
  menu.style.maxHeight = `${innerHeight - rect.bottom - 14}px`;
  menu.showPopover();
  menu.querySelector('[role="menuitem"]').focus({ preventScroll: true });
}
function createDemoNote(kind, title) {
  const id = `note-${Date.now()}`;
  notes.push({
    id,
    kind,
    title,
    description: noteTypes[kind].description,
    folder: 'Mindstream',
    favorite: false,
    tags: [],
    shared: false,
    body: kind === 'markdown' ? '<p>Start writing here…</p>' : ''
  });
  setView('all');
  openNote(id);
  toast(
    kind === 'markdown'
      ? 'New demo note created. Changes last until reload.'
      : `${noteTypes[kind].label} created · visual layout sample`
  );
}
$('#create-menu').addEventListener('toggle', (event) => {
  $('#new-note').setAttribute(
    'aria-expanded',
    String(event.newState === 'open')
  );
});
$('#create-menu').addEventListener('click', (event) => {
  const choice = event.target.closest('[data-create-kind]');
  if (choice) {
    createKind = choice.dataset.createKind;
    $('#create-menu').hidePopover();
    if (createKind === 'pdf') $('#pdf-file-input').click();
    else requestName('note');
  }
  if (event.target.closest('[data-create-folder]')) {
    $('#create-menu').hidePopover();
    requestName('folder');
  }
});
$('#create-menu').addEventListener('keydown', (event) => {
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  const items = $$('#create-menu [role="menuitem"]');
  let index = items.indexOf(document.activeElement);
  index =
    event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? items.length - 1
        : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) %
          items.length;
  items[index].focus();
});
$('#pdf-file-input').addEventListener('change', (event) => {
  const file = event.target.files[0];
  if (file && /\.pdf$/i.test(file.name))
    createDemoNote('pdf', file.name.replace(/\.pdf$/i, ''));
  event.target.value = '';
});
