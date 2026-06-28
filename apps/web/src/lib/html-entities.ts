/**
 * Decode HTML entities in a plain string for safe TEXT rendering.
 *
 * Ingested news feeds (member press, intel articles) store headline titles with
 * raw entities — typographic apostrophes (&#8217; / &rsquo;), &amp;, &#39;, etc.
 * JSX text rendering does NOT decode these, so a title like
 * "Rep. Smith&#8217;s Statement" shows the literal entity. A detached <textarea>
 * decodes every named/numeric/hex entity natively in one shot.
 *
 * Use ONLY for content rendered as text (never assign the result to innerHTML).
 */
export function decodeHtmlEntities(input: string | null | undefined): string {
  if (!input) return '';
  // No-DOM guard (SSR / tests): return the raw string unchanged.
  if (typeof document === 'undefined') return input;
  const el = document.createElement('textarea');
  el.innerHTML = input;
  return el.value;
}
