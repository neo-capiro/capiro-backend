import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { VerificationStatus } from '../components/trust/VerificationStatus.js';
import { MeriEditReview } from '../pages/workspace/editor/MeriEditReview.js';
import '../theme.css';
import '../pages/workspace/workspace.css';

function Fixture() {
  const [failedSections, setFailedSections] = useState(['Budget impact']);
  const [exportAcknowledged, setExportAcknowledged] = useState(false);

  return (
    <div className="phase19-fixture">
      <header>
        <h1>MeriV2 Phase 19 assurance fixture</h1>
        <p>
          Deterministic browser states for viewport, keyboard, focus, live-region, and
          reduced-motion inspection. These states supplement—but never replace—the
          authenticated application scenarios.
        </p>
      </header>

      <section aria-labelledby="phase19-chat-hold">
        <h2 id="phase19-chat-hold">High-risk chat hold</h2>
        <VerificationStatus
          display={{
            state: 'not_verified',
            label: 'Held for review',
            detail: 'One high-risk claim lacks source support and was withheld before release.',
            supportedCount: 2,
            unsupportedCount: 1,
            findings: [
              {
                check: 'claim_support',
                severity: 'high',
                detail: 'Funding amount is unsupported by the supplied evidence.',
                section: 'Executive summary',
              },
            ],
          }}
        />
        <div role="alert">Unsupported high-risk prose was not persisted or shown as final output.</div>
      </section>

      <section aria-labelledby="phase19-editor-hold">
        <h2 id="phase19-editor-hold">In-editor held edit</h2>
        <MeriEditReview
          edits={[
            {
              op: 'replace_section',
              section: 'Executive Summary',
              content: '<p>Proposed, source-linked language [1].</p>',
              note: 'The unsupported amount was removed before review.',
            },
            {
              op: 'remove_section',
              section: 'Unverified Forecast',
              note: 'Removal requires explicit confirmation.',
            },
          ] as never}
          document={{
            sections: ['Executive Summary', 'Unverified Forecast'],
            content: {
              'Executive Summary': '<p>Existing summary.</p>',
              'Unverified Forecast': '<p>Unsupported forecast.</p>',
            },
          }}
          confidence={{ level: 'medium', label: 'Partially verified; review required.' }}
          structuralWarnings={[
            {
              code: 'unsupported_high_risk_claim',
              message: 'The forecast has no supporting source.',
              peCode: 'Unverified Forecast',
            },
          ]}
          citations={[{ n: 1, title: 'Official committee report' }]}
          onApply={async () => ({
            status: 'save_failed',
            message: 'The local edit remains visible; persistence was withheld.',
          })}
          onDismiss={() => undefined}
          onRetrySave={async () => ({ status: 'saved', message: 'Saved after retry.' })}
          onUndo={async () => ({ status: 'saved', message: 'Local changes undone.' })}
        />
      </section>

      <section aria-labelledby="phase19-workspace-partial">
        <h2 id="phase19-workspace-partial">Workspace partial generation</h2>
        <div className="phase19-section-grid">
          <article>
            <h3>Executive summary</h3>
            <p role="status">Generated and verified.</p>
          </article>
          <article>
            <h3>Budget impact</h3>
            {failedSections.includes('Budget impact') ? (
              <>
                <p role="alert">Held: the requested amount is unsupported.</p>
                <button
                  type="button"
                  onClick={() => setFailedSections((current) => current.filter((x) => x !== 'Budget impact'))}
                >
                  Retry failed sections
                </button>
              </>
            ) : (
              <p role="status">Retry completed; unsupported amount remains excluded.</p>
            )}
          </article>
        </div>
      </section>

      <section aria-labelledby="phase19-strategy-hold">
        <h2 id="phase19-strategy-hold">Strategy and Steward hold</h2>
        <div role="alert" aria-live="assertive">
          Context or policy binding changed after approval. The artifact must be regenerated.
        </div>
        <dl>
          <div>
            <dt>Policy version</dt>
            <dd>generic-ga-policy@v3</dd>
          </div>
          <div>
            <dt>Context Packet</dt>
            <dd>persisted · exact ID verified</dd>
          </div>
        </dl>
      </section>

      <section aria-labelledby="phase19-export">
        <h2 id="phase19-export">Export acknowledgment</h2>
        <label>
          <input
            type="checkbox"
            checked={exportAcknowledged}
            onChange={(event) => setExportAcknowledged(event.target.checked)}
          />{' '}
          I reviewed held and partially verified findings before export.
        </label>
        <button type="button" disabled={!exportAcknowledged}>
          Export reviewed artifact
        </button>
      </section>

      <section aria-labelledby="phase19-proposal-policy">
        <h2 id="phase19-proposal-policy">Proposal card policy version</h2>
        <article aria-label="Action proposal governed by generic-ga-policy version 3">
          <h3>Send reviewed follow-up</h3>
          <p>Policy: generic-ga-policy@v3 · Rule: external-send-review</p>
          <button type="button">Approve action</button>
          <button type="button">Dismiss</button>
        </article>
      </section>
    </div>
  );
}

const root = document.getElementById('root');
if (!root) throw new Error('Phase 19 fixture root is missing.');
createRoot(root).render(
  <StrictMode>
    <Fixture />
  </StrictMode>,
);
