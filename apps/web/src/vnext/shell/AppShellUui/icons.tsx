/**
 * Untitled UI line icons used only by the Dashboard's own Untitled-UI shell.
 * Paths verified live against `Capiro Dashboard - Untitled UI.dc.html`
 * (getComputedStyle + the component's own NAV/TABS icon table) rather than
 * transcribed from the handoff doc's prose. 24x24 grid, round joins, matching
 * the kit's line-icon convention.
 *
 * Deliberately NOT the Capiro-native shell's icon treatment: Sidebar/index.tsx
 * (`NAV_GLYPHS`) uses literal Unicode glyphs by design-system ruling — that
 * ruling is scoped to the Capiro-native shell and does not extend here, since
 * the whole point of this file is the other, purchased kit.
 */
import type { SVGProps } from 'react';

const PATHS: Readonly<Record<string, string>> = {
  home: 'M3.4 10.4 12 3.4l8.6 7v9.2a1 1 0 0 1-1 1H4.4a1 1 0 0 1-1-1z',
  briefcase: 'M3.6 7.6h16.8v12.8H3.6zM8.8 7.6V4.4h6.4v3.2',
  mail: 'M3.6 5.6h16.8v12.8H3.6zM3.6 6.6l8.4 6 8.4-6',
  grid: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
  // Strategies — target (concentric rings + center dot), not a diamond.
  target: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 16.5a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9zM12 12h.01',
  users: 'M4 6.5h16M4 12h16M4 17.5h16',
  search: 'M10.8 4.4a6.4 6.4 0 1 0 0 12.8 6.4 6.4 0 0 0 0-12.8zM15.4 15.4 20.6 20.6',
  // Intelligence — search with an inline refraction mark (the kit's glyph).
  'search-refraction': 'M10.8 4.4a6.4 6.4 0 1 0 0 12.8 6.4 6.4 0 0 0 0-12.8zM15.4 15.4 20.6 20.6M8.2 10.8h5.2M10.8 8.2v5.2',
  dots: 'M6 12h.01M12 12h.01M18 12h.01',
  // Small chrome icons not carried by NAV/TABS — authored in the same kit
  // convention (24x24, 1.5 stroke, round caps), not extracted from the .dc.
  chevronDown: 'M6 9l6 6 6-6',
  chevronRight: 'M9 6l6 6-6 6',
  x: 'M6 6l12 12M18 6L6 18',
  bell: 'M6 10a6 6 0 1 1 12 0v4.4l1.6 2.6H4.4L6 14.4z M10 19.5a2 2 0 0 0 4 0',
  collapse: 'M15 6l-6 6 6 6',
  expand: 'M9 6l6 6-6 6',
};

export type IconName = keyof typeof PATHS;

export function Icon({
  name,
  size = 24,
  ...rest
}: { name: IconName; size?: number } & SVGProps<SVGSVGElement>) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      <path d={PATHS[name]} />
    </svg>
  );
}

/** Maps the real route manifest's stable ids to an Untitled-UI icon. */
export const NAV_ICON_BY_ROUTE_ID: Readonly<Record<string, IconName>> = {
  dashboard: 'home',
  portfolio: 'briefcase',
  'engagement-manager': 'mail',
  workspace: 'grid',
  strategies: 'target',
  directory: 'users',
  intelligence: 'search-refraction',
};
