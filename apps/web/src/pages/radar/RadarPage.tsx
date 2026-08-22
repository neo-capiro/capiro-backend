import { useEffect, useRef, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Empty, Spin } from 'antd';
import { AudioOutlined, FileTextOutlined, SettingOutlined } from '@ant-design/icons';
import { useIntelFeature } from '../../lib/intel-feature-flags.js';
import LegacyRadarPage from './LegacyRadarPage.js';
import { LiveHearingsCanonicalSurface } from './live-hearings/LiveHearingsCanonicalSurface.js';
import { LiveHearingsPage } from './live-hearings/LiveHearingsPage.js';
import {
  LEGIWATCH_LIVE_HEARINGS_V2_FEATURE,
  legiwatchLiveHearingsV2Enabled,
} from './live-hearings/legiwatch-live-hearings-flags.js';
import './LegiWatchShell.css';

export {
  tenantBoardCardMatchesFilter,
  tenantBoardChangeTone,
} from './LegacyRadarPage.js';
export type {
  TenantBoardCard,
  TenantBoardFilter,
} from './LegacyRadarPage.js';

type LegacyRadarTab = 'feed' | 'bills' | 'hearings' | 'watchlist';
type LegiWatchSection = 'bill-tracker' | 'live-hearings' | 'settings';
type BillTrackerView = 'feed' | 'bills';

const LEGACY_TABS = new Set<LegacyRadarTab>(['feed', 'bills', 'hearings', 'watchlist']);

const SECTIONS: ReadonlyArray<{
  id: LegiWatchSection;
  label: string;
  description: string;
  icon: ReactNode;
}> = [
  {
    id: 'bill-tracker',
    label: 'Bill Tracker',
    description: 'Tracked legislation and client-matched activity',
    icon: <FileTextOutlined />,
  },
  {
    id: 'live-hearings',
    label: 'Live Hearings',
    description: 'Live rooms, upcoming hearings, and recordings',
    icon: <AudioOutlined />,
  },
  {
    id: 'settings',
    label: 'Settings',
    description: 'Client watchlists and LegiWatch configuration',
    icon: <SettingOutlined />,
  },
];

function normalizeLegacyTab(value: string | null): LegacyRadarTab {
  return value && LEGACY_TABS.has(value as LegacyRadarTab)
    ? (value as LegacyRadarTab)
    : 'feed';
}

function sectionForTab(tab: LegacyRadarTab): LegiWatchSection {
  if (tab === 'hearings') return 'live-hearings';
  if (tab === 'watchlist') return 'settings';
  return 'bill-tracker';
}

/**
 * Phase 1 LegiWatch information architecture.
 *
 * The proven tracker/hearing implementation remains mounted as a compatibility
 * surface while the new Live Hearings product is built. URL state stays on the
 * existing `tab` values so saved links, alert emails, and browser history do not
 * break during the migration.
 */
export function RadarPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const legacyView = searchParams.get('view');
  const tab = normalizeLegacyTab(searchParams.get('tab') ?? legacyView);
  const section = sectionForTab(tab);
  const lastBillView = useRef<BillTrackerView>(tab === 'bills' ? 'bills' : 'feed');
  const liveHearingsRollout = useIntelFeature(LEGIWATCH_LIVE_HEARINGS_V2_FEATURE);
  const liveHearingsV2Enabled = legiwatchLiveHearingsV2Enabled({
    tenantFlagEnabled: liveHearingsRollout.enabled,
    tenantFlagReady: liveHearingsRollout.ready,
  });
  // `hearing_watch` is the pre-existing tenant gate for the whole Hearings
  // surface (legacy panel AND the rebuilt Live Hearings product). The rebuild
  // must not bypass it: an unflagged tenant must still see the "not enabled"
  // empty state, exactly as the legacy surface always has.
  const hearingWatchFlag = useIntelFeature('hearing_watch');

  useEffect(() => {
    if (tab === 'feed' || tab === 'bills') lastBillView.current = tab;
  }, [tab]);

  // A small number of pre-LegiWatch links used `view`. Canonicalize them once,
  // preserving every unrelated query parameter such as client and alert IDs.
  useEffect(() => {
    if (!legacyView || searchParams.has('tab')) return;
    const next = new URLSearchParams(searchParams);
    next.set('tab', normalizeLegacyTab(legacyView));
    next.delete('view');
    setSearchParams(next, { replace: true });
  }, [legacyView, searchParams, setSearchParams]);

  const selectLegacyTab = (nextTab: LegacyRadarTab) => {
    const next = new URLSearchParams(searchParams);
    next.set('tab', nextTab);
    next.delete('view');
    setSearchParams(next);
  };

  const selectSection = (nextSection: LegiWatchSection) => {
    if (nextSection === 'live-hearings') {
      selectLegacyTab('hearings');
      return;
    }
    if (nextSection === 'settings') {
      selectLegacyTab('watchlist');
      return;
    }
    selectLegacyTab(lastBillView.current);
  };

  return (
    <section className="legiwatch-shell" aria-label="LegiWatch workspace">
      <header className="legiwatch-shell__header">
        <div className="legiwatch-shell__eyebrow">Legislative intelligence</div>
        <h1 className="legiwatch-shell__title" aria-label="LegiWatch">
          <span>Legi</span>
          <span>Watch</span>
        </h1>
        <p className="legiwatch-shell__description">
          Track legislation, enter live committee rooms, and control the signals that matter to
          each client.
        </p>
      </header>

      <nav className="legiwatch-shell__sections" aria-label="LegiWatch sections">
        {SECTIONS.map((item) => (
          <button
            key={item.id}
            type="button"
            className={`legiwatch-shell__section${section === item.id ? ' is-active' : ''}`}
            aria-current={section === item.id ? 'page' : undefined}
            onClick={() => selectSection(item.id)}
          >
            <span className="legiwatch-shell__section-icon" aria-hidden="true">
              {item.icon}
            </span>
            <span>
              <strong>{item.label}</strong>
              <small>{item.description}</small>
            </span>
          </button>
        ))}
      </nav>

      {section === 'bill-tracker' ? (
        <nav className="legiwatch-shell__subnav" aria-label="Bill Tracker views">
          <button
            type="button"
            className={tab === 'feed' ? 'is-active' : ''}
            aria-current={tab === 'feed' ? 'page' : undefined}
            onClick={() => selectLegacyTab('feed')}
          >
            Activity Feed
          </button>
          <button
            type="button"
            className={tab === 'bills' ? 'is-active' : ''}
            aria-current={tab === 'bills' ? 'page' : undefined}
            onClick={() => selectLegacyTab('bills')}
          >
            Tracked Bills
          </button>
        </nav>
      ) : null}

      <div className="legiwatch-shell__content">
        {section === 'live-hearings' ? (
          !hearingWatchFlag.ready ? (
            <div style={{ padding: '64px 0', textAlign: 'center' }}>
              <Spin />
            </div>
          ) : !hearingWatchFlag.enabled ? (
            <Empty description="Hearing Watch is not enabled for this workspace." />
          ) : liveHearingsV2Enabled ? (
            <LiveHearingsCanonicalSurface />
          ) : (
            <LiveHearingsPage />
          )
        ) : (
          <div className="legiwatch-shell__legacy">
            <LegacyRadarPage />
          </div>
        )}
      </div>
    </section>
  );
}

export default RadarPage;
