import type { Prisma } from '@prisma/client';
import {
  humanizeBillId,
  type ResearchPortfolioMemberKind,
  type ResearchPortfolioRuleCandidateDto,
} from '@capiro/shared';

type Tx = Prisma.TransactionClient;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * The complete set of typed member kinds. Every writer/validator reads this one
 * set so a new kind cannot be accepted by one path and silently dropped by another.
 */
export const RESEARCH_PORTFOLIO_MEMBER_KINDS: ReadonlySet<ResearchPortfolioMemberKind> = new Set([
  'program',
  'program_element',
  'project',
  'budget_line',
  'award',
  'federal_bill',
  'state_bill',
]);

function component(value: string | null | undefined, fallback: string | null | undefined = null): string | null {
  const normalized = (value || fallback || '').trim().toUpperCase().replaceAll('.', '');
  const aliases: Record<string, string> = { A: 'ARMY', USA: 'ARMY', N: 'NAVY', USN: 'NAVY', AF: 'AIR FORCE', USAF: 'AIR FORCE', SF: 'SPACE FORCE', USSF: 'SPACE FORCE', USMC: 'MARINE CORPS', MC: 'MARINE CORPS', DW: 'DEFENSE-WIDE', OSD: 'DEFENSE-WIDE' };
  return normalized ? aliases[normalized] ?? normalized : null;
}

export interface CanonicalResearchTarget {
  kind: ResearchPortfolioMemberKind;
  id: string;
  label: string;
  facts: Readonly<Record<string, unknown>>;
}

/** The canonical facts captured when a member was added; never fabricated. */
export function canonicalFacts(evidence: unknown): Readonly<Record<string, unknown>> | null {
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) return null;
  const facts = (evidence as Record<string, unknown>).facts;
  return facts && typeof facts === 'object' && !Array.isArray(facts)
    ? (facts as Record<string, unknown>)
    : null;
}

async function capabilities(tx: Tx, peCode: string): Promise<readonly string[]> {
  const matches = await tx.capabilityBudgetLineMatch.findMany({
    where: { peCode, status: 'accepted' },
    include: { capability: true },
    orderBy: { capabilityId: 'asc' },
  });
  return [...new Set(matches.flatMap((match) => [match.capability.name, match.capability.taxonomyPath, ...match.capability.aliases]))];
}

/** Resolve a typed member ID against the canonical, public-source owner. */
export async function readCanonicalResearchTarget(tx: Tx, kind: ResearchPortfolioMemberKind, id: string): Promise<CanonicalResearchTarget | null> {
  if (kind === 'program_element') {
    const row = await tx.programElement.findUnique({ where: { peCode: id } });
    if (!row) return null;
    return { kind, id: row.peCode, label: row.title, facts: { entityKind: kind, component: component(row.serviceCode, row.service), account: row.appropriationType, sourceFamily: row.source, publisher: 'Department of Defense', qualification: row.sourceConfidence != null && row.sourceConfidence < 0.8 ? 'candidate' : 'qualified', fiscalYear: row.firstSeenFy, capability: await capabilities(tx, row.peCode), field: row.raw } };
  }
  if (kind === 'federal_bill') {
    // Federal identity is congress + bill type + number, which is exactly
    // congress_bill.id. A number alone ("H.R. 8800") is not an identity.
    const row = await tx.congressBill.findUnique({ where: { id: id.toLowerCase() } });
    if (!row) return null;
    const identifier = humanizeBillId(row.id);
    return {
      kind,
      id: row.id,
      label: identifier + ' — ' + row.title,
      facts: {
        entityKind: kind,
        jurisdiction: 'US',
        congress: row.congress,
        billType: row.billType,
        billNumber: row.billNumber,
        identifier,
        title: row.title,
        session: String(row.congress),
        status: row.status,
        statusAt: row.statusAt?.toISOString() ?? null,
        latestActionText: row.latestActionText,
        latestActionDate: row.latestActionDate?.toISOString().slice(0, 10) ?? null,
        originChamber: row.originChamber,
        policyArea: row.policyArea,
        subjects: row.subjects,
        sponsor: row.sponsorName,
        sourceFamily: 'congress.gov',
        publisher: 'Congress.gov',
        sourceUrl: row.url,
        sourceRevision: (row.updateDateIncludingText ?? row.lastSyncedAt)?.toISOString() ?? null,
        fundingBasis: 'not_applicable',
        qualification: 'qualified',
      },
    };
  }
  if (kind === 'state_bill') {
    // State identity is jurisdiction + legislative session + type/number, which is
    // state_bill.id. The same number in another state or session is a different bill.
    const row = await tx.stateBill.findUnique({ where: { id } });
    if (!row) return null;
    return {
      kind,
      id: row.id,
      label: row.identifier + ' — ' + row.title,
      facts: {
        entityKind: kind,
        jurisdiction: row.state,
        session: row.session,
        sessionKey: row.sessionKey,
        billNumber: row.billNumber,
        identifier: row.identifier,
        title: row.title,
        chamber: row.chamber,
        status: row.status,
        statusAt: row.statusAt?.toISOString() ?? null,
        latestActionText: row.latestActionText,
        latestActionDate: row.latestActionDate?.toISOString().slice(0, 10) ?? null,
        subjects: row.subjects,
        sponsor: row.sponsorName,
        sourceFamily: 'legiscan',
        publisher: row.state,
        sourceUrl: row.stateUrl ?? row.url,
        sourceRevision: (row.statusDerivedAt ?? row.syncedAt)?.toISOString() ?? null,
        fundingBasis: 'not_applicable',
        qualification: 'qualified',
      },
    };
  }
  if (!UUID.test(id)) return null;
  if (kind === 'program') {
    const row = await tx.program.findUnique({ where: { id } });
    return row ? { kind, id: row.id, label: row.canonicalName, facts: { entityKind: kind, component: component(row.component), capability: row.capabilityArea, qualification: row.status === 'active' ? 'qualified' : row.status, field: row.metadata } } : null;
  }
  if (kind === 'project') {
    const row = await tx.programElementProject.findUnique({ where: { id }, include: { programElement: true } });
    return row ? { kind, id: row.id, label: row.title, facts: { entityKind: kind, component: component(row.programElement.serviceCode, row.programElement.service), account: row.programElement.appropriationType, sourceFamily: row.source, publisher: 'Department of Defense', qualification: row.confidence < 0.8 ? 'candidate' : 'qualified', fiscalYear: row.fy, capability: await capabilities(tx, row.peCode), field: row.metadata } } : null;
  }
  if (kind === 'budget_line') {
    const row = await tx.procurementLine.findUnique({ where: { id } });
    const capability = row?.relatedPeCode ? await capabilities(tx, row.relatedPeCode) : [];
    return row ? { kind, id: row.id, label: row.title, facts: { entityKind: kind, component: component(row.component), account: row.appropriationCode, sourceFamily: 'procurement_jbook', publisher: 'Department of Defense', qualification: 'qualified', capability, field: row.raw } } : null;
  }
  const row = await tx.federalAward.findUnique({ where: { id } });
  return row ? { kind, id: row.id, label: row.contractorName ?? row.piid ?? row.awardUniqueId, facts: { entityKind: kind, component: component(row.awardingSubTier, row.awardingAgency), account: row.fundingTas, sourceFamily: 'usaspending', publisher: row.awardingAgency, qualification: row.peCode ? 'qualified' : 'unresolved', fiscalYear: row.fundingFy, field: { awardUniqueId: row.awardUniqueId, piid: row.piid, description: row.description } } } : null;
}

/** Canonical fields override client-provided facts; missing identities remain explicit unknowns. */
export async function materializeRuleCandidate(tx: Tx, candidate: ResearchPortfolioRuleCandidateDto): Promise<ResearchPortfolioRuleCandidateDto> {
  const target = await readCanonicalResearchTarget(tx, candidate.targetKind, candidate.targetId);
  if (!target) return { ...candidate, facts: { entityKind: candidate.targetKind }, completeness: 'unresolved', unknownReasons: [...(candidate.unknownReasons ?? []), 'canonical_target_not_found'] };
  return {
    ...candidate,
    targetId: target.id,
    label: target.label,
    facts: { ...candidate.facts, ...target.facts },
  };
}
