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

export function CapiroCalendarIcon(props: CapiroIconProps) {
  return (
    <Glyph {...props}>
      <rect x="3.5" y="5" width="17" height="15.5" rx="2" />
      <path d="M3.5 10h17M8 3v4M16 3v4" />
    </Glyph>
  );
}

export function CapiroDatabaseIcon(props: CapiroIconProps) {
  return (
    <Glyph {...props}>
      <ellipse cx="12" cy="6" rx="7.5" ry="3" />
      <path d="M4.5 6v12c0 1.66 3.36 3 7.5 3s7.5-1.34 7.5-3V6M4.5 12c0 1.66 3.36 3 7.5 3s7.5-1.34 7.5-3" />
    </Glyph>
  );
}

export function CapiroRobotIcon(props: CapiroIconProps) {
  return (
    <Glyph {...props}>
      <rect x="4" y="8" width="16" height="11" rx="2.5" />
      <path d="M12 4.5V8M8.5 13h.01M15.5 13h.01M9 19v2M15 19v2" />
    </Glyph>
  );
}

export function CapiroSettingsIcon(props: CapiroIconProps) {
  return (
    <Glyph {...props}>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 3v2.5M12 18.5V21M4.2 7.5l2.2 1.25M17.6 15.25l2.2 1.25M4.2 16.5l2.2-1.25M17.6 8.75l2.2-1.25" />
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

export function CapiroFolderIcon(props: CapiroIconProps) {
  return (
    <Glyph {...props}>
      <path d="M3.5 7.5a2 2 0 012-2h3.4a2 2 0 011.42.59l1.26 1.26a2 2 0 001.42.59h5.5a2 2 0 012 2v8.06a2 2 0 01-2 2h-13a2 2 0 01-2-2V7.5z" />
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

export function CapiroAudioIcon(props: CapiroIconProps) {
  return (
    <Glyph {...props}>
      <rect x="9" y="3" width="6" height="10.5" rx="3" />
      <path d="M5.5 11.5a6.5 6.5 0 0013 0M12 18v3M8.5 21h7" />
    </Glyph>
  );
}

export function CapiroBarChartIcon(props: CapiroIconProps) {
  return (
    <Glyph {...props}>
      <path d="M4 20.5V13M9.33 20.5V7M14.67 20.5v-9.5M20 20.5V4" />
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

export function CapiroEyeIcon(props: CapiroIconProps) {
  return (
    <Glyph {...props}>
      <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" />
      <circle cx="12" cy="12" r="3" />
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

export function CapiroSaveIcon(props: CapiroIconProps) {
  return (
    <Glyph {...props}>
      <path d="M4.5 6.5a2 2 0 012-2h8.75L19.5 8.75V17.5a2 2 0 01-2 2h-11a2 2 0 01-2-2v-11z" />
      <path d="M8 4.5v5h6.5v-5M8 19.5v-5h8v5" />
    </Glyph>
  );
}
