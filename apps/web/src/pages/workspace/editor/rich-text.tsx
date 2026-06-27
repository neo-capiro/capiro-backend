/**
 * Controlled rich-text model for the Workspace editor.
 *
 * Replaces the prototype's global `document.execCommand` toolbar (which acted on
 * whatever the browser selection happened to be) with a CONTROLLED editor: each
 * section/canvas body is a `contentEditable` wrapped so it
 *   - renders sanitized HTML in,
 *   - emits sanitized HTML out on input/blur (persisted per section via autosave),
 *   - syncs an external value only while NOT focused (so a Regenerate replaces
 *     the body without stomping the caret mid-typing — same pattern as the
 *     outreach RichTextEditor).
 *
 * Formatting commands (B/I/U, align, lists, indent, font family/size) are routed
 * to the *active* editor through a small registry: the RichTextToolbar calls
 * `runActiveCommand`, which `execCommand`s against the currently-focused editor's
 * element only. `execCommand` is still the browser primitive doing the DOM work,
 * but it is scoped to the focused controlled editor rather than fired globally.
 */
import { useEffect, useRef, type CSSProperties } from 'react';
import { sanitizeHtml } from '../../engagement/outreach/v2/richtext.js';

// ── Active-editor registry ──────────────────────────────────────────────────
// The toolbar has no React tree relationship to the body editors, so we keep a
// module-level pointer to the element that last held focus inside a section
// body. Commands run against it. Cleared when focus leaves all editors.
let activeEl: HTMLElement | null = null;
let activeEmit: (() => void) | null = null;

export function runActiveCommand(command: string, value?: string): void {
  const el = activeEl;
  if (!el) return;
  el.focus();
  try {
    // Prefer semantic tags (<b>) over inline styles for bold/italic/underline.
    document.execCommand(
      'styleWithCSS',
      false,
      command === 'fontName' || command === 'fontSize' ? 'true' : 'false',
    );
    document.execCommand(command, false, value);
  } catch {
    /* execCommand is best-effort; unsupported commands no-op. */
  }
  activeEmit?.();
}

/** Plain-text length of an HTML string (drives word/char counts + status). */
export function htmlWordCount(html: string): number {
  if (!html) return 0;
  const text =
    typeof document === 'undefined'
      ? html.replace(/<[^>]+>/g, ' ')
      : new DOMParser().parseFromString(html, 'text/html').body.textContent || '';
  const trimmed = text.trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}

/**
 * Controlled contentEditable body. `value` is sanitized HTML; `onChange` emits
 * sanitized HTML. Registers itself as the active editor on focus so the shared
 * RichTextToolbar can format it.
 */
export function SectionRichText({
  value,
  onChange,
  style,
  placeholder,
  dataSection,
  readOnly,
  'aria-label': ariaLabel,
}: {
  value: string;
  onChange: (html: string) => void;
  style?: CSSProperties;
  placeholder?: string;
  /** Section name for comment anchoring (read off `data-ws-section` in the DOM). */
  dataSection?: string;
  /** View-only (someone else holds the edit lock): non-editable, still selectable for commenting. */
  readOnly?: boolean;
  'aria-label'?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);

  // Sync external value in only when not focused (avoid caret stomping).
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (document.activeElement === el) return;
    const safe = sanitizeHtml(value || '');
    if (el.innerHTML !== safe) el.innerHTML = safe;
  }, [value]);

  const emit = () => {
    const el = ref.current;
    if (!el) return;
    const raw = el.innerHTML;
    const clean = sanitizeHtml(raw);
    // Only rewrite the DOM when sanitizing changed something (pasted markup) so
    // ordinary typing never resets the caret.
    if (clean !== raw) el.innerHTML = clean;
    onChange(clean);
  };

  return (
    <div
      ref={ref}
      className="ws-rte-body"
      contentEditable={!readOnly}
      suppressContentEditableWarning
      role="textbox"
      aria-multiline="true"
      aria-readonly={readOnly || undefined}
      aria-label={ariaLabel}
      data-ws-section={dataSection}
      data-placeholder={placeholder ?? ''}
      style={style}
      onFocus={() => {
        if (readOnly) return;
        activeEl = ref.current;
        activeEmit = emit;
      }}
      onInput={readOnly ? undefined : emit}
      onBlur={readOnly ? undefined : emit}
      onPaste={(e) => {
        // Sanitize pasted content before it reaches the DOM.
        e.preventDefault();
        const html = e.clipboardData.getData('text/html');
        const text = e.clipboardData.getData('text/plain');
        const fragment = html
          ? sanitizeHtml(html)
          : text
              .replace(/&/g, '&amp;')
              .replace(/</g, '&lt;')
              .replace(/>/g, '&gt;')
              .replace(/\n/g, '<br>');
        document.execCommand('insertHTML', false, fragment);
        emit();
      }}
    />
  );
}
