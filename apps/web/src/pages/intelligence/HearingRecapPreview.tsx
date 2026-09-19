import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeSanitize from 'rehype-sanitize';

/**
 * Safe, read-only rendering of the hearing-recap Markdown produced by
 * briefToMarkdown. Uses the app's established pattern (react-markdown +
 * remark-gfm + rehype-sanitize + skipHtml) so model/client text can never
 * inject raw HTML or script. Links are hardened: javascript:/data: URLs are
 * dropped, remote images are reduced to an alt placeholder, and external links
 * open in a new tab with noopener. Internal route links (the hearing-room
 * retrieval link) navigate in-app.
 *
 * This is presentation-only; the saved/exported artifact is the SAME Markdown
 * string, so what the analyst reads is exactly what is filed.
 */

const SAFE_HREF = /^(?:https?:\/\/|\/|#|mailto:)/i;

const components: Components = {
  a: ({ href, children }) => {
    const safe = href && SAFE_HREF.test(href) ? href : undefined;
    if (!safe) return <span>{children}</span>;
    const internal = safe.startsWith('/') || safe.startsWith('#');
    return (
      <a href={safe} target={internal ? undefined : '_blank'} rel="noopener noreferrer">
        {children}
      </a>
    );
  },
  // Never load remote images from model output.
  img: ({ alt }) => <span>{alt ? `[Image: ${alt}]` : '[Image]'}</span>,
};

export function HearingRecapPreview({ markdown }: { markdown: string }) {
  return (
    <div
      className="hearing-recap-preview"
      style={{ maxHeight: 'min(55vh, 600px)', overflow: 'auto', fontSize: 13, lineHeight: 1.55 }}
    >
      {/* Compact headings so the executive summary is visible on a normal
          desktop viewport instead of the headline filling the preview. */}
      <style>{`
        .hearing-recap-preview h1 { font-size: 20px; line-height: 1.3; margin: 0 0 8px; }
        .hearing-recap-preview h2 { font-size: 15px; line-height: 1.3; margin: 14px 0 6px; }
        .hearing-recap-preview h3 { font-size: 13.5px; line-height: 1.3; margin: 10px 0 4px; }
        .hearing-recap-preview p { margin: 0 0 8px; }
        .hearing-recap-preview ul { margin: 0 0 8px; padding-left: 20px; }
      `}</style>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeSanitize]}
        skipHtml
        components={components}
      >
        {markdown}
      </ReactMarkdown>
    </div>
  );
}
