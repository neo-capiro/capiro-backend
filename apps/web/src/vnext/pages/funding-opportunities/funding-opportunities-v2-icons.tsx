import { DashboardIcon, type DashboardIconName } from '../../components/untitledui/dashboard-icons.js';
import { FUNDING_OPPORTUNITIES_V2_ICON_DATA } from './funding-opportunities-v2-icon-data.js';

type ReferenceIconName = keyof typeof FUNDING_OPPORTUNITIES_V2_ICON_DATA;
export type FundingOpportunityV2IconName = DashboardIconName | ReferenceIconName;
const DASHBOARD_ICON_NAMES: ReadonlySet<string> = new Set([
  'SearchLg', 'Users01', 'Bookmark', 'BookmarkCheck', 'XClose', 'LinkExternal01', 'AlertTriangle',
  'Stars02', 'Sliders02', 'Bell01', 'RefreshCw01', 'HomeLine', 'Briefcase01',
  'Mail01', 'Grid01', 'Target04', 'ChevronRight', 'Settings01', 'LayoutAlt01',
  'DotsGrid', 'Check', 'DotsHorizontal', 'LogOut01', 'User01',
  'Building02', 'ArrowNarrowRight',
]);

export function FundingOpportunityV2Icon({ name, size = 18, color = 'currentColor' }: { name: FundingOpportunityV2IconName; size?: number; color?: string }) {
  if (!DASHBOARD_ICON_NAMES.has(name) || name === 'AlertTriangle') {
    const icon = FUNDING_OPPORTUNITIES_V2_ICON_DATA[name as ReferenceIconName];
    if (icon) return <svg width={size} height={size} viewBox={icon.viewBox} color={color} fill="none" aria-hidden="true" focusable="false" dangerouslySetInnerHTML={{ __html: icon.body }} />;
  }
  return <DashboardIcon name={name as DashboardIconName} size={size} color={color} />;
}
