import type { Prisma } from '@prisma/client';
import type { TenantContext } from '@capiro/shared';
import { ConflictException } from '@nestjs/common';
import {
  FACT_SELECT,
  readProfileFacts,
  writeProfileFact,
  type ProfileFact,
} from './profile-facts.js';
import { subjectColumn, type ProfileSubject } from './profile-subject.js';
import { reviewHash } from './client-profile-fill-review-snapshot.js';
import type { ReviewTransaction } from './client-profile-fill-review-store.js';
import type { FillEvidence } from './client-profile-fill.helpers.js';

export type OfficialIdentity = { type: 'uei' | 'cage' | 'lda_client_id'; value: string };
export type OfficialFactProof = {
  kind: 'sam_registration' | 'lda_filings' | 'federal_award' | 'federal_assistance';
  identity: OfficialIdentity;
  sourceRecordId: string;
  sourceUrl: string;
  observedAt: string;
};
type OfficialFinding = {
  id: string;
  runId: string;
  kind: string;
  targetKey: string;
  source: string;
  proposedValue: unknown;
  evidence: FillEvidence[];
};
type Project = (
  scope: ReviewTransaction,
  ctx: TenantContext,
  subject: ProfileSubject,
  field: string,
  value: unknown,
) => Promise<unknown>;
const normalized = (value: unknown) =>
  typeof value === 'string' ? value.trim().toUpperCase() : '';
const valid = (identity: OfficialIdentity) =>
  identity.type === 'uei'
    ? /^[A-Z0-9]{12}$/.test(identity.value)
    : identity.type === 'cage'
      ? /^[A-Z0-9]{5}$/.test(identity.value)
      : /^[1-9]\d*$/.test(identity.value);

/** Stored identity only: never name similarity, setup selections, model confidence or an unverified alias. */
export async function readOfficialProfileIdentities(
  tx: Prisma.TransactionClient,
  ctx: TenantContext,
  subject: ProfileSubject,
): Promise<OfficialIdentity[]> {
  const table = subject.kind === 'client' ? 'clients' : 'business_development_prospects';
  const identifiers = await tx.$queryRawUnsafe<
    Array<{ type: OfficialIdentity['type']; value: string }>
  >(
    `SELECT i.identifier_type AS type,i.normalized_value AS value FROM ${table} s
      JOIN canonical_entities e ON e.id=s.canonical_entity_id AND e.status='active' AND e.merged_into_entity_id IS NULL
      JOIN entity_identifiers i ON i.entity_id=e.id AND i.status='active' AND i.verified_at IS NOT NULL
      WHERE s.tenant_id=$1::uuid AND s.id=$2::uuid AND i.identifier_type IN ('uei','cage','lda_client_id')
      AND (e.identity_scope='global_public' OR e.tenant_id=$1::uuid)
      AND (i.identity_scope='global_public' OR i.tenant_id=$1::uuid)`,
    ctx.tenantId,
    subject.id,
  );
  const facts = await readProfileFacts(tx, ctx.tenantId, subject);
  for (const fact of facts)
    if (
      fact.isCurrent &&
      fact.status === 'approved' &&
      ['person', 'official'].includes(fact.origin) &&
      ['uei', 'cageCode'].includes(fact.fieldKey)
    )
      identifiers.push({
        type: fact.fieldKey === 'uei' ? 'uei' : 'cage',
        value: normalized(fact.value),
      });
  if (subject.kind === 'client') {
    const mappings = await tx.$queryRawUnsafe<Array<{ value: string }>>(
      `SELECT external_id AS value FROM client_intel_mapping
      WHERE tenant_id=$1::uuid AND client_id=$2::uuid AND source='lda' AND confirmed=true`,
      ctx.tenantId,
      subject.id,
    );
    identifiers.push(
      ...mappings.map((row) => ({ type: 'lda_client_id' as const, value: row.value })),
    );
  }
  const unique = [
    ...new Map(
      identifiers
        .map((i) => ({ ...i, value: normalized(i.value) }))
        .filter(valid)
        .map((i) => [`${i.type}:${i.value}`, i]),
    ).values(),
  ];
  // Conflicting exact UEI/CAGE anchors are ambiguous; LDA may legitimately have multiple confirmed IDs.
  return unique.filter(
    (i) =>
      i.type === 'lda_client_id' || unique.filter((other) => other.type === i.type).length === 1,
  );
}

export function isAutomaticOfficialEvidence(evidence: unknown): boolean {
  return (
    Array.isArray(evidence) &&
    evidence.some(
      (value) =>
        !!value &&
        typeof value === 'object' &&
        (value as { metadata?: { acceptanceMode?: unknown } }).metadata?.acceptanceMode ===
          'exact_identifier',
    )
  );
}

function proofAllows(finding: OfficialFinding, proof: OfficialFactProof): boolean {
  if (
    !valid(proof.identity) ||
    !proof.sourceRecordId ||
    !Number.isFinite(Date.parse(proof.observedAt))
  )
    return false;
  let url: URL;
  try {
    url = new URL(proof.sourceUrl);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  const value =
    finding.proposedValue && typeof finding.proposedValue === 'object'
      ? (finding.proposedValue as Record<string, unknown>)
      : {};
  if (proof.kind === 'sam_registration')
    return (
      finding.kind === 'government_identity' &&
      finding.source === 'sam_gov' &&
      ['uei', 'cageCode', 'samStatus'].includes(finding.targetKey) &&
      ['uei', 'cage'].includes(proof.identity.type) &&
      ['sam.gov', 'api.sam.gov'].includes(url.hostname) &&
      /^[A-Z0-9]{12}$/.test(proof.sourceRecordId) &&
      (proof.identity.type !== 'uei' || proof.sourceRecordId === proof.identity.value) &&
      (finding.targetKey !== 'uei' || finding.proposedValue === proof.sourceRecordId) &&
      (finding.targetKey !== 'cageCode' ||
        (typeof finding.proposedValue === 'string' &&
          /^[A-Z0-9]{5}$/.test(finding.proposedValue))) &&
      (finding.targetKey !== 'samStatus' ||
        (typeof finding.proposedValue === 'string' &&
          finding.proposedValue.length > 0 &&
          finding.proposedValue.length <= 100))
    );
  if (proof.kind === 'lda_filings')
    return (
      finding.kind === 'lda_history' &&
      finding.source === 'lda' &&
      proof.identity.type === 'lda_client_id' &&
      finding.targetKey === `lda-history:${proof.identity.value}` &&
      proof.sourceRecordId === proof.identity.value &&
      value.externalId === proof.identity.value &&
      Array.isArray(value.filings) &&
      value.filings.length > 0 &&
      ['lda.senate.gov', 'lda.gov'].includes(url.hostname)
    );
  return (
    finding.kind === 'profile_field' &&
    finding.source === 'sam_gov' &&
    proof.identity.type === 'uei' &&
    finding.targetKey === `federal_footprint.${proof.kind}:${proof.sourceRecordId}` &&
    value.awardId === proof.sourceRecordId &&
    value.recipientUei === proof.identity.value &&
    url.hostname === 'www.usaspending.gov'
  );
}

async function officialConflictPolicy(
  tx: Prisma.TransactionClient,
  ctx: TenantContext,
  subject: ProfileSubject,
  finding: OfficialFinding,
  proof: OfficialFactProof,
) {
  const current = (await readProfileFacts(tx, ctx.tenantId, subject)).find(
    (f) => f.fieldKey === finding.targetKey && f.isCurrent,
  );
  let live = current?.value;
  if (subject.kind === 'client' && ['uei', 'cageCode', 'samStatus'].includes(finding.targetKey)) {
    const rows = await tx.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `SELECT uei,cage_code AS "cageCode",intake_data_jsonb->'registration'->'samStatus' AS "samStatus" FROM clients WHERE tenant_id=$1::uuid AND id=$2::uuid`,
      ctx.tenantId,
      subject.id,
    );
    live = rows[0]?.[finding.targetKey];
  }
  const sameAutomaticAuthority =
    current?.origin === 'official' &&
    isAutomaticOfficialEvidence(current.evidence) &&
    reviewHash(live ?? null) === reviewHash(current.value) &&
    current.evidence.some((e) => {
      const old = (e as { metadata?: { officialMatch?: OfficialFactProof } })?.metadata
        ?.officialMatch;
      return old?.kind === proof.kind && old.sourceRecordId === proof.sourceRecordId;
    });
  const conflict =
    !sameAutomaticAuthority &&
    live !== undefined &&
    live !== null &&
    live !== '' &&
    reviewHash(live) !== reviewHash(finding.proposedValue);
  return { conflict, reviewOnly: conflict && current?.origin !== 'person' };
}

/** Called only inside the existing fenced source transaction after subject UPDATE lock. */
export async function acceptOfficialProfileFact(
  scope: ReviewTransaction,
  ctx: TenantContext,
  subject: ProfileSubject,
  finding: OfficialFinding,
  proof: OfficialFactProof,
  project: Project,
): Promise<'accepted' | 'pending' | 'rejected'> {
  if (!proofAllows(finding, proof)) return 'pending';
  const identities = await readOfficialProfileIdentities(scope.tx, ctx, subject);
  if (!identities.some((i) => i.type === proof.identity.type && i.value === proof.identity.value))
    return 'pending';
  const rejected = await scope.tx.$queryRawUnsafe<Array<{ id: string }>>(
    `SELECT id FROM profile_fact
    WHERE tenant_id=$1::uuid AND ${subjectColumn(subject)}=$2::uuid AND field_key=$3 AND value_jsonb=$4::jsonb AND status='rejected'`,
    ctx.tenantId,
    subject.id,
    finding.targetKey,
    JSON.stringify(finding.proposedValue),
  );
  if (rejected.length) {
    await scope.tx.$executeRawUnsafe(
      `UPDATE client_profile_fill_finding SET status='rejected',rejection_reason='A previous rejection of this exact value is still active',updated_at=now() WHERE tenant_id=$1::uuid AND ${subjectColumn(subject)}=$2::uuid AND id=$3::uuid AND status IN ('pending','informational')`,
      ctx.tenantId,
      subject.id,
      finding.id,
    );
    return 'rejected';
  }
  const { conflict, reviewOnly } = await officialConflictPolicy(
    scope.tx,
    ctx,
    subject,
    finding,
    proof,
  );
  if (reviewOnly) return 'pending';
  const evidence = finding.evidence.map((e) => ({
    ...e,
    metadata: {
      ...e.metadata,
      officialMatch: proof,
      ...(conflict ? {} : { acceptanceMode: 'exact_identifier' }),
    },
  }));
  const result = await writeProfileFact(scope.tx, ctx, subject, {
    fieldKey: finding.targetKey,
    value: finding.proposedValue,
    origin: 'official',
    originId: `finding:${finding.id}`,
    findingId: finding.id,
    runId: finding.runId,
    sourceType: finding.source,
    sourceUrl: proof.sourceUrl,
    observedAt: new Date(proof.observedAt),
    evidence,
    approved: !conflict,
    approvedBy: null,
  });
  if (result.conflict || result.fact.status !== 'approved') return 'pending';
  if (result.fact.isCurrent)
    await project(scope, ctx, subject, finding.targetKey, finding.proposedValue);
  await scope.tx.$executeRawUnsafe(
    `UPDATE client_profile_fill_finding SET status='accepted',reviewed_by=NULL,reviewed_at=now(),applied_at=now(),evidence_jsonb=$4::jsonb,updated_at=now()
    WHERE tenant_id=$1::uuid AND ${subjectColumn(subject)}=$2::uuid AND id=$3::uuid AND status IN ('pending','informational')`,
    ctx.tenantId,
    subject.id,
    finding.id,
    JSON.stringify(evidence),
  );
  return 'accepted';
}

/** Automatic acceptance is reversible; a subsequent person edit is never undone. */
export async function rejectAutomaticOfficialFact(
  scope: ReviewTransaction,
  ctx: TenantContext,
  subject: ProfileSubject,
  findingId: string,
  reason: string | undefined,
  project: Project,
): Promise<boolean> {
  const rows = await scope.tx.$queryRawUnsafe<Array<ProfileFact & { supersedesId: string | null }>>(
    `SELECT ${FACT_SELECT},supersedes_id AS "supersedesId" FROM profile_fact
    WHERE tenant_id=$1::uuid AND ${subjectColumn(subject)}=$2::uuid AND finding_id=$3::uuid AND origin='official' AND status IN ('approved','superseded') FOR UPDATE`,
    ctx.tenantId,
    subject.id,
    findingId,
  );
  const fact = rows.find((f) => isAutomaticOfficialEvidence(f.evidence));
  if (!fact) return false;
  const prior = fact.supersedesId
    ? (
        await scope.tx.$queryRawUnsafe<ProfileFact[]>(
          `SELECT ${FACT_SELECT} FROM profile_fact WHERE tenant_id=$1::uuid AND ${subjectColumn(subject)}=$2::uuid AND id=$3::uuid FOR UPDATE`,
          ctx.tenantId,
          subject.id,
          fact.supersedesId,
        )
      )[0]
    : undefined;
  const previous = prior && ['approved', 'superseded'].includes(prior.status) ? prior : undefined;
  if (
    fact.isCurrent &&
    subject.kind === 'client' &&
    ['uei', 'cageCode', 'samStatus'].includes(fact.fieldKey)
  ) {
    const rows = await scope.tx.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `SELECT uei,cage_code AS "cageCode",intake_data_jsonb->'registration'->'samStatus' AS "samStatus" FROM clients WHERE tenant_id=$1::uuid AND id=$2::uuid`,
      ctx.tenantId,
      subject.id,
    );
    if (reviewHash(rows[0]?.[fact.fieldKey] ?? null) !== reviewHash(fact.value))
      throw new ConflictException(
        'The saved value changed. Refresh before rejecting this automatic fact.',
      );
  }
  await scope.tx.$executeRawUnsafe(
    `UPDATE profile_fact SET status='rejected',is_current=false,version=version+1 WHERE id=$1::uuid`,
    fact.id,
  );
  if (fact.isCurrent) {
    if (previous)
      await scope.tx.$executeRawUnsafe(
        `UPDATE profile_fact SET status='approved',is_current=true,version=version+1 WHERE id=$1::uuid`,
        previous.id,
      );
    await project(scope, ctx, subject, fact.fieldKey, previous?.value ?? null);
  }
  await scope.tx.$executeRawUnsafe(
    `UPDATE client_profile_fill_finding SET status='rejected',reviewed_by=$4::uuid,reviewed_at=now(),rejection_reason=$5,updated_at=now()
    WHERE tenant_id=$1::uuid AND ${subjectColumn(subject)}=$2::uuid AND id=$3::uuid AND status='accepted'`,
    ctx.tenantId,
    subject.id,
    findingId,
    ctx.userId,
    reason?.slice(0, 1000) ?? null,
  );
  return true;
}

/** Restore is an explicit return to human review, never another automatic acceptance. */
export async function restoreAutomaticOfficialFact(
  tx: Prisma.TransactionClient,
  ctx: TenantContext,
  subject: ProfileSubject,
  findingId: string,
): Promise<boolean> {
  const facts = await tx.$queryRawUnsafe<ProfileFact[]>(
    `SELECT ${FACT_SELECT} FROM profile_fact WHERE tenant_id=$1::uuid AND ${subjectColumn(subject)}=$2::uuid AND finding_id=$3::uuid AND origin='official' AND status='rejected' FOR UPDATE`,
    ctx.tenantId,
    subject.id,
    findingId,
  );
  const fact = facts.find((row) => isAutomaticOfficialEvidence(row.evidence));
  if (!fact) return false;
  const evidence = fact.evidence.map((value) => {
    if (!value || typeof value !== 'object') return value;
    const row = value as { metadata?: Record<string, unknown> };
    if (row.metadata?.acceptanceMode !== 'exact_identifier') return row;
    const { acceptanceMode, ...metadata } = row.metadata;
    return { ...row, metadata: { ...metadata, priorAcceptanceMode: acceptanceMode } };
  });
  await tx.$executeRawUnsafe(
    `UPDATE profile_fact SET evidence_jsonb=$2::jsonb,version=version+1 WHERE id=$1::uuid`,
    fact.id,
    JSON.stringify(evidence),
  );
  await tx.$executeRawUnsafe(
    `UPDATE client_profile_fill_finding SET status='pending',reviewed_by=NULL,reviewed_at=NULL,applied_at=NULL,rejection_reason=NULL,evidence_jsonb=$4::jsonb,updated_at=now() WHERE tenant_id=$1::uuid AND ${subjectColumn(subject)}=$2::uuid AND id=$3::uuid AND status='rejected'`,
    ctx.tenantId,
    subject.id,
    findingId,
    JSON.stringify(evidence),
  );
  return true;
}
