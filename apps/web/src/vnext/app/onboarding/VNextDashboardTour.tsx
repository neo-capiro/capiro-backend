import { useLayoutEffect, useEffect, useState } from 'react';
import { OB_TOUR } from '../../../components/onboarding/onboarding-shared.js';
import { CapiroButton } from '../../components/actions/index.js';
import './vnext-onboarding.css';

/**
 * VNextDashboardTour — first-login product tour (onboarding v1, Flow 2B.4)
 * for the vNext shell. Re-skin of components/onboarding/DashboardTour.tsx:
 * the step copy (shared OB_TOUR), step navigation, Skip/Back/Next/Finish
 * semantics and the callout placement math are identical — only the
 * presentation moves to vNext tokens.
 *
 * Spotlighting: OB_TOUR step nav values ('Dashboard', 'Meri', 'Portfolio',
 * etc.) are mapped to the vNext AppShellUui data-tour markers
 * ('nav-dashboard', 'nav-meri', 'nav-portfolio') via VNEXT_NAV_MAP below.
 * Steps without a mapping resolve to null and the callout is not shown,
 * keeping the generic lookup in resolveTourTarget without antd-specific
 * closest() wiring.
 */

/**
 * Maps OB_TOUR step .nav values to the data-tour attribute values used by
 * AppShellUui. The legacy DashboardTour uses the same OB_TOUR nav values
 * directly against antd menu items; this local map keeps both tours in sync
 * without modifying the shared onboarding-shared.ts source of truth.
 */
const VNEXT_NAV_MAP: Readonly<Record<string, string>> = {
  Dashboard: 'nav-dashboard',
  Portfolio: 'nav-portfolio',
  Meri: 'nav-meri',
};

/** Resolve the element to spotlight/measure for a tour step. */
function resolveTourTarget(nav: string): Element | null {
  const selector = VNEXT_NAV_MAP[nav] ?? nav;
  return document.querySelector(`[data-tour="${selector}"]`);
}

export function VNextDashboardTour({
  step,
  setStep,
  end,
}: {
  step: number;
  setStep: (index: number) => void;
  /** Finish or Skip — the host records tour completion. */
  end: () => void;
}) {
  const steps = OB_TOUR;
  const i = Math.max(0, Math.min(step | 0, steps.length - 1));
  const tourStep = steps[i]!;
  const [rect, setRect] = useState<DOMRect | null>(null);
  const last = i === steps.length - 1;

  useEffect(() => {
    return () => {
      const h = document.querySelector('.vnext-ob-tour-hot');
      if (h) h.classList.remove('vnext-ob-tour-hot');
    };
  }, []);

  useLayoutEffect(() => {
    const prev = document.querySelector('.vnext-ob-tour-hot');
    if (prev) prev.classList.remove('vnext-ob-tour-hot');
    const el = resolveTourTarget(tourStep.nav);
    const measure = () => {
      if (el) setRect(el.getBoundingClientRect());
    };
    if (el) {
      el.classList.add('vnext-ob-tour-hot');
      measure();
    } else {
      setRect(null);
    }
    window.addEventListener('resize', measure);
    return () => {
      window.removeEventListener('resize', measure);
      if (el) el.classList.remove('vnext-ob-tour-hot');
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [i]);

  const vh = (typeof window !== 'undefined' && window.innerHeight) || 800;
  const vw = (typeof window !== 'undefined' && window.innerWidth) || 1200;
  const W = 330;
  let place: {
    style: React.CSSProperties;
    arrow: React.CSSProperties;
  };
  if (!rect) {
    // No marker resolved — skip rendering the callout for this step.
    // All wired steps (Dashboard, Portfolio, Meri) have markers in AppShellUui;
    // unwired steps (Engagement, Workspace, Directory, Intelligence) produce
    // no callout rather than a stale hardcoded pixel position.
    return (
      <>
        <div className="vnext-ob-tour-scrim" />
      </>
    );
  } else if (rect.top > vh * 0.55) {
    // bottom-anchored target → callout above, arrow points down
    const left = Math.max(16, Math.min(rect.right - W, vw - W - 16));
    const cx = rect.left + rect.width / 2;
    place = {
      style: { bottom: vh - rect.top + 18, left },
      arrow: { bottom: -7, left: Math.min(Math.max(cx - left - 7, 18), W - 26) },
    };
  } else {
    // side target (nav item) → callout to the right, arrow points left
    const center = rect.top + rect.height / 2;
    const top = Math.min(Math.max(center - 78, 46), vh - 232);
    place = {
      style: { top, left: rect.right + 20 },
      arrow: { left: -7, top: Math.min(Math.max(center - top, 16), 150) },
    };
  }

  return (
    <>
      <div className="vnext-ob-tour-scrim" />
      <div className="vnext-ob-tour-callout" style={{ width: W, ...place.style }}>
        <div className="vnext-ob-tour-arrow" style={place.arrow} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 13 }}>
          <div className="vnext-ob-tour-progress">
            {steps.map((_, k) => (
              <span key={k} className={k <= i ? 'is-done' : ''} />
            ))}
          </div>
          <span className="vnext-ob-tour-count">
            {i + 1}/{steps.length}
          </span>
        </div>
        <h3>{tourStep.h}</h3>
        <p>{tourStep.s}</p>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 16 }}>
          <button type="button" className="vnext-ob-tour-skip" onClick={end}>
            Skip tour
          </button>
          <span style={{ flex: 1 }} />
          {i > 0 && (
            <CapiroButton size="compact" variant="secondary" onClick={() => setStep(i - 1)}>
              Back
            </CapiroButton>
          )}
          <CapiroButton
            size="compact"
            variant="primary"
            onClick={() => (last ? end() : setStep(i + 1))}
          >
            {last ? 'Finish' : 'Next'}
          </CapiroButton>
        </div>
      </div>
    </>
  );
}
