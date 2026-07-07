/**
 * DashboardTour — first-login product tour (onboarding v1, Flow 2B.4).
 * Verbatim port of `OB_TOUR` + `DashboardTour` from
 * apps/onboard-web/prototype/04-app-env3.jsx: dim overlay, nav spotlight via
 * class injection, callout placement math, step-progress rail, and
 * Back/Next/Finish/Skip controls are all copied 1:1.
 *
 * Adaptations to the real app (selectors only — all style values unchanged):
 * - The prototype's `.sidebar` / `.sb-item` classes become the real shell's
 *   `.app-shell-sider` / antd `.ant-menu-item` + `.ant-menu-submenu-title`.
 * - `[data-tour]` markers sit on the nav label spans inside antd's menu
 *   items, so the spotlight class + rect are resolved on the CLOSEST menu
 *   row (`.ant-menu-item` / `.ant-menu-submenu-title`) to highlight the full
 *   row exactly like the prototype's `.sb-item`.
 * - The Meri target is the floating chat FAB (`.chat-toggle-fab`, prototype
 *   `.meri-fab`).
 */
import { useLayoutEffect, useEffect, useState } from 'react';
import { ObBtn } from './primitives.js';
import './ob-overlay.css';

/** Tour steps — copy is EXACTLY the prototype's OB_TOUR array. */
export const OB_TOUR: Array<{ nav: string; h: string; s: string }> = [
  {
    nav: 'Dashboard',
    h: 'Your Dashboard, Tailored to You',
    s: "A quick view of what's critical in the coming days. Data gets more in-depth the more you use the platform.",
  },
  {
    nav: 'Meri',
    h: 'Meri, Your AI Assistant',
    s: 'Meri pulls context from your connected inbox, calendar, and clients to serve as your "AI Chief of Staff." Ask Meri to perform research, update you on legislation, draft documents, and more.',
  },
  {
    nav: 'Engagement',
    h: 'Your Client Relationship CRM',
    s: 'Prep for meetings, draft tailored email campaigns, and view auto-generated reports in the Engagement manager.',
  },
  {
    nav: 'Portfolio',
    h: "Your Organization's Client List",
    s: "Your org's client profiles live here, along with key information and tailored insights for each one.",
  },
  {
    nav: 'Workspace',
    h: 'Draft Key Documents with Meri',
    s: 'Meri can help you quickly draft personalized memos, white papers, requests, and more.',
  },
  {
    nav: 'Directory',
    h: 'Your Congressional Directory',
    s: 'View and search the full congressional directory of members, staffers, and key insights.',
  },
  {
    nav: 'Intelligence',
    h: 'Intel Tailored for You',
    s: "Explore intelligence tools. LegiWatch surfaces critical insights and alerts you when relevant bills move or your clients' interests are mentioned in hearings. Data Explorer searches Capiro's full federal data records. Program Elements gives you key budget data.",
  },
];

/** Resolve the element to spotlight/measure for a tour step. */
function resolveTourTarget(nav: string): Element | null {
  const marker = document.querySelector(`[data-tour="${nav}"]`);
  if (!marker) return null;
  // Nav markers live on the label span inside antd's menu rows; highlight the
  // full row (icon + label) like the prototype's `.sb-item`. The Meri FAB
  // marker is on the button itself, so `closest` falls through to it.
  return marker.closest('.ant-menu-item, .ant-menu-submenu-title') ?? marker;
}

export function DashboardTour({
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
    document.body.classList.add('ob-tour');
    return () => {
      document.body.classList.remove('ob-tour');
      const h = document.querySelector('.ob-tour-hot');
      if (h) h.classList.remove('ob-tour-hot');
    };
  }, []);

  useLayoutEffect(() => {
    const prev = document.querySelector('.ob-tour-hot');
    if (prev) prev.classList.remove('ob-tour-hot');
    const el = resolveTourTarget(tourStep.nav);
    const measure = () => {
      if (el) setRect(el.getBoundingClientRect());
    };
    if (el) {
      el.classList.add('ob-tour-hot');
      measure();
    } else {
      setRect(null);
    }
    window.addEventListener('resize', measure);
    return () => {
      window.removeEventListener('resize', measure);
      if (el) el.classList.remove('ob-tour-hot');
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
    place = { style: { top: 130, left: 228 }, arrow: { left: -7, top: 42 } };
  } else if (rect.top > vh * 0.55) {
    // bottom-anchored target (floating Meri button) → callout above, arrow points down
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
      <style>{`
        body.ob-tour .app-shell-sider{position:relative;z-index:1300;}
        body.ob-tour .app-shell-nav .ant-menu-item,
        body.ob-tour .app-shell-nav .ant-menu-submenu-title,
        body.ob-tour .app-shell-brand-row,
        body.ob-tour .app-shell-bottom > *{opacity:0.34;transition:opacity .2s ease, background .2s ease, box-shadow .2s ease;}
        body.ob-tour .app-shell-nav .ant-menu-item.ob-tour-hot,
        body.ob-tour .app-shell-nav .ant-menu-submenu-title.ob-tour-hot{opacity:1;background:rgba(42,87,206,0.30);border-radius:7px;box-shadow:0 0 0 1.5px var(--accent), 0 0 26px rgba(42,87,206,0.6);}
        body.ob-tour .chat-toggle-fab.ob-tour-hot{z-index:1305 !important;box-shadow:0 0 0 3px #fff, 0 0 0 6px var(--accent), 0 0 34px rgba(42,87,206,0.75) !important;}
      `}</style>
      <div
        style={{ position: 'fixed', inset: 0, background: 'rgba(15,17,25,0.6)', zIndex: 1200 }}
      ></div>
      <div
        className="ob-overlay"
        style={{
          position: 'fixed',
          width: W,
          zIndex: 1310,
          background: '#fff',
          borderRadius: 12,
          boxShadow: '0 22px 56px rgba(12,18,40,0.42)',
          padding: '17px 20px 15px',
          ...place.style,
        }}
      >
        <div
          style={{
            position: 'absolute',
            width: 14,
            height: 14,
            background: '#fff',
            transform: 'rotate(45deg)',
            borderRadius: 2,
            ...place.arrow,
          }}
        ></div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 13 }}>
          <div style={{ display: 'flex', gap: 4, flex: 1 }}>
            {steps.map((_, k) => (
              <span
                key={k}
                style={{
                  flex: 1,
                  height: 3,
                  borderRadius: 2,
                  background: k <= i ? 'var(--accent)' : 'var(--border-1)',
                }}
              ></span>
            ))}
          </div>
          <span
            style={{
              fontSize: 11,
              fontFamily: 'var(--font-mono)',
              letterSpacing: 0,
              color: 'var(--ink-3)',
              flexShrink: 0,
            }}
          >
            {i + 1}/{steps.length}
          </span>
        </div>
        <h3
          style={{
            margin: '0 0 6px',
            fontFamily: 'var(--font-serif)',
            fontWeight: 500,
            fontSize: 18,
            letterSpacing: '-0.01em',
            lineHeight: 1.22,
          }}
        >
          {tourStep.h}
        </h3>
        <p
          style={{
            margin: 0,
            fontSize: 12.5,
            lineHeight: 1.55,
            color: 'var(--ink-2)',
            textWrap: 'pretty',
          }}
        >
          {tourStep.s}
        </p>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 16 }}>
          <button
            type="button"
            onClick={end}
            style={{
              fontFamily: 'var(--font-sans)',
              fontSize: 12,
              color: 'var(--ink-3)',
              background: 'transparent',
              border: 'none',
              cursor: 'pointer',
              padding: 0,
            }}
          >
            Skip tour
          </button>
          <span style={{ flex: 1 }}></span>
          {i > 0 && (
            <ObBtn size="sm" variant="secondary" onClick={() => setStep(i - 1)}>
              Back
            </ObBtn>
          )}
          <ObBtn size="sm" variant="primary" onClick={() => (last ? end() : setStep(i + 1))}>
            {last ? 'Finish' : 'Next'}
          </ObBtn>
        </div>
      </div>
    </>
  );
}
