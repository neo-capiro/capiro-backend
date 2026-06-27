/**
 * Comment anchoring (Phase 6). The prototype anchored a highlight by wrapping
 * the live selection in a `.ws-hl` span and re-finding it later by string match
 * — demo-only, since the controlled contentEditable bodies re-sync their HTML on
 * every value change and would wipe an injected span.
 *
 * Here an anchor is a SECTION + plain-text OFFSET range:
 *   { section, quote, start, end }
 * `start`/`end` are character offsets within the section body's plain text, so
 * the highlight can be recomputed deterministically on any render even though
 * the live `.ws-hl` span is transient. Section bodies carry a `data-ws-section`
 * attribute (set in SectionBlock) that ties a DOM node back to its section name.
 */

export interface CommentAnchor {
  /** Section heading the quote lives in (key into cfg.sections/sectionContent). */
  section: string;
  /** Snapshot of the highlighted text. */
  quote: string;
  /** Char offset of the quote's start within the section's plain text. */
  start: number;
  /** Char offset of the quote's end within the section's plain text. */
  end: number;
}

/** A pending selection ready to be turned into a comment. */
export interface SelectionAnchor extends CommentAnchor {
  /** Viewport rect of the selection (for placing the floating Comment button). */
  rect: { top: number; left: number; width: number };
}

/** Walk up to the nearest section-tagged ancestor. */
function sectionElFor(node: Node | null): HTMLElement | null {
  let el: HTMLElement | null = node instanceof HTMLElement ? node : (node?.parentElement ?? null);
  while (el && !el.dataset.wsSection) el = el.parentElement;
  return el;
}

/**
 * Compute the plain-text offset of (container, offset) within `root`'s text,
 * counting characters in document order. Mirrors how `textContent` linearizes.
 */
function offsetWithin(root: HTMLElement, container: Node, containerOffset: number): number {
  // TreeWalker over text nodes; sum lengths until we reach the container.
  const tw = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let total = 0;
  let n: Node | null = tw.nextNode();
  while (n) {
    if (n === container) {
      return total + containerOffset;
    }
    total += n.textContent?.length ?? 0;
    n = tw.nextNode();
  }
  // Container wasn't a text node (e.g. element boundary): best-effort fallback.
  if (container.nodeType === Node.ELEMENT_NODE) {
    const range = document.createRange();
    range.selectNodeContents(root);
    try {
      range.setEnd(container, containerOffset);
      return range.toString().length;
    } catch {
      /* fall through */
    }
  }
  return total;
}

/**
 * Read the current selection inside a section body. Returns null when the
 * selection is empty or not inside a `[data-ws-section]` body.
 */
export function getSelectionAnchor(): SelectionAnchor | null {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  const quote = sel.toString().trim();
  if (!quote) return null;

  const sectionEl = sectionElFor(range.commonAncestorContainer);
  if (!sectionEl) return null;
  const section = sectionEl.dataset.wsSection ?? '';
  if (!section) return null;

  const start = offsetWithin(sectionEl, range.startContainer, range.startOffset);
  const end = offsetWithin(sectionEl, range.endContainer, range.endOffset);
  const lo = Math.min(start, end);
  const hi = Math.max(start, end);

  const r = range.getBoundingClientRect();
  return {
    section,
    quote,
    start: lo,
    end: hi,
    rect: { top: r.top, left: r.left, width: r.width },
  };
}

/**
 * Wrap the current selection's range in a `.ws-hl` span for immediate visual
 * feedback (transient — the span is recomputed/cleared by section+offset). Uses
 * surroundContents when the range is within a single text node, else extracts +
 * re-inserts. Best-effort; failures are swallowed (the offset anchor is the
 * source of truth).
 */
export function highlightSelection(): void {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
  const range = sel.getRangeAt(0);
  const span = document.createElement('span');
  span.className = 'ws-hl';
  try {
    range.surroundContents(span);
  } catch {
    try {
      const contents = range.extractContents();
      span.appendChild(contents);
      range.insertNode(span);
    } catch {
      return;
    }
  }
  sel.removeAllRanges();
}

/**
 * Remove any live `.ws-hl` spans whose text matches the anchor's quote, in the
 * anchor's section. Called on resolve (the highlight should disappear). Unwraps
 * the span, restoring its children inline.
 */
export function clearHighlightFor(anchor: CommentAnchor): void {
  const snippet = (anchor.quote || '').slice(0, 16);
  if (!snippet) return;
  document.querySelectorAll<HTMLElement>('.ws-hl').forEach((span) => {
    const inSection = sectionElFor(span)?.dataset.wsSection === anchor.section;
    if (!inSection) return;
    if (!span.textContent || !span.textContent.includes(snippet.slice(0, 12))) return;
    const parent = span.parentNode;
    if (!parent) return;
    while (span.firstChild) parent.insertBefore(span.firstChild, span);
    parent.removeChild(span);
  });
}

/**
 * Splice an approved Meri rewrite into a section's plain text at the anchor's
 * offset range. Operates on the section's PLAIN text (the editor stores HTML,
 * but Meri edits are prose) — returns the new section body as escaped HTML with
 * the surrounding text preserved. The caller persists it via setSectionBody.
 *
 * `currentHtml` is the section's stored HTML; we linearize it to text, splice,
 * and re-escape. This is intentionally conservative: it does not try to keep
 * inline formatting that overlapped the edited span (rare for prose comments).
 */
export function applyEditToSectionHtml(
  currentHtml: string,
  anchor: CommentAnchor,
  after: string,
): string {
  const text = htmlToText(currentHtml);
  const lo = Math.max(0, Math.min(anchor.start, text.length));
  const hi = Math.max(lo, Math.min(anchor.end, text.length));
  // Verify the slice still matches the quote; if drift happened, fall back to a
  // string replace of the original quote, else append.
  let nextText: string;
  if (text.slice(lo, hi) === anchor.quote) {
    nextText = text.slice(0, lo) + after + text.slice(hi);
  } else if (anchor.quote && text.includes(anchor.quote)) {
    nextText = text.replace(anchor.quote, after);
  } else {
    nextText = text.length ? `${text}\n${after}` : after;
  }
  return textToHtml(nextText);
}

function htmlToText(html: string): string {
  if (!html) return '';
  if (typeof document === 'undefined') return html.replace(/<[^>]+>/g, '');
  const doc = new DOMParser().parseFromString(html, 'text/html');
  return doc.body.textContent ?? '';
}

function textToHtml(text: string): string {
  const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return escaped
    .split(/\n{2,}/)
    .map((p) => `<p>${p.replace(/\n/g, '<br>')}</p>`)
    .join('');
}
