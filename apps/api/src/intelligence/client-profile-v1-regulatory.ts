import { deriveRuleLifecycleStage, RULE_LIFECYCLE_STAGES } from '@capiro/shared';
import type { IntelligenceService } from './intelligence.service.js';
type RegulatoryLinks = Awaited<ReturnType<IntelligenceService['getBillRegulationLinks']>>;
type RelevantRegulations = Awaited<ReturnType<IntelligenceService['getClientRelevantRegulations']>>;
type RegulatoryDocument = {
  documentNumber: string;
  type: string;
  title: string;
  agencyNames: string[];
  publicationDate: Date;
  commentEndDate: Date | null;
  effectiveDate: Date | null;
  linkedBills: string[];
  htmlUrl: string | null;
};

export function buildProfileV1RegulatoryLifecycle(
  regLinks: RegulatoryLinks,
  clientRelevantRegs: RelevantRegulations,
  now: Date,
) {
  const regDocByNumber = new Map<string, RegulatoryDocument>();
  addBillLinkedRegulations(regDocByNumber, regLinks);
  addClientRelevantRegulations(regDocByNumber, clientRelevantRegs);
  const rails = Array.from(regDocByNumber.values())
    .sort((a, b) => b.publicationDate.getTime() - a.publicationDate.getTime())
    .slice(0, 8)
    .map((reg) => {
      const currentStage = deriveRuleLifecycleStage({
        documentType: reg.type,
        commentEndDate: reg.commentEndDate,
        effectiveDate: reg.effectiveDate,
        today: now,
      });
      return {
        documentNumber: reg.documentNumber,
        title: reg.title,
        agencyNames: reg.agencyNames,
        linkedBills: reg.linkedBills,
        currentStage,
        // For an open NPRM the actionable deadline is the comment close date.
        // Once the rule is final/effective there is no open comment deadline.
        deadline: currentStage === 'nprm' ? reg.commentEndDate : null,
        stages: RULE_LIFECYCLE_STAGES.map((s) => ({ key: s.key, label: s.label })),
        // The real Federal Register document link. Was fetched by
        // getBillRegulationLinks and getClientRelevantRegulations alike but
        // dropped here, so "Open matter →" on the frontend had nowhere to
        // point even for a document with a real, known URL.
        htmlUrl: reg.htmlUrl,
      };
    });
  return { totalLinkedBills: regLinks.totalBills, totalRegulations: regDocByNumber.size, rails };
}

function addBillLinkedRegulations(
  regDocByNumber: Map<string, RegulatoryDocument>,
  regLinks: RegulatoryLinks,
) {
  for (const link of regLinks.links ?? []) {
    for (const reg of link.regulations) {
      const existing = regDocByNumber.get(reg.documentNumber);
      if (existing) {
        if (!existing.linkedBills.includes(link.bill.identifier)) {
          existing.linkedBills.push(link.bill.identifier);
        }
        continue;
      }
      regDocByNumber.set(reg.documentNumber, {
        documentNumber: reg.documentNumber,
        type: (reg as { type?: string }).type ?? '',
        title: reg.title,
        agencyNames: reg.agencyNames,
        publicationDate: new Date(reg.publicationDate),
        commentEndDate: reg.commentEndDate ? new Date(reg.commentEndDate) : null,
        effectiveDate: (reg as { effectiveDate?: Date | string | null }).effectiveDate
          ? new Date((reg as { effectiveDate: Date | string }).effectiveDate)
          : null,
        linkedBills: [link.bill.identifier],
        htmlUrl: (reg as { htmlUrl?: string | null }).htmlUrl ?? null,
      });
    }
  }
}

function addClientRelevantRegulations(
  regDocByNumber: Map<string, RegulatoryDocument>,
  clientRelevantRegs: RelevantRegulations,
) {
  for (const reg of clientRelevantRegs) {
    if (regDocByNumber.has(reg.documentNumber)) continue;
    regDocByNumber.set(reg.documentNumber, {
      documentNumber: reg.documentNumber,
      type: reg.type,
      title: reg.title,
      agencyNames: reg.agencyNames,
      publicationDate: new Date(reg.publicationDate),
      commentEndDate: reg.commentEndDate ? new Date(reg.commentEndDate) : null,
      effectiveDate: reg.effectiveDate ? new Date(reg.effectiveDate) : null,
      linkedBills: [],
      htmlUrl: (reg as { htmlUrl?: string | null }).htmlUrl ?? null,
    });
  }
}
