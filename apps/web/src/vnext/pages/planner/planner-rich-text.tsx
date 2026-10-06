import { useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

export function PlannerFormattedText({ text }: { text: string }) {
  return (
    <div className="planner-formatted-text">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        components={{
          a: (props) => (
            <a
              href={props.href}
              target="_blank"
              rel="noopener noreferrer"
              referrerPolicy="no-referrer"
            >
              {props.children}
            </a>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
export function PlannerRichText({
  label,
  value,
  onChange,
  disabled,
  rows = 5,
  maxLength = 50_000,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  rows?: number;
  maxLength?: number;
}) {
  const input = useRef<HTMLTextAreaElement>(null);
  const [preview, setPreview] = useState(Boolean(disabled));
  const wrap = (prefix: string, suffix = '', fallback = 'text') => {
    const node = input.current;
    if (!node) return;
    const start = node.selectionStart,
      end = node.selectionEnd;
    const text = value.slice(start, end) || fallback;
    onChange(value.slice(0, start) + prefix + text + suffix + value.slice(end));
    requestAnimationFrame(() => {
      node.focus();
      node.setSelectionRange(start + prefix.length, start + prefix.length + text.length);
    });
  };
  return (
    <div className="planner-rich-editor">
      {!disabled && (
        <div className="planner-format-toolbar" role="toolbar" aria-label={`Format ${label}`}>
          <button
            type="button"
            aria-label={`Bold in ${label}`}
            disabled={preview}
            onClick={() => wrap('**', '**')}
          >
            <strong>B</strong>
          </button>
          <button
            type="button"
            aria-label={`Italic in ${label}`}
            disabled={preview}
            onClick={() => wrap('*', '*')}
          >
            <em>I</em>
          </button>
          <button
            type="button"
            aria-label={`Heading in ${label}`}
            disabled={preview}
            onClick={() => wrap('\n### ', '\n')}
          >
            Heading
          </button>
          <button
            type="button"
            aria-label={`Bullet list in ${label}`}
            disabled={preview}
            onClick={() => wrap('\n- ', '\n')}
          >
            List
          </button>
          <button
            type="button"
            aria-label={`Checklist in ${label}`}
            disabled={preview}
            onClick={() => wrap('\n- [ ] ', '\n')}
          >
            Checklist
          </button>
          <button
            type="button"
            aria-label={`Link in ${label}`}
            disabled={preview}
            onClick={() => wrap('[', '](https://)', 'Link text')}
          >
            Link
          </button>
          <button type="button" aria-pressed={preview} onClick={() => setPreview(!preview)}>
            {preview ? 'Write' : 'Preview'}
          </button>
        </div>
      )}
      {preview ? (
        <div role="region" aria-label={`${label} preview`}>
          <PlannerFormattedText text={value || 'No description yet.'} />
        </div>
      ) : (
        <textarea
          ref={input}
          aria-label={label}
          disabled={disabled}
          rows={rows}
          maxLength={maxLength}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </div>
  );
}
