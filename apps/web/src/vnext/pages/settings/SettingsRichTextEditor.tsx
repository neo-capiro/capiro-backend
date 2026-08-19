/**
 * vNext re-skin of pages/engagement/outreach/v2/RichTextEditor.tsx for the
 * Settings → Personal email-signature editor. Behavior is IDENTICAL (same
 * contentEditable + execCommand toolbar, same sanitize-on-emit/paste flow via
 * the same UI-free richtext.ts helpers); only the presentation moves off
 * @ant-design/icons onto lucide + the module's stv-rte classes.
 */
import { useEffect, useRef, type ClipboardEvent, type ReactNode } from 'react';
import {
  Bold,
  Eraser,
  Image as ImageIcon,
  Italic,
  Link as LinkIcon,
  List,
  ListOrdered,
  Underline,
} from 'lucide-react';
import { sanitizeHtml, sanitizeSignatureHtml } from '../../../pages/engagement/outreach/v2/richtext.js';

function escapeText(t: string): string {
  return t
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\n/g, '<br>');
}

export function SettingsRichTextEditor({
  value,
  onChange,
  placeholder,
  variant = 'email',
}: {
  value: string;
  onChange: (html: string) => void;
  placeholder?: string;
  // 'signature' permits images/tables/styled markup (for branded email
  // signatures) and adds image + H1/H2 toolbar tools; 'email' keeps the strict
  // body allowlist. The server re-sanitizes either way.
  variant?: 'email' | 'signature';
}) {
  const ref = useRef<HTMLDivElement>(null);
  const sanitize = variant === 'signature' ? sanitizeSignatureHtml : sanitizeHtml;

  // Sync an external value in only when the editor isn't focused, so a
  // programmatic replace lands without stomping the caret mid-typing.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (document.activeElement === el) return;
    const safe = sanitize(value || '');
    if (el.innerHTML !== safe) el.innerHTML = safe;
  }, [value, sanitize]);

  const emit = () => {
    const el = ref.current;
    if (!el) return;
    const raw = el.innerHTML;
    const clean = sanitize(raw);
    if (clean !== raw) el.innerHTML = clean;
    onChange(clean);
  };

  const exec = (command: string, arg?: string) => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    document.execCommand('styleWithCSS', false, 'false'); // prefer tags (<b>) over inline styles
    document.execCommand(command, false, arg);
    emit();
  };

  const onPaste = (e: ClipboardEvent<HTMLDivElement>) => {
    e.preventDefault();
    const html = e.clipboardData.getData('text/html');
    const text = e.clipboardData.getData('text/plain');
    const fragment = html ? sanitize(html) : escapeText(text);
    document.execCommand('insertHTML', false, fragment);
    emit();
  };

  const addLink = () => {
    const url = window.prompt('Link URL (https:// or mailto:)');
    if (!url || !/^(https?:|mailto:)/i.test(url)) return;
    exec('createLink', url);
  };

  const addImage = () => {
    const url = window.prompt('Image URL (https://)');
    if (!url || !/^https:\/\//i.test(url)) return;
    exec('insertImage', url);
  };

  const isSignature = variant === 'signature';

  return (
    <div className="stv-rte">
      <div className="stv-rte-toolbar">
        <ToolBtn label="Bold" onClick={() => exec('bold')}>
          <Bold size={15} />
        </ToolBtn>
        <ToolBtn label="Italic" onClick={() => exec('italic')}>
          <Italic size={15} />
        </ToolBtn>
        <ToolBtn label="Underline" onClick={() => exec('underline')}>
          <Underline size={15} />
        </ToolBtn>
        <span className="stv-rte-sep" />
        {isSignature ? (
          <>
            <ToolBtn label="Heading 1" onClick={() => exec('formatBlock', 'h1')}>
              <span style={{ fontWeight: 700, fontSize: 12 }}>H1</span>
            </ToolBtn>
            <ToolBtn label="Heading 2" onClick={() => exec('formatBlock', 'h2')}>
              <span style={{ fontWeight: 700, fontSize: 12 }}>H2</span>
            </ToolBtn>
          </>
        ) : (
          <ToolBtn label="Heading" onClick={() => exec('formatBlock', 'h3')}>
            <span style={{ fontWeight: 700, fontSize: 12 }}>H</span>
          </ToolBtn>
        )}
        <ToolBtn label="Bulleted list" onClick={() => exec('insertUnorderedList')}>
          <List size={15} />
        </ToolBtn>
        <ToolBtn label="Numbered list" onClick={() => exec('insertOrderedList')}>
          <ListOrdered size={15} />
        </ToolBtn>
        <ToolBtn label="Add link" onClick={addLink}>
          <LinkIcon size={15} />
        </ToolBtn>
        {isSignature && (
          <ToolBtn label="Insert image by URL" onClick={addImage}>
            <ImageIcon size={15} />
          </ToolBtn>
        )}
        <span className="stv-rte-sep" />
        <ToolBtn label="Clear formatting" onClick={() => exec('removeFormat')}>
          <Eraser size={15} />
        </ToolBtn>
      </div>
      <div
        ref={ref}
        className="stv-rte-area"
        contentEditable
        suppressContentEditableWarning
        role="textbox"
        aria-multiline="true"
        data-placeholder={placeholder ?? ''}
        onInput={emit}
        onBlur={emit}
        onPaste={onPaste}
      />
    </div>
  );
}

function ToolBtn({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className="stv-rte-btn"
      title={label}
      aria-label={label}
      // Keep the editor's selection — clicking a toolbar button must not blur it.
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
