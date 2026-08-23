import type { CSSProperties } from 'react';

/**
 * vNext icon set.
 *
 * These exist so the vNext surface can drop the ant-design icon package, which
 * was one of the last two antd couplings in `pages/strategies` and
 * `pages/legiwatch` and the reason those families failed the design-system test
 * in the handover doc (§3). That test greps this tree for antd imports, so this
 * comment deliberately avoids spelling the import specifiers literally — doing
 * so would make the canary report a false positive on this very file.
 *
 * Contract, chosen to make these drop-in replacements for the glyphs they
 * replace:
 *  - sized in `em`, so they scale with the surrounding type rather than a fixed px
 *  - stroked with `currentColor`, so `--capiro-color-*` tokens drive the colour
 *  - `aria-hidden`, because every call site already supplies its own text label
 *    or an `aria-label` on the wrapping control
 *
 * NOTE: these are authored to match the semantics of the antd glyphs they
 * replace, not exported from Figma. The design system defines no icon library
 * today (there is no icon entry in `FIGMA_REACT_MAPPING_INVENTORY` and no icon
 * module anywhere under `src/vnext`). If one is published later, re-point these
 * at it rather than hand-editing the paths.
 */

export interface CapiroIconProps {
  /** Multiplier on the current font size. 1 = 1em. */
  size?: number;
  className?: string;
  style?: CSSProperties;
}

function Glyph({
  size = 1,
  className = '',
  style,
  children,
}: CapiroIconProps & { children: React.ReactNode }) {
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

export function CapiroPlusIcon(props: CapiroIconProps) {
  return (
    <Glyph {...props}>
      <path d="M12 5v14M5 12h14" />
    </Glyph>
  );
}

export function CapiroCheckIcon(props: CapiroIconProps) {
  return (
    <Glyph {...props}>
      <path d="M4 12.5l5 5L20 6.5" />
    </Glyph>
  );
}

export function CapiroSearchIcon(props: CapiroIconProps) {
  return (
    <Glyph {...props}>
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="M15.5 15.5L21 21" />
    </Glyph>
  );
}

export function CapiroDownloadIcon(props: CapiroIconProps) {
  return (
    <Glyph {...props}>
      <path d="M12 3.5v11M7.5 10.5l4.5 4.5 4.5-4.5M4.5 19.5h15" />
    </Glyph>
  );
}

export function CapiroSafetyCertificateIcon(props: CapiroIconProps) {
  return (
    <Glyph {...props}>
      <path d="M12 3l7 2.75v6c0 4.2-2.9 7.6-7 9.25-4.1-1.65-7-5.05-7-9.25v-6L12 3z" />
      <path d="M8.75 12l2.25 2.25 4.25-4.5" />
    </Glyph>
  );
}

export function CapiroCopyIcon(props: CapiroIconProps) {
  return (
    <Glyph {...props}>
      <rect x="9" y="9" width="11.5" height="11.5" rx="2" />
      <path d="M15 6.5V5.5a2 2 0 00-2-2H5.5a2 2 0 00-2 2V13a2 2 0 002 2h1" />
    </Glyph>
  );
}

export function CapiroThunderboltIcon(props: CapiroIconProps) {
  return (
    <Glyph {...props}>
      <path d="M13.5 2.5L5 13.5h5.5L9.5 21.5 19 10h-5.75l.25-7.5z" />
    </Glyph>
  );
}

export function CapiroBellIcon(props: CapiroIconProps) {
  return (
    <Glyph {...props}>
      <path d="M18 9a6 6 0 10-12 0c0 4.5-1.75 6-1.75 6h15.5S18 13.5 18 9z" />
      <path d="M10.25 18.5a2 2 0 003.5 0" />
    </Glyph>
  );
}

export function CapiroFileTextIcon(props: CapiroIconProps) {
  return (
    <Glyph {...props}>
      <path d="M14 3.5H7a2 2 0 00-2 2v13a2 2 0 002 2h10a2 2 0 002-2V8.5L14 3.5z" />
      <path d="M13.5 3.75V9h5M8.5 13h7M8.5 16.5h4.5" />
    </Glyph>
  );
}

export function CapiroReadIcon(props: CapiroIconProps) {
  return (
    <Glyph {...props}>
      <path d="M12 6.75C10.5 5.4 8.4 4.75 4.5 4.75v13c3.9 0 6 .65 7.5 2 1.5-1.35 3.6-2 7.5-2v-13c-3.9 0-6 .65-7.5 2z" />
      <path d="M12 6.75v12" />
    </Glyph>
  );
}

export function CapiroChevronDownIcon(props: CapiroIconProps) {
  return (
    <Glyph {...props}>
      <path d="M6 9l6 6 6-6" />
    </Glyph>
  );
}

export function CapiroHourglassIcon(props: CapiroIconProps) {
  return (
    <Glyph {...props}>
      <path d="M5 2h14M5 22h14M7 2v4l5 5-5 5v4M17 2v4l-5 5 5 5v4" strokeLinecap="round" strokeLinejoin="round"/>
    </Glyph>
  );
}

export function CapiroArrowRightIcon(props: CapiroIconProps) {
  return (
    <Glyph {...props}>
      <path d="M5 12h14M13 6l6 6-6 6" strokeLinecap="round" strokeLinejoin="round"/>
    </Glyph>
  );
}

export function CapiroMailPlusIcon(props: CapiroIconProps) {
  return (
    <Glyph {...props}>
      <path d="M22 13V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h9" strokeLinecap="round" strokeLinejoin="round"/>
      <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" strokeLinecap="round" strokeLinejoin="round"/>
      <path d="M19 16v6M16 19h6" strokeLinecap="round" strokeLinejoin="round"/>
    </Glyph>
  );
}
