import type { Client, ClientCapability } from '@prisma/client';
import type { Logger } from '@nestjs/common';
import type { TrackedBillsResult } from './intelligence-bill-discovery.shared.js';
import type { IntelligenceBillEnrichment } from './intelligence-bill-enrichment.js';
import type { buildProfileV1RegulatoryLifecycle } from './client-profile-v1-regulatory.js';

export type AlertRow = {
  id: string;
  type: string;
  severity: string;
  title: string;
  subtitle: string;
  when: string;
  countdownDays: number | null;
  countdownLabel: string | null;
  href: string | null;
  _urgencyScore: number;
  _typeRank: number;
};
export type CommentPeriodAlert = {
  documentId: string;
  title: string;
  type: string;
  commentEndDate: Date;
  daysToDeadline: number;
  severity: string;
  agencies: string[];
  clientId: string;
  clientName: string;
  relevanceScore: number;
};
export type CommentPeriodChange = {
  dedupeKey: string;
  source: string;
  changeType: string;
  severity: string;
  title: string;
  description: string;
  relatedClientIds: string[];
  relatedIssues: string[];
  data: object;
};
export type RelevantClientRegulation = {
  documentNumber: string;
  type: string;
  title: string;
  agencyNames: string[];
  publicationDate: Date;
  commentEndDate: Date | null;
  effectiveDate: Date | null;
  htmlUrl: string | null;
};
export type AlertCapability = Pick<ClientCapability, 'sector' | 'tags' | 'name'>;
export type AlertClient = Pick<Client, 'id' | 'name' | 'sectorTag'> & {
  capabilities: AlertCapability[];
};
export type BillRegulationLinks = Awaited<
  ReturnType<IntelligenceBillEnrichment['getBillRegulationLinks']>
>;
export type RegulatoryLifecycle = ReturnType<typeof buildProfileV1RegulatoryLifecycle>;
export type AlertLoggerPorts = { logger(): Pick<Logger, 'warn'> };
export type ClientRegulatoryPorts = AlertLoggerPorts & {
  withSourceBudget<T>(label: string, clientId: string, work: Promise<T>): Promise<T>;
  getBillRegulationLinks(clientId: string, tenantId: string): Promise<BillRegulationLinks>;
  getClientRelevantRegulations(
    clientId: string,
    tenantId: string,
    now: Date,
  ): Promise<RelevantClientRegulation[]>;
  buildRegulatoryLifecycle(
    links: BillRegulationLinks,
    relevant: RelevantClientRegulation[],
    now: Date,
  ): RegulatoryLifecycle;
};
export type ClientAlertsPorts = AlertLoggerPorts & {
  getTrackedBills(clientId: string, tenantId?: string): Promise<TrackedBillsResult>;
  alertCountdownLabel(days: number | null): string | null;
  getClientIssueCodes(clientId: string, tenantId: string): Promise<string[]>;
  confirmedLdaIds(clientId: string, tenantId: string): Promise<number[]>;
  issueCodesForLdaIds(ids: number[]): Promise<string[]>;
};
export type ClientAwardAlertPorts = AlertLoggerPorts & {
  resolveContractorUeisForAlerts(ids: string[]): Promise<Map<string, string | null>>;
};

/** Exact shared capability-word collection; callers retain their distinct match/sector rules. */
export function addCapabilityKeywords(
  capKeywords: Set<string>,
  capabilities: AlertCapability[],
): void {
  for (const cap of capabilities) {
    if (cap.sector) capKeywords.add(cap.sector.toLowerCase());
    if (cap.name)
      cap.name
        .split(/\s+/)
        .filter((w) => w.length > 3)
        .forEach((w) => capKeywords.add(w.toLowerCase()));
    const tags = Array.isArray(cap.tags) ? (cap.tags as unknown[]) : [];
    for (const t of tags) {
      if (typeof t === 'string' && t.length > 3) capKeywords.add(t.toLowerCase());
    }
  }
}
