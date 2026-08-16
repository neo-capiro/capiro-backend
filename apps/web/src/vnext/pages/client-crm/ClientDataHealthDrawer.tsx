import { CapiroBadge } from '../../components/badges/index.js';
import { CapiroButton } from '../../components/actions/index.js';
import { CapiroDrawer } from '../../components/overlays/index.js';
import { useClientDataHealth } from './client-data-health.js';
import type { Client } from '../../../pages/clients/clientTypes.js';

/**
 * Data health — Figma `907:3464`.
 *
 * One place to see whether each source behind this client is actually
 * answering. The reads themselves live in `useClientDataHealth`, shared with
 * the breadcrumb's freshness label and gap chip so the chip's count and this
 * drawer's rows are the same numbers off the same cache, never two opinions.
 *
 * Every row reports one of three states, and they are deliberately distinct:
 *
 *   OK          the source answered and returned records
 *   EMPTY       the source answered and has nothing — a real, trustworthy zero
 *   UNAVAILABLE the source failed, which is NOT zero and never renders as one
 *
 * That distinction is the product-wide invariant both the Program Elements and
 * LegiWatch handoff frames state independently.
 */
export function ClientDataHealthDrawer({
  client,
  onClose,
}: {
  client: Client;
  onClose: () => void;
}) {
  const { rows, gaps, failures, refetchAll } = useClientDataHealth(client);

  return (
    <CapiroDrawer open title={`Data health — ${client.name}`} onClose={onClose}>
      <div className="capiro-crm-form">
        <p className="capiro-crm__foot">
          {failures === 0
            ? 'Every source behind this client answered.'
            : `${failures} source${failures === 1 ? '' : 's'} could not be read. Counts elsewhere in this profile show a dash rather than a zero for those.`}
        </p>
        {gaps > 0 ? (
          <p className="capiro-crm__foot">
            {`${gaps} source${gaps === 1 ? ' answered' : 's answered'} with nothing recorded yet — these are the profile gaps counted in the breadcrumb.`}
          </p>
        ) : null}

        <ul className="capiro-crm__rows">
          {rows.map(({ source, state, count, error }) => (
            <li key={source.key} className="capiro-crm__review-row">
              <span className="capiro-crm__row-main">
                <span className="capiro-crm__row-title">{source.label}</span>
                <span className="capiro-crm__meta capiro-crm__row-meta">
                  {state === 'loading'
                    ? 'Checking…'
                    : state === 'unavailable'
                      ? // Names the failure instead of implying zero records.
                        (error instanceof Error ? error.message : 'The source did not answer')
                      : state === 'empty'
                        ? 'Answered · no records yet'
                        : `${count} record${count === 1 ? '' : 's'}`}
                </span>
              </span>
              <CapiroBadge
                tone={state === 'unavailable' ? 'danger' : state === 'empty' ? 'warning' : 'success'}
              >
                {state === 'loading' ? 'CHECKING' : state.toUpperCase()}
              </CapiroBadge>
            </li>
          ))}
        </ul>

        <div className="capiro-crm-fill__actions">
          <CapiroButton variant="secondary" size="compact" onClick={refetchAll}>
            Re-check all
          </CapiroButton>
          <CapiroButton variant="quiet" size="compact" onClick={onClose}>
            Close
          </CapiroButton>
        </div>
      </div>
    </CapiroDrawer>
  );
}
