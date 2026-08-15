import type { CSSProperties, SVGProps } from 'react';
import { DashboardIcon, type DashboardIconName } from '../../components/untitledui/dashboard-icons.js';

const ICON_MAP = {
  home: 'HomeLine',
  briefcase: 'Briefcase01',
  mail: 'Mail01',
  grid: 'Grid01',
  target: 'Target04',
  users: 'Users01',
  search: 'SearchLg',
  'search-refraction': 'SearchLg',
  dots: 'DotsHorizontal',
  chevronDown: 'ChevronRight',
  chevronRight: 'ChevronRight',
  x: 'XClose',
  bell: 'Bell01',
  settings: 'Settings01',
  collapse: 'LayoutAlt01',
  expand: 'LayoutAlt01',
} as const satisfies Readonly<Record<string, DashboardIconName>>;

export type IconName = keyof typeof ICON_MAP;

export function Icon({
  name,
  size = 24,
  className,
  style,
}: { name: IconName; size?: number } & SVGProps<SVGSVGElement>) {
  const transform =
    name === 'chevronDown'
      ? 'rotate(90deg)'
      : name === 'expand'
        ? 'scaleX(-1)'
        : undefined;
  const mergedStyle: CSSProperties | undefined = transform
    ? { ...(style as CSSProperties | undefined), transform }
    : (style as CSSProperties | undefined);
  return <DashboardIcon name={ICON_MAP[name]} size={size} className={className} style={mergedStyle} />;
}

export const NAV_ICON_BY_ROUTE_ID: Readonly<Record<string, IconName>> = {
  dashboard: 'home',
  portfolio: 'briefcase',
  'engagement-manager': 'mail',
  workspace: 'grid',
  strategies: 'target',
  directory: 'users',
  intelligence: 'search-refraction',
};
