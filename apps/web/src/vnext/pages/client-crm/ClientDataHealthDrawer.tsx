import { CapiroBadge } from '../../components/badges/index.js';
import { CapiroButton } from '../../components/actions/index.js';
import { CapiroDrawer } from '../../components/overlays/index.js';
import { useClientDataHealth } from './client-data-health.js';
import type { Client } from '../../../pages/clients/clientTypes.js';

/**
 * Data health — Figma `907:3464`.
 *
 * One place to see whether the six listed profile sections are actually
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
  const { rows, gaps, failures, settled, total, refetchAll } = useClientDataHealth(client);
  const pending = rows.filter((row) => row.state === 'loading').length;

  return (
    <CapiroDrawer open title={`Data health — ${client.name}`} onClose={onClose}>
      <div className="capiro-crm-form">
        <p className="capiro-crm__foot">
          {`${total} profile sections are checked below. Intelligence feeds, opportunity matching, and upstream source freshness are not checked here.`}
        </p>
        <p className="capiro-crm__foot" role="status">
          {!settled
            ? `Checking ${pending} of ${total} profile sections…`
            : failures === 0
              ? `All ${total} checked profile sections answered.`
              : `${failures} of ${total} checked profile sections could not be read. Their record counts are unknown.`}
        </p>
        {gaps > 0 ? (
          <p className="capiro-crm__foot">
            {`${gaps} checked section${gaps === 1 ? ' answered' : 's answered'} with nothing recorded yet — these are the profile gaps counted in the breadcrumb.`}
          </p>
        ) : null}

        <ul className="capiro-crm__rows">
          {rows.map(({ source, state, count, error, fetchedAt }) => (
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
                {fetchedAt != null ? (
                  <span className="capiro-crm__meta capiro-crm__row-meta">
                    Last read in this app: <time dateTime={new Date(fetchedAt).toISOString()}>{new Date(fetchedAt).toLocaleString()}</time>
                  </span>
                ) : null}
              </span>
              <CapiroBadge
                tone={state === 'loading' ? 'neutral' : state === 'unavailable' ? 'danger' : state === 'empty' ? 'warning' : 'success'}
              >
                {state === 'loading' ? 'CHECKING' : state.toUpperCase()}
              </CapiroBadge>
            </li>
          ))}
        </ul>

        <div className="capiro-crm__form-actions">
          <CapiroButton variant="secondary" size="compact" onClick={refetchAll}>
            Re-check these sections
          </CapiroButton>
          <CapiroButton variant="quiet" size="compact" onClick={onClose}>
            Close
          </CapiroButton>
        </div>
      </div>
    </CapiroDrawer>
  );
}
