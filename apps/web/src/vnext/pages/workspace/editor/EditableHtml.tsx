import { useEffect, useRef } from 'react';
import { sanitizeWorkspaceBody } from '../../../../pages/workspace/editor/workspace-richtext.js';

function plainText(html: string): string {
  if (!html) return '';
  if (typeof document === 'undefined') return html.replace(/<[^>]+>/g, '');
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  return parsed.body.textContent ?? '';
}

export function EditableHtml({
  value,
  section,
  readOnly,
  placeholder,
  onChange,
}: {
  value: string;
  section: string;
  readOnly: boolean;
  placeholder: string;
  onChange: (value: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const focused = useRef(false);

  useEffect(() => {
    // The browser owns the focused DOM and selection. Replacing innerHTML on
    // each controlled-value echo moves the caret and reverses ordinary typing.
    if (!focused.current && ref.current && ref.current.innerHTML !== value) {
      ref.current.innerHTML = value;
    }
  }, [value]);

  return (
    <div
      ref={ref}
      className="ws-audit-editable-section"
      data-empty={!plainText(value).trim()}
      data-ws-section={section}
      contentEditable={!readOnly}
      suppressContentEditableWarning
      role="textbox"
      aria-label={`${section} body`}
      aria-readonly={readOnly}
      data-placeholder={placeholder}
      onFocus={() => {
        focused.current = true;
      }}
      onBlur={(event) => {
        focused.current = false;
        if (!readOnly) onChange(sanitizeWorkspaceBody(event.currentTarget.innerHTML));
      }}
      onInput={(event) => {
        if (!readOnly) onChange(event.currentTarget.innerHTML);
      }}
    />
  );
}
