/**
 * Decorating note links so they read like `[[Title]]` in the editor, and
 * handling clicks on them.
 *
 * ID-backed links are decorated from their href; legacy literal
 * `[[Title]]` spans are still styled and clickable as a fallback. Plain
 * click (when enabled in settings) or Cmd/Ctrl+click opens the note;
 * otherwise the click is left to ProseMirror.
 */

import {
  Plugin,
  PluginKey,
  TextSelection,
  type EditorState
} from '@milkdown/kit/prose/state';
import type { Mark } from '@milkdown/kit/prose/model';
import { Decoration, DecorationSet } from '@milkdown/kit/prose/view';
import type { EditorView } from '@milkdown/kit/prose/view';
import { requestOpenNote } from '$lib/stores/open-note-intent.svelte';
import { tree } from '$lib/stores/tree.svelte';
import { parseNoteHref } from '../../wikilink-href';
import type { WikilinkBridge } from '../../wikilink-bridge.svelte';
import { resolveNoteIdByTitle, resolveNoteTitleById } from './note-resolve';
import {
  WIKILINK_RE,
  activeMarks,
  boundaryEditAt,
  boundaryLinkMark,
  deleteInsideLinkBoundary,
  deleteNoteLinkText,
  insertLinkBoundaryText,
  linkMarkType,
  marksWithLink,
  marksWithoutLink,
  noteLinkDeletionRange,
  noteLinkTextRanges,
  removeAdjacentNoteLink,
  shouldTypeOutsideLinkBoundary,
  storedInsideBoundaryMark,
  toggleLinkBoundaryEditing,
  typeOutsideLinkBoundary,
  wholeNoteLinkDeletion,
  arrowWithinLinkText,
  type LinkBoundaryEdit,
  type LinkBoundaryMode,
  exactStoredLinkMark,
  boundaryEditMatches,
  leadingBoundaryLinkMark,
  trailingBoundaryLinkMark
} from './link-boundary';

export interface WikilinkPluginOptions {
  openOnClick: () => boolean;
}

/* --- Decoration + click handler ------------------------------------------- */

const decorationPluginKey = new PluginKey('mindstream-wikilink-decoration');

function closestNoteLinkElement(target: EventTarget | null): Element | null {
  if (!(target instanceof Element)) return null;
  const decorated = target.closest('.wikilink-note-link');
  if (decorated) return decorated;

  const anchor = target.closest('a[href]');
  const href = anchor?.getAttribute('href');
  return parseNoteHref(href) ? anchor : null;
}

function isNoteLinkTooltipElement(element: Element): boolean {
  const previewLink = element.querySelector('.link-display[href]');
  if (parseNoteHref(previewLink?.getAttribute('href'))) return true;

  const input = element.querySelector('input');
  return input instanceof HTMLInputElement && !!parseNoteHref(input.value);
}

function hideNativeNoteLinkTooltips(): void {
  if (typeof document === 'undefined') return;

  document
    .querySelectorAll('.milkdown-link-preview, .milkdown-link-edit')
    .forEach((element) => {
      if (!isNoteLinkTooltipElement(element)) return;
      element.setAttribute('data-show', 'false');
    });
}

function hideNativeNoteLinkTooltipsSoon(): void {
  hideNativeNoteLinkTooltips();
  window.setTimeout(hideNativeNoteLinkTooltips, 75);
}

/**
 * Pattern: `[[…]]` where the inside has no brackets and no newlines.
 * Non-greedy on the inside so `[[a]] [[b]]` matches twice rather than
 * once across both.
 *
 * Escape rules:
 *   - Outside a character class, `[` opens a class → must escape (`\[`).
 *     `]` is just a literal there → no escape needed.
 *   - Inside a character class, `[` is literal → no escape needed.
 *     `]` closes the class → must escape (`\]`).
 */

export function wikilinkDecorationPlugin(
  bridge: WikilinkBridge,
  options: WikilinkPluginOptions
): Plugin {
  let pendingEmptyNoteLink: LinkBoundaryEdit | null = null;
  let activeBoundaryLinkEdit: LinkBoundaryEdit | null = null;
  let measuredBracketFontSize: string | null = null;

  /**
   * The rendered `.wikilink-note-link` the caret sits at the edge of.
   *
   * The brackets scale with *that element's* font, which is not the editor's
   * whenever the link lives in a heading. Probe one position into the link
   * text — that always resolves into the link's own text node — rather than
   * the boundary itself, which is ambiguous between the link and its
   * neighbour.
   */
  function boundaryNoteLinkElement(
    view: EditorView,
    boundary: LinkBoundaryMode
  ): Element | null {
    const pos = view.state.selection.from;
    const probePos = boundary.side === 'end' ? pos - 1 : pos + 1;
    if (probePos < 0 || probePos > view.state.doc.content.size) return null;
    try {
      const { node, offset } = view.domAtPos(probePos);
      const candidate =
        node.nodeType === Node.TEXT_NODE
          ? node.parentElement
          : ((node.childNodes[offset] ??
              node.childNodes[offset - 1] ??
              node) as Node);
      const element =
        candidate?.nodeType === Node.TEXT_NODE
          ? candidate.parentElement
          : (candidate as Element | null);
      return element?.closest?.('.wikilink-note-link') ?? null;
    } catch {
      // domAtPos throws for positions it can't resolve (mid-teardown, a doc
      // that changed under us). No measurement is better than a wrong one.
      return null;
    }
  }

  // The `[[`/`]]` brackets are CSS pseudo-elements, so the virtual cursor at a
  // boundary renders just inside them. When the caret is "outside" the link we
  // nudge it clear of the brackets so typing flows from the cursor instead of
  // dropping a character behind it. Measure the real bracket width (the font is
  // a variable, so a fixed em can't line up) and publish it as a CSS variable.
  //
  // Measured against the link's own computed font, not the editor's: a wikilink
  // in a heading renders far larger, and compensating it with the body-text
  // bracket width left the caret short by most of a bracket.
  function updateBracketOffset(view: EditorView, boundary: LinkBoundaryMode) {
    const styleSource = boundaryNoteLinkElement(view, boundary) ?? view.dom;
    const style = window.getComputedStyle(styleSource);
    const fontSize = style.fontSize;
    if (fontSize === measuredBracketFontSize) return;

    // Measured outside the editable subtree: appending into it would show up
    // in ProseMirror's DOM observer as a content change.
    const probe = document.createElement('span');
    probe.textContent = ']]';
    probe.style.position = 'absolute';
    probe.style.visibility = 'hidden';
    probe.style.whiteSpace = 'pre';
    probe.style.pointerEvents = 'none';
    probe.style.fontSize = fontSize;
    probe.style.fontFamily = style.fontFamily;
    probe.style.fontWeight = style.fontWeight;
    probe.style.fontStyle = style.fontStyle;
    probe.style.letterSpacing = style.letterSpacing;
    document.body.appendChild(probe);
    const bracketWidth = probe.getBoundingClientRect().width;
    probe.remove();

    // `.wikilink-note-link` pads each side by 0.15em; clear that too.
    const offset = bracketWidth + parseFloat(fontSize) * 0.15;
    if (!Number.isFinite(offset) || offset <= 0) return;
    view.dom.style.setProperty('--wikilink-bracket-offset', `${offset}px`);
    measuredBracketFontSize = fontSize;
  }

  function boundaryMode(view: EditorView): LinkBoundaryMode | null {
    const { state } = view;
    const { selection } = state;
    if (!(selection instanceof TextSelection) || !selection.empty) return null;
    const pos = selection.from;

    if (pendingEmptyNoteLink?.pos === pos) {
      return { mode: 'inside', side: 'end', noteLink: true };
    }

    const trailing = trailingBoundaryLinkMark(state, pos);
    const leading = leadingBoundaryLinkMark(state, pos);
    const boundaryMark = trailing ?? leading;
    if (!boundaryMark) return null;

    const side = trailing ? 'end' : 'start';
    const noteLink = !!parseNoteHref(boundaryMark.attrs.href);

    if (boundaryEditAt(activeBoundaryLinkEdit, pos)) {
      return { mode: 'inside', side, noteLink };
    }
    if (boundaryEditMatches(activeBoundaryLinkEdit, pos, boundaryMark))
      return { mode: 'inside', side, noteLink };
    return {
      mode: exactStoredLinkMark(state, boundaryMark) ? 'inside' : 'outside',
      side,
      noteLink
    };
  }

  function syncBoundaryMode(view: EditorView): void {
    const boundary = boundaryMode(view);
    // Side classes drive the bracket compensation transform, so they follow
    // the *note link* answer, not merely "is there a boundary here".
    const bracketed = boundary?.noteLink === true;
    if (bracketed && boundary?.mode === 'outside') {
      updateBracketOffset(view, boundary);
    }
    view.dom.classList.toggle(
      'wikilink-boundary-inside',
      bracketed && boundary?.mode === 'inside'
    );
    view.dom.classList.toggle(
      'wikilink-boundary-outside',
      bracketed && boundary?.mode === 'outside'
    );
    view.dom.classList.toggle(
      'wikilink-boundary-start',
      bracketed && boundary?.side === 'start'
    );
    view.dom.classList.toggle(
      'wikilink-boundary-end',
      bracketed && boundary?.side === 'end'
    );
    if (boundary) {
      view.dom.dataset.wikilinkBoundary = boundary.mode;
      view.dom.dataset.wikilinkBoundarySide = boundary.side;
    } else {
      delete view.dom.dataset.wikilinkBoundary;
      delete view.dom.dataset.wikilinkBoundarySide;
    }
  }

  function setActiveBoundaryLinkEdit(
    view: EditorView,
    edit: LinkBoundaryEdit | null
  ): void {
    activeBoundaryLinkEdit = edit;
    syncBoundaryMode(view);
  }

  function clearLinkEditState(view: EditorView): void {
    pendingEmptyNoteLink = null;
    setActiveBoundaryLinkEdit(view, null);
  }

  // Both link-edit pins (`pendingEmptyNoteLink`, `activeBoundaryLinkEdit`) name
  // a single doc position that's only meaningful while the caret rests on it.
  // Structural edits we don't drive — a Backspace that merges lines, an Enter
  // that splits one — move the caret through ProseMirror's default handlers,
  // leaving a pin stranded at a stale position. A stranded pin later
  // "resurrects" link editing and splices a link mark into unrelated text,
  // producing a broken link. So on every state update drop any pin that no
  // longer coincides with an empty caret. Our own handlers re-pin right after
  // dispatching, so this never clears a still-valid edit.
  function validateLinkEditState(view: EditorView): void {
    const { selection } = view.state;
    const caret =
      selection instanceof TextSelection && selection.empty
        ? selection.from
        : null;
    if (pendingEmptyNoteLink && pendingEmptyNoteLink.pos !== caret) {
      pendingEmptyNoteLink = null;
    }
    if (activeBoundaryLinkEdit && activeBoundaryLinkEdit.pos !== caret) {
      activeBoundaryLinkEdit = null;
    }
  }

  function build(
    doc: Parameters<typeof DecorationSet.create>[0]
  ): DecorationSet {
    const decos: Decoration[] = [];
    // descendants over textblocks; wikilinks span only text within one
    // block (the regex forbids \n).
    doc.descendants((node, pos) => {
      if (!node.isText || !node.text) return;
      const text = node.text;
      const noteLinkMark = node.marks.find((mark) =>
        parseNoteHref(mark.attrs.href)
      );
      const noteId = parseNoteHref(noteLinkMark?.attrs.href);
      if (noteId) {
        const title = resolveNoteTitleById(noteId, text.trim() || text);
        decos.push(
          Decoration.inline(pos, pos + text.length, {
            class: 'wikilink wikilink-note-link',
            'data-note-id': noteId,
            'data-wikilink-title': title
          })
        );
        return;
      }

      let m: RegExpExecArray | null;
      WIKILINK_RE.lastIndex = 0;
      while ((m = WIKILINK_RE.exec(text)) !== null) {
        const from = pos + m.index;
        const to = from + m[0].length;
        const title = m[1].trim();
        const id = resolveNoteIdByTitle(title);
        const attrs: Record<string, string> = {
          class: 'wikilink wikilink-legacy',
          'data-wikilink-title': title
        };
        if (id) attrs['data-note-id'] = id;
        decos.push(Decoration.inline(from, to, attrs));
      }
    });
    return DecorationSet.create(doc, decos);
  }

  return new Plugin({
    key: decorationPluginKey,
    view(view) {
      const suppressHoverTooltip = (event: MouseEvent) => {
        if (!closestNoteLinkElement(event.target)) return;
        hideNativeNoteLinkTooltipsSoon();
        event.stopImmediatePropagation();
      };

      const hideTooltip = (event: MouseEvent) => {
        if (!closestNoteLinkElement(event.target)) return;
        hideNativeNoteLinkTooltipsSoon();
      };

      // Note links render as real `<a href="mindstream://note/…">`
      // anchors. `handleClick` preventDefaults on the paths where it
      // opens the note, but its early returns (note not resolved, plain
      // click with open-on-click off) don't — leaving the browser to
      // follow the href. On the Android WebView that navigates the whole
      // page to the unresolvable custom scheme and white-screens the app.
      // Cancel the default navigation for every note-link anchor here,
      // unconditionally and in the capture phase (before the anchor's own
      // default action). preventDefault only stops the navigation; it
      // doesn't stop `handleClick` from still running to open the note.
      const preventNoteLinkNavigation = (event: MouseEvent) => {
        if (closestNoteLinkElement(event.target)) event.preventDefault();
      };

      view.dom.addEventListener('mousemove', suppressHoverTooltip, true);
      view.dom.addEventListener('mouseover', suppressHoverTooltip, true);
      view.dom.addEventListener('mousedown', hideTooltip, true);
      view.dom.addEventListener('click', hideTooltip, true);
      view.dom.addEventListener('click', preventNoteLinkNavigation, true);

      return {
        update(view) {
          validateLinkEditState(view);
          syncBoundaryMode(view);
        },
        destroy() {
          view.dom.removeEventListener('mousemove', suppressHoverTooltip, true);
          view.dom.removeEventListener('mouseover', suppressHoverTooltip, true);
          view.dom.removeEventListener('mousedown', hideTooltip, true);
          view.dom.removeEventListener('click', hideTooltip, true);
          view.dom.removeEventListener(
            'click',
            preventNoteLinkNavigation,
            true
          );
          view.dom.classList.remove(
            'wikilink-boundary-inside',
            'wikilink-boundary-outside',
            'wikilink-boundary-start',
            'wikilink-boundary-end'
          );
          delete view.dom.dataset.wikilinkBoundary;
          delete view.dom.dataset.wikilinkBoundarySide;
        }
      };
    },
    state: {
      init(_, state) {
        return build(state.doc);
      },
      apply(tr, prev) {
        if (!tr.docChanged) return prev;
        return build(tr.doc);
      }
    },
    props: {
      decorations(state) {
        return decorationPluginKey.getState(state);
      },
      handleTextInput(view, from, to, text) {
        if (
          activeBoundaryLinkEdit &&
          from === to &&
          from === activeBoundaryLinkEdit.pos
        ) {
          // Capture the mark before dispatching: insertLinkBoundaryText
          // moves the caret, which makes validateLinkEditState (run from
          // the view-update hook during dispatch) null the pin. Reading
          // it afterwards used to throw, abort the re-pin, and dump the
          // very next character outside the link.
          const mark = activeBoundaryLinkEdit.mark;
          const nextPos = insertLinkBoundaryText(view, from, text, mark);
          if (nextPos !== null) {
            pendingEmptyNoteLink = null;
            setActiveBoundaryLinkEdit(view, { pos: nextPos, mark });
            return true;
          }
        }

        if (
          pendingEmptyNoteLink &&
          from === to &&
          from === pendingEmptyNoteLink.pos
        ) {
          // Same capture-before-dispatch dance as above.
          const mark = pendingEmptyNoteLink.mark;
          const nextPos = insertLinkBoundaryText(view, from, text, mark);
          pendingEmptyNoteLink = null;
          if (nextPos !== null) {
            setActiveBoundaryLinkEdit(view, { pos: nextPos, mark });
            return true;
          }
        }

        pendingEmptyNoteLink = null;

        // Inside the link on stored marks alone, with no pin to carry the run.
        // Insert through the pinned path so the characters after this one stay
        // in the link too, instead of only the first landing inside.
        if (from === to && !activeBoundaryLinkEdit) {
          const storedMark = storedInsideBoundaryMark(view.state, from);
          if (storedMark) {
            const nextPos = insertLinkBoundaryText(
              view,
              from,
              text,
              storedMark
            );
            if (nextPos !== null) {
              setActiveBoundaryLinkEdit(view, {
                pos: nextPos,
                mark: storedMark
              });
              return true;
            }
          }
        }

        const typedOutside = typeOutsideLinkBoundary(view, from, to, text);
        if (typedOutside) setActiveBoundaryLinkEdit(view, null);
        return typedOutside;
      },
      handleClick(view, _pos, event) {
        // Clicking never enters link-text editing; the caret lands "outside"
        // the link on either side. Editing is opt-in via arrow keys, which
        // keeps left/right click behavior identical regardless of where the
        // link sits in the line.
        clearLinkEditState(view);

        // Ctrl/Cmd always opens. Plain left click opens when the user
        // opts into note links behaving like ordinary navigation.
        const openModifier = event.metaKey || event.ctrlKey;
        const plainClick =
          event.button === 0 &&
          !event.metaKey &&
          !event.ctrlKey &&
          !event.altKey &&
          !event.shiftKey;
        if (!openModifier && !(plainClick && options.openOnClick())) {
          return false;
        }
        const target = event.target;
        if (!(target instanceof Element)) return false;
        const linkEl = target.closest('.wikilink');
        if (!linkEl) return false;
        const noteId = linkEl.getAttribute('data-note-id');
        if (
          noteId &&
          tree.notesById[noteId] &&
          !tree.notesById[noteId].trashed
        ) {
          event.preventDefault();
          bridge.cancel();
          requestOpenNote(noteId);
          return true;
        }
        const title = linkEl.getAttribute('data-wikilink-title');
        if (!title) return false;
        const id = resolveNoteIdByTitle(title);
        if (!id) {
          // Don't suppress the click — let the cursor land so the
          // user can rename / create the missing target. A future
          // iteration could prompt to create on Cmd-click.
          return false;
        }
        event.preventDefault();
        bridge.cancel();
        requestOpenNote(id);
        return true;
      },
      handleKeyDown(view, event) {
        if (event.key === 'Backspace' || event.key === 'Delete') {
          if (removeAdjacentNoteLink(view, event, boundaryMode(view))) {
            clearLinkEditState(view);
            return true;
          }
          if (wholeNoteLinkDeletion(view.state, event)) {
            event.preventDefault();
            pendingEmptyNoteLink = deleteNoteLinkText(view, event);
            setActiveBoundaryLinkEdit(view, null);
            syncBoundaryMode(view);
            return !!pendingEmptyNoteLink;
          }
          if (activeBoundaryLinkEdit) {
            const next = deleteInsideLinkBoundary(
              view,
              event,
              activeBoundaryLinkEdit
            );
            if (next) {
              event.preventDefault();
              pendingEmptyNoteLink = null;
              setActiveBoundaryLinkEdit(view, next);
              return true;
            }
          }
          return false;
        }

        const toggled = toggleLinkBoundaryEditing(
          view,
          event,
          activeBoundaryLinkEdit
        );
        if (toggled) {
          pendingEmptyNoteLink = null;
          setActiveBoundaryLinkEdit(view, toggled === 'exit' ? null : toggled);
          return true;
        }
        const arrowed = arrowWithinLinkText(
          view,
          event,
          activeBoundaryLinkEdit
        );
        if (arrowed) {
          event.preventDefault();
          pendingEmptyNoteLink = null;
          setActiveBoundaryLinkEdit(view, arrowed);
          return true;
        }
        if (event.key.startsWith('Arrow')) {
          clearLinkEditState(view);
        }
        return false;
      }
    }
  });
}
