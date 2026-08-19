/**
 * Icons the PE fallback module needs beyond `vnext/components/icons`. Same
 * conventions as that module: authored to match the semantics of the antd
 * glyphs they replace; 24px stroke grid; sized in em so they track font size.
 * If a design-system icon library is published later, re-point these at it.
 */
import type { CSSProperties, ReactNode } from 'react';

export interface PeFbIconProps {
  /** Multiplier on the current font size. 1 = 1em. */
  size?: number;
  className?: string;
  style?: CSSProperties;
}

function Glyph({
  size = 1,
  className = '',
  style,
  filled = false,
  children,
}: PeFbIconProps & { filled?: boolean; children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={`${size}em`}
      height={`${size}em`}
      fill={filled ? 'currentColor' : 'none'}
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

export function PeFbChevronDownIcon(props: PeFbIconProps) {
  return (
    <Glyph {...props}>
      <path d="M6 9l6 6 6-6" />
    </Glyph>
  );
}

export function PeFbChevronRightIcon(props: PeFbIconProps) {
  return (
    <Glyph {...props}>
      <path d="M9 6l6 6-6 6" />
    </Glyph>
  );
}

/** RiseOutlined equivalent — trend up. */
export function PeFbTrendUpIcon(props: PeFbIconProps) {
  return (
    <Glyph {...props}>
      <path d="M3 17l6-6 4 4 8-8" />
      <path d="M15 7h6v6" />
    </Glyph>
  );
}

/** FallOutlined equivalent — trend down. */
export function PeFbTrendDownIcon(props: PeFbIconProps) {
  return (
    <Glyph {...props}>
      <path d="M3 7l6 6 4-4 8 8" />
      <path d="M21 11v6h-6" />
    </Glyph>
  );
}

export function PeFbFlagIcon(props: PeFbIconProps) {
  return (
    <Glyph {...props}>
      <path d="M5 21V4" />
      <path d="M5 4h13l-2.5 4L18 12H5" />
    </Glyph>
  );
}

/** SwapOutlined equivalent — transfer. */
export function PeFbSwapIcon(props: PeFbIconProps) {
  return (
    <Glyph {...props}>
      <path d="M4 8h14l-3.5-3.5" />
      <path d="M20 16H6l3.5 3.5" />
    </Glyph>
  );
}

export function PeFbInfoCircleIcon(props: PeFbIconProps) {
  return (
    <Glyph {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5" />
      <path d="M12 8h.01" />
    </Glyph>
  );
}

export function PeFbClockIcon(props: PeFbIconProps) {
  return (
    <Glyph {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3.5 2" />
    </Glyph>
  );
}


export function PeFbLockIcon(props: PeFbIconProps) {
  return (
    <Glyph {...props}>
      <rect x="5" y="11" width="14" height="9" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </Glyph>
  );
}

export function PeFbMailIcon(props: PeFbIconProps) {
  return (
    <Glyph {...props}>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="M3 7l9 6 9-6" />
    </Glyph>
  );
}

/** CompassOutlined equivalent — the capability finder eyebrow. */
export function PeFbCompassIcon(props: PeFbIconProps) {
  return (
    <Glyph {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="M15.5 8.5l-2 5-5 2 2-5 5-2z" />
    </Glyph>
  );
}

export function PeFbLinkIcon(props: PeFbIconProps) {
  return (
    <Glyph {...props}>
      <path d="M10 14a5 5 0 0 0 7.07 0l2.12-2.12a5 5 0 0 0-7.07-7.07L10.7 6.22" />
      <path d="M14 10a5 5 0 0 0-7.07 0L4.8 12.12a5 5 0 0 0 7.07 7.07l1.42-1.41" />
    </Glyph>
  );
}



/** ExportOutlined equivalent — arrow out of a box. */
export function PeFbExportIcon(props: PeFbIconProps) {
  return (
    <Glyph {...props}>
      <path d="M11 5H6a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-5" />
      <path d="M14 4h6v6" />
      <path d="M20 4l-9 9" />
    </Glyph>
  );
}



export function PeFbBellIcon({ filled, ...props }: PeFbIconProps & { filled?: boolean }) {
  return (
    <Glyph {...props} filled={filled}>
      <path d="M18 9a6 6 0 1 0-12 0c0 6-2.5 7-2.5 7h17S18 15 18 9" />
      <path d="M10.3 20a2 2 0 0 0 3.4 0" />
    </Glyph>
  );
}

export function PeFbExclamationCircleIcon(props: PeFbIconProps) {
  return (
    <Glyph {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 8v5" />
      <path d="M12 16h.01" />
    </Glyph>
  );
}
