/**
 * Intelligence Center — "Coming Soon" preview. vNext port of the canonical
 * stub (pages/intelligence/ComingSoonIntelligence.tsx).
 *
 * Same static mockup pack (an HTML preview under /public/mockups) and the
 * same copy: previews of the experience, not live data. The underlying Data
 * Explorer (/explorer) stays intact for bill detail views and deep links.
 */

const PREVIEW_SRC = '/mockups/intelligence-center-preview.html';

export function IntelligenceCenterVNext() {
  return (
    <div className="intel intel-coming-soon" style={{ maxWidth: 1480, margin: '0 auto', width: '100%' }}>
      <div className="intel-coming-banner">
        <div className="intel-coming-banner__eyebrow">Coming Soon</div>
        <h2 className="intel-coming-banner__title">Intelligence Center</h2>
        <p className="intel-coming-banner__body">
          What you&rsquo;re seeing below are mock-ups of what&rsquo;s coming &mdash; designed as{' '}
          <strong>actionable insights and market intelligence</strong>: what changed, why it
          matters, who to contact, what to say, by when, and what proves it. These are previews of
          the experience, not live data yet.
        </p>
      </div>
      <iframe title="Intelligence Center preview" src={PREVIEW_SRC} className="intel-coming-preview" />
    </div>
  );
}
