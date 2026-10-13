/**
 * Upcoming-signal eligibility and presentation for Federal Market / District Nexus.
 *
 * Past and inactive agency forecasts must not occupy the Upcoming preview.
 * Unknown dates stay eligible and are ranked after dated signals so they do
 * not crowd out nearer opportunities. Titles may carry provider HTML and must
 * render as plain text.
 */
/**
 * The single plain-text conversion boundary for market signal titles.
 *
 * The API converts provider markup to plain text exactly once, here. Panels
 * render the returned string verbatim — never decoding again, never stripping
 * what look like tags, because literal angle brackets in already-decoded
 * titles are content (e.g. "Budget <2028> funding"), not markup.
 *
 * Safety rules:
 * - Named entities resolve by OWN property only, so prototype keys like
 *   `constructor` can never be interpolated.
 * - Numeric/hex entities decode only within the valid Unicode range;
 *   out-of-range or unparsable values pass through untouched.
 * - Anything that is not a well-formed, recognized entity stays exactly as
 *   typed.
 */
export declare function readableMarketTitle(title: string): string;
//# sourceMappingURL=market-title.d.ts.map