/**
 * Business Development Phase 2 — evidence dossier drawer.
 *
 * Contract (backend-04-report + bizdev-dossier.service.ts):
 * - Company dossier: GET /dossier/companies/:canonicalEntityId.
 * - Prospect dossier: GET /prospects/:prospectId/dossier.
 * - The header is requested with ?section=identity; each non-identity section
 *   is requested INDEPENDENTLY with ?section=<kind>. Non-identity responses
 *   repeat the identity section — it is ignored here. No full no-section
 *   request is ever issued alongside section requests.
 * - Every section is { section, status, statusText, evidence, detail };
 *   evidence items carry the normalized provenance envelope. One section
 *   failing never blanks the others; each has its own retry.
 * - People is deferred/zero-call and is only ever rendered as its honest
 *   section state — the UI makes no people-provider request of its own.
 * - The drawer opens WITHOUT saving; dossiers are read-only views.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { useApi } from '../../../lib/use-api.js';
import { CapiroButton } from '../../components/actions/index.js';
import { CapiroDrawer } from '../../components/overlays/index.js';
import { formatDateShort } from '../../lib/labels.js';
import {
  BIZDEV_DOSSIER_SECTION_LABELS,
  applyBizDevRoute,
  resolveBizDevRoute,
  type BizDevDossierSection as RouteSection,
} from './bizdev-routing.js';
import {
  BIZDEV_EVIDENCE_STATUS_LABELS,
  BIZDEV_RELATIONSHIP_LABELS,
  bizdevErrorMessage,
  bizdevKeys,
  getBizDevCompanyDossier,
  getBizDevProspectDossier,
  readBizDevJevSuggestion,
  type BizDevDossier,
  type BizDevDossierSection,
  type BizDevDossierSectionKind,
  type BizDevEvidenceItem,
  type BizDevJevSuggestion,
} from './bizdev-api.js';

const IDENTITY_BASIS_LABELS: Record<string, string> = {
  exact_uei: 'matched on an exact UEI identifier',
  exact_name: 'matched on exact legal name (no identifier verified)',
  unresolved_prospect: 'not confirmed yet — this prospect has no resolved organization',
};

/** Safe single-line rendering for a structured detail value. */
function detailValue(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map((v) => detailValue(v)).filter(Boolean).join(', ');
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/** Human label for a detail key (lowercase snake → readable words). */
function detailKeyLabel(key: string): string {
  return key
    .replace(/_/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase();
}

/** Structured detail rendered as selected key/value rows — never [object Object]. */
function DetailRows({ detail }: { detail: Record<string, unknown> }) {
  // Phase 3: raw internal Jev detail keys are NEVER rendered through the
  // generic detail table — no probabilities, prompts, private notes,
  // contacts or conflict reasons can leak through this path.
  const entries = Object.entries(detail ?? {})
    .filter(([k, v]) => !k.toLowerCase().startsWith('jev') && v != null && v !== '');
  if (entries.length === 0) return null;
  return (
    <dl className="capiro-bizdev__source-list">
      {entries.map(([key, value]) => (
        <div key={key}>
          <dt>{detailKeyLabel(key)}</dt>
          <dd>{detailValue(value)}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * Phase 3 optional Jev suggestion rendering — canary-ready, server-gated.
 * Each label is rendered ONLY from the exact whitelisted server token
 * (readBizDevJevSuggestion); the browser never infers a suggestion from
 * confidence, prose, relationship strength or probability, and a null
 * suggestion renders exactly the Phase 2 output.
 */
function JevSuggestionLabels({ suggestion }: { suggestion: BizDevJevSuggestion | null }) {
  if (!suggestion) return null;
  if (suggestion === 'identity_review_required') {
    return (
      <p className="capiro-bizdev__jev-note">
        <span className="capiro-bizdev__flag capiro-bizdev__flag--conflict">
          Jev suggestion — review required
        </span>
      </p>
    );
  }
  if (suggestion === 'possible_fit') {
    return (
      <span className="capiro-bizdev__flag capiro-bizdev__flag--conflict">Possible fit</span>
    );
  }
  if (suggestion === 'direct_fit') {
    return <span className="capiro-bizdev__flag capiro-bizdev__flag--direct">Direct fit</span>;
  }
  // not_evaluated — truthful and unobtrusive.
  return (
    <p className="capiro-bizdev__meta">Not evaluated — no automated suggestion for this section.</p>
  );
}

function SourceInspector({ item }: { item: BizDevEvidenceItem }) {
  return (
    <details className="capiro-bizdev__source-details">
      <summary className="capiro-bizdev__source-summary">Source details</summary>
      <dl className="capiro-bizdev__source-list">
        <div>
          <dt>Source</dt>
          <dd>
            {item.originalSourceName ?? item.sourceFamily}
            {item.originalSourceId ? ` (${item.originalSourceId})` : ''}
          </dd>
        </div>
        <div>
          <dt>Source family</dt>
          <dd>{item.sourceFamily}</dd>
        </div>
        {item.recordId ? (
          <div>
            <dt>Record ID</dt>
            <dd>{item.recordId}</dd>
          </div>
        ) : null}
        {item.scopeChecked ? (
          <div>
            <dt>Scope checked</dt>
            <dd>{item.scopeChecked}</dd>
          </div>
        ) : null}
        <div>
          <dt>Relationship</dt>
          <dd>{BIZDEV_RELATIONSHIP_LABELS[item.relationshipStrength]}</dd>
        </div>
        {item.eventDate ? (
          <div>
            <dt>Event date</dt>
            <dd>{formatDateShort(item.eventDate) ?? item.eventDate}</dd>
          </div>
        ) : null}
        {item.effectiveDate ? (
          <div>
            <dt>Effective date</dt>
            <dd>{formatDateShort(item.effectiveDate) ?? item.effectiveDate}</dd>
          </div>
        ) : null}
        {item.fiscalYear != null ? (
          <div>
            <dt>Fiscal year</dt>
            <dd>FY{item.fiscalYear}</dd>
          </div>
        ) : null}
        {item.stage ? (
          <div>
            <dt>Stage</dt>
            <dd>{item.stage}</dd>
          </div>
        ) : null}
        {item.sourceUpdatedAt ? (
          <div>
            <dt>Source updated</dt>
            <dd>{formatDateShort(item.sourceUpdatedAt) ?? item.sourceUpdatedAt}</dd>
          </div>
        ) : null}
        {item.fetchedAt ? (
          <div>
            <dt>Fetched</dt>
            <dd>{formatDateShort(item.fetchedAt) ?? item.fetchedAt}</dd>
          </div>
        ) : null}
        <div>
          <dt>Status</dt>
          <dd>{BIZDEV_EVIDENCE_STATUS_LABELS[item.status] ?? item.status}</dd>
        </div>
        <div>
          <dt>Link</dt>
          <dd>
            {item.locator ? (
              <a
                href={item.locator}
                target="_blank"
                rel="noreferrer"
                className="capiro-bizdev__source-link"
              >
                Open source record
              </a>
            ) : (
              'No public link for this record'
            )}
          </dd>
        </div>
      </dl>
      <DetailRows detail={item.detail} />
    </details>
  );
}

function EvidenceCard({ item }: { item: BizDevEvidenceItem }) {
  return (
    <li className="capiro-bizdev__evidence-card">
      <div className="capiro-bizdev__evidence-head">
        {item.relationshipStrength === 'direct' ? (
          <span className="capiro-bizdev__flag capiro-bizdev__flag--direct">Direct</span>
        ) : null}
        <span className="capiro-bizdev__evidence-title">{item.title}</span>
      </div>
      <SourceInspector item={item} />
    </li>
  );
}

function EvidenceGroups({ evidence }: { evidence: BizDevEvidenceItem[] }) {
  const direct = evidence.filter((item) => item.relationshipStrength === 'direct');
  const potential = evidence.filter((item) => item.relationshipStrength !== 'direct');
  return (
    <>
      {direct.length > 0 ? (
        <ul className="capiro-bizdev__evidence-list">
          {direct.map((item) => (
            <EvidenceCard key={`${item.sourceFamily}-${item.recordId ?? item.title}`} item={item} />
          ))}
        </ul>
      ) : null}
      {potential.length > 0 ? (
        <div className="capiro-bizdev__potential">
          <h4 className="capiro-bizdev__potential-title">Potential relevance</h4>
          <p className="capiro-bizdev__meta">
            These are conditional, thematic or unresolved relationships — not statements that
            this company directly holds them.
          </p>
          <ul className="capiro-bizdev__evidence-list">
            {potential.map((item) => (
              <EvidenceCard
                key={`p-${item.sourceFamily}-${item.recordId ?? item.title}`}
                item={item}
              />
            ))}
          </ul>
        </div>
      ) : null}
    </>
  );
}

const NON_IDENTITY_SECTIONS: BizDevDossierSectionKind[] = [
  'government_exposure',
  'relevant_signals',
  'footprint',
  'lobbying',
  'people',
];

function DossierSectionBody({
  tenantId,
  subject,
  kind,
  selected,
}: {
  tenantId: string;
  subject: { kind: 'company' | 'prospect'; id: string };
  kind: BizDevDossierSectionKind;
  selected: boolean;
}) {
  const api = useApi();
  const queryClient = useQueryClient();
  const key =
    subject.kind === 'company'
      ? bizdevKeys.companyDossierSection(tenantId, subject.id, kind)
      : bizdevKeys.prospectDossierSection(tenantId, subject.id, kind);
  const query = useQuery({
    queryKey: key,
    queryFn: () =>
      subject.kind === 'company'
        ? getBizDevCompanyDossier(api, subject.id, kind)
        : getBizDevProspectDossier(api, subject.id, kind),
    // Non-identity responses repeat the identity section — ignore it.
    select: (dossier: BizDevDossier): BizDevDossierSection | undefined =>
      dossier.sections[kind],
  });
  const retry = () => void queryClient.resetQueries({ queryKey: key, exact: true });

  const label = BIZDEV_DOSSIER_SECTION_LABELS[kind];
  const section = query.data;

  return (
    <section
      className={`capiro-bizdev__dossier-section${selected ? ' is-active' : ''}`}
      aria-labelledby={`bizdev-dossier-${kind}`}
      aria-current={selected || undefined}
    >
      <div className="capiro-bizdev__title-row">
        <h3 className="capiro-bizdev__section-title" id={`bizdev-dossier-${kind}`}>
          {label}
        </h3>
        <span className="capiro-bizdev__meta">
          {section ? BIZDEV_EVIDENCE_STATUS_LABELS[section.status] ?? section.status : ''}
        </span>
      </div>

      {query.isPending ? (
        <div className="capiro-bizdev__meta" aria-busy="true">
          Loading this section…
        </div>
      ) : query.isError ? (
        <div className="capiro-bizdev__section-error" role="alert">
          <p className="capiro-bizdev__meta">
            This section could not be loaded ({bizdevErrorMessage(query.error)}). Other sections
            are unaffected.
          </p>
          <CapiroButton size="compact" onClick={retry}>
            Retry this section
          </CapiroButton>
        </div>
      ) : !section ? (
        <p className="capiro-bizdev__meta">No data was returned for this section.</p>
      ) : (
        <>
          {/* Honest state text from the backend — dates, partial, deferred… */}
          <p className="capiro-bizdev__meta" role="status">
            {section.statusText}
          </p>
          {kind === 'relevant_signals' ? (
            <JevSuggestionLabels suggestion={readBizDevJevSuggestion(section.detail)} />
          ) : null}
          {section.detail && Object.keys(section.detail).length > 0 ? (
            <DetailRows detail={section.detail} />
          ) : null}
          {section.status === 'error' ? (
            <CapiroButton size="compact" onClick={retry}>
              Retry this section
            </CapiroButton>
          ) : null}
          <EvidenceGroups evidence={section.evidence ?? []} />
        </>
      )}
    </section>
  );
}

export function DossierDrawer({ tenantId }: { tenantId: string }) {
  const api = useApi();
  const [searchParams, setSearchParams] = useSearchParams();
  const route = resolveBizDevRoute(searchParams);

  const subject = route.dossierEntityId
    ? ({ kind: 'company' as const, id: route.dossierEntityId })
    : route.dossierProspectId
      ? ({ kind: 'prospect' as const, id: route.dossierProspectId })
      : null;

  // Header: exactly one ?section=identity request — never a full dossier.
  const header = useQuery({
    queryKey: subject
      ? subject.kind === 'company'
        ? bizdevKeys.companyDossierIdentity(tenantId, subject.id)
        : bizdevKeys.prospectDossierIdentity(tenantId, subject.id)
      : ['business-development', tenantId, 'dossier', 'none'],
    queryFn: () =>
      subject!.kind === 'company'
        ? getBizDevCompanyDossier(api, subject!.id, 'identity')
        : getBizDevProspectDossier(api, subject!.id, 'identity'),
    enabled: Boolean(subject),
  });

  const close = () =>
    setSearchParams(
      applyBizDevRoute(searchParams, { dossierEntityId: '', dossierProspectId: '', dossierSection: '' }),
      { replace: true },
    );

  if (!subject) return null;

  const title = header.data?.canonicalName
    ? `Evidence dossier — ${header.data.canonicalName}`
    : 'Evidence dossier';
  const identity = header.data?.sections.identity;

  return (
    <CapiroDrawer open title={title} onClose={close} width={720}>
      <div className="capiro-bizdev__drawer capiro-bizdev__dossier">
        {header.isPending ? (
          <div
            className="capiro-portfolio__skeleton capiro-portfolio__skeleton--tall"
            aria-busy="true"
          />
        ) : header.isError ? (
          <p className="capiro-bizdev__statusnote" role="status">
            The dossier header could not be loaded ({bizdevErrorMessage(header.error)}), but the
            sections below load independently.
          </p>
        ) : (
          <div className="capiro-bizdev__dossier-header">
            <p className="capiro-bizdev__meta">
              {header.data?.canonicalName
                ? `Organization: ${header.data.canonicalName}`
                : 'Organization name is not confirmed yet.'}
            </p>
            <p className="capiro-bizdev__meta">
              Identity:{' '}
              {IDENTITY_BASIS_LABELS[header.data?.identityBasis ?? 'unresolved_prospect'] ??
                header.data?.identityBasis}
              {header.data?.identityScope === 'tenant_private'
                ? ' · private to your firm'
                : header.data?.identityScope === 'global_public'
                  ? ' · public shared record'
                  : ''}
            </p>
            {identity ? (
              <>
                <p className="capiro-bizdev__meta" role="status">
                  {identity.statusText}
                </p>
                {readBizDevJevSuggestion(identity.detail) === 'identity_review_required' ? (
                  <JevSuggestionLabels suggestion="identity_review_required" />
                ) : null}
                {identity.detail && Object.keys(identity.detail).length > 0 ? (
                  <DetailRows detail={identity.detail} />
                ) : null}
                <EvidenceGroups evidence={identity.evidence ?? []} />
              </>
            ) : null}
            {header.data?.generatedAt ? (
              <p className="capiro-bizdev__meta">
                Generated {formatDateShort(header.data.generatedAt) ?? header.data.generatedAt}
              </p>
            ) : null}
            <p className="capiro-bizdev__meta">
              {subject.kind === 'prospect'
                ? 'Opened from a saved prospect of your firm. Viewing never changes the prospect.'
                : 'You are viewing this dossier without saving the company. Nothing is added to your pipeline until you save a prospect.'}
            </p>
          </div>
        )}
        {NON_IDENTITY_SECTIONS.map((kind) => (
          <DossierSectionBody
            key={kind}
            tenantId={tenantId}
            subject={subject}
            kind={kind}
            selected={route.dossierSection === kind}
          />
        ))}
      </div>
    </CapiroDrawer>
  );
}

/** Route-level helper: dossier open state from the resolved route. */
export function isDossierOpen(searchParams: URLSearchParams): boolean {
  const route = resolveBizDevRoute(searchParams);
  return Boolean(route.dossierEntityId || route.dossierProspectId);
}

export type { RouteSection };
