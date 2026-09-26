import type { Prisma } from '@prisma/client';
import type { ResearchPortfolioMemberKind, ResearchPortfolioRuleCandidateDto } from '@capiro/shared';

type Tx = Prisma.TransactionClient;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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
