import { NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { LegiWatchCitation, LegiWatchClientFact, TenantContext } from '@capiro/shared';
import { FACT_SELECT, type ProfileFact } from '../clients/profile-facts.js';
import { assertSharedProfileEvidence } from '../clients/profile-shared-evidence.js';
import { stableJson } from '../clients/client-profile-fill.helpers.js';
import { reviewHash as hash } from '../clients/client-profile-fill-review-snapshot.js';

const MAX_RECORDS = 500;
type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as RecordValue) : {};
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '');
const order = <T extends { id: string }>(rows: T[]) =>
  [...rows].sort((a, b) => a.id.localeCompare(b.id));
function publicUrl(value: unknown): string | null {
  try {
    const url = new URL(text(value));
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}
function select(value: RecordValue, keys: readonly string[]): RecordValue {
  return Object.fromEntries(
    keys
      .filter(
        (key) =>
          value[key] !== undefined &&
          value[key] !== null &&
          value[key] !== '' &&
          (!Array.isArray(value[key]) || value[key].length > 0),
      )
      .map((key) => [key, value[key]]),
  );
}
const PROFILE_FIELDS = [
  'description',
  'productDescription',
  'sectorTag',
  'naicsCodes',
  'pscCodes',
  'applicantTypes',
  'setAsideCertifications',
];
const FACILITY_FIELDS = [
  'name',
  'addressLine',
  'city',
  'state',
  'zip',
  'country',
  'siteRole',
  'siteStatus',
  'siteVerificationStatus',
  'employeeCount',
  'congressionalDistrict',
  'congressionalDistrictCongress',
];
const CAPABILITY_FIELDS = [
  'name',
  'type',
  'description',
  'lifecycle',
  'peNumber',
  'peNumbers',
  'existingContracts',
  'trl',
  'mrl',
];
const CASE_FIELDS = new Set([
  'suppliers',
  'jobs',
  'payroll',
  'investment',
  'facility_size',
  'readiness',
  'cost',
  'timing',
  'impact',
  'government_need',
]);
type ClientRow = RecordValue & { id: string; name: string };

export async function loadImpactClientEvidence(
  tx: Prisma.TransactionClient,
  ctx: TenantContext,
  clientId: string,
  notes: Set<string>,
): Promise<LegiWatchClientFact[]> {
  return (await readImpactClientEvidence(tx, ctx, clientId, notes)).facts;
}

/** Retained Bill360 uses the same field ownership and source visibility as the tracker. */
export async function loadImpactProfileContext(
  tx: Prisma.TransactionClient,
  ctx: TenantContext,
  clientId: string,
) {
  const result = await readImpactClientEvidence(tx, ctx, clientId, new Set());
  return { ...result.profileContext, evidenceRevision: hash(result.profileRevisions) };
}

/** The canonical accepted profile and its currently shared supporting sources. */
async function readImpactClientEvidence(
  tx: Prisma.TransactionClient,
  ctx: TenantContext,
  clientId: string,
  notes: Set<string>,
) {
  const client = (await tx.client.findFirst({
    where: { tenantId: ctx.tenantId, id: clientId, status: { not: 'archived' } },
    select: {
      id: true,
      name: true,
      description: true,
      productDescription: true,
      sectorTag: true,
      naicsCodes: true,
      pscCodes: true,
      applicantTypes: true,
      setAsideCertifications: true,
    },
  })) as ClientRow | null;
  if (!client) throw new NotFoundException('Client not found');
  const [facts, facilities, capabilities, cases, terms, links] = await Promise.all([
    tx.$queryRawUnsafe<ProfileFact[]>(
      `SELECT ${FACT_SELECT} FROM profile_fact WHERE tenant_id=$1::uuid AND client_id=$2::uuid AND is_current AND status='approved' ORDER BY id LIMIT ${MAX_RECORDS + 1}`,
      ctx.tenantId,
      clientId,
    ),
    tx.clientFacility.findMany({
      where: { tenantId: ctx.tenantId, clientId },
      orderBy: { id: 'asc' },
      take: MAX_RECORDS + 1,
    }),
    tx.clientCapability.findMany({
      where: { tenantId: ctx.tenantId, clientId },
      include: {
        documents: {
          where: { tenantId: ctx.tenantId, clientId },
          select: { attachmentId: true },
        },
      },
      orderBy: { id: 'asc' },
      take: MAX_RECORDS + 1,
    }),
    tx.clientPortfolioProposal.findMany({
      where: { tenantId: ctx.tenantId, clientId, kind: 'case_field', status: 'approved' },
      orderBy: { id: 'asc' },
      take: MAX_RECORDS + 1,
    }),
    tx.clientCapabilityTerm.findMany({
      where: { tenantId: ctx.tenantId, clientId, kind: { in: ['pe', 'program'] } },
      orderBy: { id: 'asc' },
      take: MAX_RECORDS + 1,
    }),
    tx.clientFacilityCapability.findMany({
      where: { tenantId: ctx.tenantId, clientId },
      orderBy: { id: 'asc' },
      take: MAX_RECORDS + 1,
    }),
  ]);
  const result: LegiWatchClientFact[] = [];
  const profileContext: { description: string | null; productDescription: string | null } = {
    description: null,
    productDescription: null,
  };
  const profileRevisions: Record<string, string> = {};
  const subject = { kind: 'client' as const, id: client.id };
  const visible = async (evidence: unknown[]) => {
    try {
      await assertSharedProfileEvidence(tx, ctx.tenantId, subject, evidence, ctx);
      return true;
    } catch (error) {
      if (!(error instanceof NotFoundException)) throw error;
      notes.add(
        'Some client facts were withheld because their original source is no longer shared.',
      );
      return false;
    }
  };
  const add = (
    id: string,
    kind: LegiWatchClientFact['kind'],
    label: string,
    value: unknown,
    evidence: unknown[],
    identity: unknown,
  ) => {
    const rendered = typeof value === 'string' ? value.trim() : stableJson(value);
    if (!rendered || rendered === '{}' || rendered === '[]') return;
    if (rendered.length > 20_000) {
      notes.add('A client fact exceeds the evidence limit and was omitted in full.');
      return;
    }
    const revision = hash({ value, evidence, identity });
    const citations: LegiWatchCitation[] = [
      { sourceId: id, sourceUrl: null, label, quote: rendered, locator: id, revision },
    ];
    for (const [index, raw] of evidence.entries()) {
      const entry = record(raw),
        metadata = record(entry.metadata);
      const quote = text(entry.excerpt) || text(entry.evidence) || text(entry.quote);
      if (!quote || quote.length > 20_000) continue;
      citations.push({
        sourceId:
          text(entry.attachmentId) || text(metadata.attachmentId) || `${id}:source:${index}`,
        sourceUrl: publicUrl(entry.url ?? entry.sourceUrl),
        label: text(entry.title) || text(entry.label) || 'Accepted fact source',
        quote,
        locator: text(entry.locator) || `evidence:${index}`,
        revision: hash(entry),
      });
    }
    const fact = { id, kind, label, value: rendered, revision, citations };
    result.push(fact);
    return fact;
  };
  const profileField = (field: string, value: unknown, fact: LegiWatchClientFact | undefined) => {
    if (
      fact &&
      (field === 'description' || field === 'productDescription') &&
      typeof value === 'string'
    ) {
      profileContext[field] = value;
      profileRevisions[field] = fact.revision;
    }
  };
  const bounded = <T>(rows: T[], name: string) => {
    if (rows.length > MAX_RECORDS) {
      notes.add(`The ${name} list exceeds the evidence limit and was omitted in full.`);
      return [];
    }
    return rows;
  };
  const fieldOwners = new Set(facts.map((f) => f.fieldKey));
  const withheldLocations = new Set<string>(),
    withheldCapabilities = new Set<string>();
  for (const fact of bounded(facts, 'approved profile facts')) {
    if (!fact.isCurrent || fact.status !== 'approved') continue;
    const value = record(fact.value);
    const evidence = [
      ...list(fact.evidence),
      ...(fact.attachmentId ? [{ attachmentId: fact.attachmentId }] : []),
      ...list(value.sourceEvidence),
      ...list(value.provenance),
    ];
    if (!(await visible(evidence))) {
      if (fact.fieldKey.startsWith('locations.')) withheldLocations.add(text(value.name));
      if (fact.fieldKey.startsWith('capabilities.')) withheldCapabilities.add(text(value.name));
      continue;
    }
    if (PROFILE_FIELDS.includes(fact.fieldKey))
      profileField(
        fact.fieldKey,
        fact.value,
        add(
          `profile:${fact.id}`,
          fact.fieldKey === 'productDescription' ? 'product' : 'profile',
          `${fact.fieldKey} (${fact.origin === 'person' ? 'client-reported' : 'approved profile'})`,
          fact.value,
          evidence,
          [fact.version, fact.sourceUrl, fact.observedAt],
        ),
      );
    // Locations and capabilities are read from their current canonical projections below.
    if (fact.fieldKey.startsWith('federal_footprint.'))
      add(
        `profile:${fact.id}`,
        'program',
        'Approved federal program or award record',
        select(value, [
          'title',
          'name',
          'description',
          'agency',
          'awardId',
          'program',
          'amount',
          'date',
          'status',
        ]),
        evidence,
        fact.version,
      );
  }
  if (facts.length <= MAX_RECORDS)
    for (const key of PROFILE_FIELDS)
      if (!fieldOwners.has(key) && client[key] != null) {
        profileField(
          key,
          client[key],
          add(
            `client:${client.id}:${key}`,
            key === 'productDescription' ? 'product' : 'profile',
            `${key} (client-reported; no retained source evidence)`,
            client[key],
            [],
            [key, client[key]],
          ),
        );
      }
  const allowedFacilities = new Set<string>();
  for (const facility of bounded(facilities, 'client facilities')) {
    if (facts.length > MAX_RECORDS || withheldLocations.has(text(facility.name))) continue;
    const evidence = list(facility.sourceEvidence);
    if (!(await visible(evidence))) continue;
    allowedFacilities.add(facility.id);
    add(
      `facility:${facility.id}`,
      'location',
      `Client location: ${text(facility.name)} (${text(facility.siteVerificationStatus) || 'unverified'})`,
      select(facility, FACILITY_FIELDS),
      evidence,
      facility.sourceObservedAt,
    );
    const economic = record(facility.economicImpact),
      economicEvidence = list(economic.evidence);
    if (economicEvidence.length && (await visible(economicEvidence)))
      add(
        `facility:${facility.id}:economic`,
        'threshold',
        'Accepted facility economic context; applicability requires review',
        select(economic, [
          'jobs',
          'employeeCount',
          'payroll',
          'investment',
          'amount',
          'unit',
          'year',
          'period',
          'description',
          'claim',
        ]),
        economicEvidence,
        economic.observedAt,
      );
  }
  const allowedCapabilities = new Set<string>();
  for (const capability of bounded(capabilities, 'client capabilities')) {
    if (facts.length > MAX_RECORDS || withheldCapabilities.has(text(capability.name))) continue;
    if (!['approved', 'legacy'].includes(capability.reviewStatus)) continue;
    const evidence = [
      ...list(capability.provenance),
      ...(capability.documents ?? []).map((document) => ({
        attachmentId: document.attachmentId,
      })),
    ];
    if (!(await visible(evidence))) continue;
    allowedCapabilities.add(capability.id);
    add(
      `capability:${capability.id}`,
      capability.type === 'program' ? 'program' : 'product',
      `Client capability: ${text(capability.name)} (${capability.reviewStatus === 'legacy' ? 'legacy client-reported' : 'approved'})`,
      select(capability, CAPABILITY_FIELDS),
      evidence,
      capability.version,
    );
  }
  for (const entry of bounded(cases, 'approved client case facts')) {
    const payload = record(entry.payload),
      evidence = list(entry.evidence),
      field = text(payload.field);
    if (
      !CASE_FIELDS.has(field) ||
      !evidence.length ||
      (entry.capabilityId && !allowedCapabilities.has(entry.capabilityId)) ||
      (payload.facilityId && !allowedFacilities.has(text(payload.facilityId))) ||
      !(await visible(evidence))
    )
      continue;
    add(
      `case:${entry.id}`,
      field === 'suppliers'
        ? 'supplier'
        : ['jobs', 'payroll', 'investment', 'facility_size', 'cost'].includes(field)
          ? 'threshold'
          : 'profile',
      `Approved client case: ${field}`,
      select(payload, [
        'field',
        'text',
        'value',
        'unit',
        'facilityId',
        'memberId',
        'sourceDirectory',
        'officeTerm',
      ]),
      evidence,
      entry.version,
    );
  }
  for (const term of bounded(terms, 'approved program alignments')) {
    const evidence = list(term.evidence);
    if (
      !allowedCapabilities.has(term.capabilityId) ||
      !evidence.length ||
      !(await visible(evidence))
    )
      continue;
    add(
      `alignment:${term.id}`,
      'program',
      'Approved capability alignment; not proof of a contract or program participation',
      { capabilityId: term.capabilityId, kind: term.kind, value: term.value },
      evidence,
      term.approvedAt,
    );
  }
  for (const link of bounded(links, 'facility capability links')) {
    if (!allowedCapabilities.has(link.capabilityId) || !allowedFacilities.has(link.facilityId))
      continue;
    add(
      `facility-capability:${link.id}`,
      'location',
      'Client-reported capability and facility relationship',
      { capabilityId: link.capabilityId, facilityId: link.facilityId },
      [],
      link.createdAt,
    );
  }
  if (result.some((f) => f.citations.length === 1))
    notes.add(
      'Some accepted client values are self-reported without retained independent source evidence; they do not establish eligibility or applicability.',
    );
  for (const [kind, label] of [
    ['location', 'locations'],
    ['product', 'products or capabilities'],
    ['program', 'program relationships'],
    ['supplier', 'supplier relationships'],
    ['threshold', 'eligibility thresholds'],
  ] as const)
    if (!result.some((f) => f.kind === kind))
      notes.add(`No current authorized client evidence establishes ${label}.`);
  return { facts: order(result), profileContext, profileRevisions };
}
