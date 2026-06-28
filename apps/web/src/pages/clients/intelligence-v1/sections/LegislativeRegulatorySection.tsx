/**
 * Section 4, Regulatory
 * Regulatory lifecycle rails (Federal Register rulemakings + comment deadlines).
 *
 * NOTE: Bill tracking (the 4-stage pipeline kanban) moved out of Intelligence
 * into the dedicated client-profile "Tracker" tab (apps/web/src/pages/clients/
 * tracker/). This section now carries regulatory content only.
 */

import { useMemo } from 'react';
import type { ClientProfileV1 } from '../mappers.js';
import { RegLifecycleRail } from '../components/RegLifecycleRail.js';
import { HelpTip } from '../components/HelpTip.js';
import { HELP } from '../help-content.js';

interface LegislativeRegulatorySectionProps {
  aggregate?: ClientProfileV1;
  /** Retained for call-site compatibility; bill tracking now lives in the Tracker tab. */
  clientId?: string;
  billDrillHref?: string;
}

interface RegBlock {
  title: string;
  source: string;
  docket: string;
  steps: { label: string; state: 'done' | 'current' | 'pending' }[];
  deadline: string;
  deadlineSeverity: 'crit' | 'warn';
}

export function LegislativeRegulatorySection({ aggregate }: LegislativeRegulatorySectionProps) {
  const regulatoryLifecycle = aggregate?.sections.legislativeRegulatory.regulatoryLifecycle;
  const dynamicRegs = regulatoryLifecycle?.rails;

  const regsData: RegBlock[] = useMemo(
    () =>
      dynamicRegs?.length
        ? dynamicRegs.map((r) => {
            // Match the API's currentStage against the stable stage `key` first,
            // then fall back to the display `label`. Matching on label alone is
            // brittle: any casing/whitespace/wording drift yields currentIdx = -1,
            // which renders every step as 'pending' (no progress shown at all).
            const target = (r.currentStage ?? '').trim().toLowerCase();
            const currentIdx = r.stages.findIndex(
              (s) =>
                s.key.trim().toLowerCase() === target || s.label.trim().toLowerCase() === target,
            );
            const steps = r.stages.map((s, idx) => ({
              label: s.label,
              state:
                currentIdx < 0
                  ? ('pending' as const)
                  : idx < currentIdx
                    ? ('done' as const)
                    : idx === currentIdx
                      ? ('current' as const)
                      : ('pending' as const),
            }));

            let deadlineSeverity: 'crit' | 'warn' = 'warn';
            let deadlineText = 'No open deadline';
            if (r.deadline) {
              const deadlineDate = new Date(r.deadline);
              const days = Math.ceil((deadlineDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24));
              deadlineSeverity = days <= 3 ? 'crit' : 'warn';
              deadlineText = `Comment deadline · ${deadlineDate.toLocaleDateString()}`;
            }

            return {
              title: r.title,
              // Dedupe agency names: the API can repeat an agency (e.g. a parent
              // department listed alongside its sub-agency), which rendered as
              // "Transportation Department / Transportation Department / …".
              source:
                [...new Set(r.agencyNames.map((a) => a.trim()).filter(Boolean))].join(' / ') ||
                'Federal Register',
              docket: r.documentNumber,
              steps,
              deadline: deadlineText,
              deadlineSeverity,
            };
          })
        : [],
    [dynamicRegs],
  );

  return (
    <section id="legislative-regulatory" className="iv1-section">
      <div className="iv1-sec-head">
        <span className="iv1-sec-num">4</span>
        <h2>Regulatory</h2>
        <span className="iv1-sec-sub">Regulation lifecycle rails · comment deadlines</span>
      </div>

      <div className="iv1-surface">
        <div className="iv1-surface-head">
          <h3>
            Regulatory lifecycle <HelpTip title={HELP.regulatory} />
          </h3>
          <span className="iv1-surface-sub">
            {regulatoryLifecycle?.totalRegulations ?? regsData.length} rules tracked ·{' '}
            {regulatoryLifecycle?.totalLinkedBills ?? 0} linked bills
          </span>
        </div>
        {regsData.length > 0 ? (
          <RegLifecycleRail rails={regsData} />
        ) : (
          <div className="iv1-empty" style={{ padding: '24px 16px', textAlign: 'center' }}>
            <b>No regulations tracked</b>
            <span>
              No Federal Register rulemakings are linked to this client's tracked issues yet.
            </span>
          </div>
        )}
      </div>
    </section>
  );
}
