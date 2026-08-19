import type { CSSProperties, ReactNode } from 'react';

/**
 * Module-local icons for the District Nexus vNext port, mirroring the stroke
 * style of `vnext/components/icons` (1.75 stroke, 24 grid, currentColor).
 * Kept module-local rather than added to the shared icon set to avoid
 * cross-PR merge conflicts while six Phase 2 ports land in parallel — fold
 * them into `components/icons` afterwards if other modules need them.
 */

export interface DnxIconProps {
  size?: number;
  className?: string;
  style?: CSSProperties;
}

function Glyph({ size = 1, className = '', style, children }: DnxIconProps & { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={`${size}em`}
      height={`${size}em`}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={`capiro-icon ${className}`.trim()}
      style={{ flexShrink: 0, verticalAlign: '-0.125em', ...style }}
    >
      {children}
    </svg>
  );
}

export function DnxWarningIcon(props: DnxIconProps) {
  return (
    <Glyph {...props}>
      <path d="M10.3 4.3 3.2 17.6a2 2 0 0 0 1.76 2.9h14.08a2 2 0 0 0 1.76-2.9L13.7 4.3a2 2 0 0 0-3.4 0Z" />
      <path d="M12 9v4.5M12 16.75v.05" />
    </Glyph>
  );
}

export function DnxInfoIcon(props: DnxIconProps) {
  return (
    <Glyph {...props}>
      <circle cx="12" cy="12" r="8.75" />
      <path d="M12 11v5M12 7.75v.05" />
    </Glyph>
  );
}

export function DnxClockIcon(props: DnxIconProps) {
  return (
    <Glyph {...props}>
      <circle cx="12" cy="12" r="8.75" />
      <path d="M12 7.5V12l3 2" />
    </Glyph>
  );
}

export function DnxMapPinIcon(props: DnxIconProps) {
  return (
    <Glyph {...props}>
      <path d="M12 21s-6.75-5.2-6.75-10.25a6.75 6.75 0 0 1 13.5 0C18.75 15.8 12 21 12 21Z" />
      <circle cx="12" cy="10.5" r="2.5" />
    </Glyph>
  );
}

export function DnxLayersIcon(props: DnxIconProps) {
  return (
    <Glyph {...props}>
      <path d="m12 3.5 8.5 4.75L12 13 3.5 8.25 12 3.5Z" />
      <path d="m4.5 12.5 7.5 4.2 7.5-4.2M4.5 16.5l7.5 4.2 7.5-4.2" />
    </Glyph>
  );
}

export function DnxChevronDownIcon(props: DnxIconProps) {
  return (
    <Glyph {...props}>
      <path d="m6 9.5 6 6 6-6" />
    </Glyph>
  );
}
