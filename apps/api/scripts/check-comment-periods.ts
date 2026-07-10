/**
 * Check for Federal Register comment periods closing within 14 days and emit
 * IntelligenceChange alerts for relevant tenant clients.
 *   npx tsx scripts/check-comment-periods.ts
 */
import { config as dotenvConfig } from 'dotenv';
import { PrismaClient } from '@prisma/client';
import { AGENCY_SECTOR_MAP, ldaCodesForSectors, type SectorTag } from '@capiro/shared';
import { commentDeadlineDedupeKey } from '../src/intelligence/comment-deadline.util.js';
dotenvConfig();

const prisma = new PrismaClient();

interface FrDoc {
  id: string;
  title: string;
  type: string;
  comment_end_date: Date;
  agency_names: string[];
  topics: string[];
}

interface StateRuleDoc {
  id: string;
  title: string;
  rule_type: string;
  comment_end_date: Date;
  agency: string;
  state: string;
}

interface ClientWithCaps {
  id: string;
  name: string;
  sector_tag: string | null;
  capabilities: Array<{ sector: string | null; tags: unknown; name: string }>;
}

async function main() {
  const now = new Date();
  const fourteenDaysOut = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);
  const startedAt = now;
  console.log(`[check-comment-periods] starting at ${startedAt.toISOString()}`);

  // Get all upcoming docs with comment deadlines
  const docs = await prisma.$queryRaw<FrDoc[]>`
    SELECT id, title, type, comment_end_date, agency_names, topics
    FROM federal_register_document
    WHERE type IN ('PROPOSED_RULE', 'RULE')
      AND comment_end_date > ${now}
      AND comment_end_date <= ${fourteenDaysOut}
    ORDER BY comment_end_date ASC
  `;
  // State Legislation Platform (Phase 1 M3.4) — the SAME comment-deadline
  // countdown, for state agency rules. state_rule carries no `topics` array
  // (unlike federal_register_document), so relevance below falls back to
  // matching capability keywords against the rule's own title/abstract text
  // — weaker than the federal topics match until AGENCY_SECTOR_MAP gains
  // real state agency names (added iteratively as sync-state-register
  // ingests them, matching the committee-crosswalk alias-map precedent).
  const stateDocs = await prisma.$queryRaw<StateRuleDoc[]>`
    SELECT id, title, rule_type, comment_end_date, agency, state
    FROM state_rule
    WHERE comment_end_date > ${now}
      AND comment_end_date <= ${fourteenDaysOut}
    ORDER BY comment_end_date ASC
  `;
  console.log(
    `[check-comment-periods] ${docs.length} federal + ${stateDocs.length} state documents with upcoming deadlines`,
  );

  if (!docs.length && !stateDocs.length) {
    console.log('[check-comment-periods] nothing to do');
    return;
  }

  // Get all active tenants
  const tenants = await prisma.$queryRaw<Array<{ id: string; slug: string }>>`
    SELECT id, slug FROM tenants WHERE status = 'active'
  `;

  let emitted = 0;
  let errors = 0;

  for (const tenant of tenants) {
    // Get active clients with capabilities
    const clients = await prisma.$queryRaw<
      Array<{ id: string; name: string; sector_tag: string | null }>
    >`
      SELECT id, name, sector_tag FROM clients
      WHERE tenant_id = ${tenant.id}::uuid AND profile_status = 'ACTIVE'
    `;

    const capRows = await prisma.$queryRaw<
      Array<{ client_id: string; sector: string | null; tags: unknown; name: string }>
    >`
      SELECT client_id, sector, tags_jsonb AS tags, name FROM client_capabilities
      WHERE tenant_id = ${tenant.id}::uuid
        AND client_id = ANY(${clients.map((c) => c.id)}::uuid[])
    `;

    // Group capabilities by clientId
    const capsByClient = new Map<
      string,
      Array<{ sector: string | null; tags: unknown; name: string }>
    >();
    for (const cap of capRows) {
      if (!capsByClient.has(cap.client_id)) capsByClient.set(cap.client_id, []);
      capsByClient.get(cap.client_id)!.push({ sector: cap.sector, tags: cap.tags, name: cap.name });
    }

    const clientsWithCaps: ClientWithCaps[] = clients.map((c) => ({
      ...c,
      capabilities: capsByClient.get(c.id) ?? [],
    }));

    for (const doc of docs) {
      const daysToDeadline = Math.ceil(
        (new Date(doc.comment_end_date).getTime() - now.getTime()) / (1000 * 60 * 60 * 24),
      );
      const urgencyMultiplier = daysToDeadline < 3 ? 2.0 : daysToDeadline <= 7 ? 1.5 : 1.0;
      const severity = daysToDeadline < 3 ? 'critical' : daysToDeadline <= 7 ? 'notable' : 'info';
      const agencies = doc.agency_names as string[];

      // Map agencies to sectors
      const docSectors = new Set<SectorTag>();
      for (const agency of agencies) {
        for (const sector of AGENCY_SECTOR_MAP[agency] ?? []) {
          docSectors.add(sector);
        }
      }
      const docLdaCodes = ldaCodesForSectors([...docSectors]);

      for (const client of clientsWithCaps) {
        let baseRelevance = 0;
        const matchedSectors = new Set<SectorTag>();

        if (client.sector_tag && docSectors.has(client.sector_tag as SectorTag)) {
          baseRelevance = Math.max(baseRelevance, 0.5);
          matchedSectors.add(client.sector_tag as SectorTag);
        }

        for (const cap of client.capabilities) {
          if (cap.sector && docSectors.has(cap.sector as SectorTag)) {
            baseRelevance = Math.max(baseRelevance, 0.5);
            matchedSectors.add(cap.sector as SectorTag);
          }
        }

        if (baseRelevance < 0.7) {
          const capKeywords = new Set<string>();
          for (const cap of client.capabilities) {
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

          for (const topic of doc.topics as string[]) {
            const topicLower = topic.toLowerCase();
            for (const kw of capKeywords) {
              if (topicLower.includes(kw) || kw.includes(topicLower)) {
                baseRelevance = Math.max(baseRelevance, 0.7);
                break;
              }
            }
          }
        }

        const finalScore = baseRelevance * urgencyMultiplier;
        if (finalScore <= 0.3) continue;

        try {
          const matchedLdaCodes = matchedSectors.size
            ? ldaCodesForSectors([...matchedSectors])
            : docLdaCodes;
          const dedupeKey = commentDeadlineDedupeKey('federal_register', doc.id, client.id);
          const data = {
            source: 'federal_register',
            changeType: 'comment_deadline_approaching',
            severity,
            title: `Comment period closing in ${daysToDeadline}d: ${String(doc.title).slice(0, 80)}`,
            description: `${doc.type} from ${agencies.slice(0, 2).join('/')} has a comment deadline in ${daysToDeadline} days. Relevant to ${client.name} (relevance: ${Math.round(finalScore * 100)}%).`,
            relatedClientIds: [client.id],
            relatedIssues: matchedLdaCodes,
            data: {
              documentId: doc.id,
              daysToDeadline,
              relevanceScore: finalScore,
              tenantId: tenant.id,
            },
            dedupeKey,
          };
          // Idempotent: the SAME (federal_register, document, client) pair
          // never produces a second row across re-runs or the on-demand
          // dashboard read in intelligence.service.ts (M3.4 — the pre-M3
          // gap this closes; both callers use the SAME dedupeKey format).
          await prisma.intelligenceChange.upsert({
            where: { dedupeKey },
            create: data,
            update: data,
          });
          emitted++;
        } catch (err) {
          errors++;
          console.error(
            `[check-comment-periods] failed to emit for ${client.name}/${doc.id}:`,
            err,
          );
        }
      }
    }

    for (const doc of stateDocs) {
      const daysToDeadline = Math.ceil(
        (new Date(doc.comment_end_date).getTime() - now.getTime()) / (1000 * 60 * 60 * 24),
      );
      const urgencyMultiplier = daysToDeadline < 3 ? 2.0 : daysToDeadline <= 7 ? 1.5 : 1.0;
      const severity = daysToDeadline < 3 ? 'critical' : daysToDeadline <= 7 ? 'notable' : 'info';

      // No AGENCY_SECTOR_MAP entries exist yet for state agency names (see
      // the header comment) — docSectors stays empty, so every client falls
      // through to the title-keyword match below rather than a fabricated
      // sector guess.
      const docSectors = new Set<SectorTag>();
      const docLdaCodes = ldaCodesForSectors([...docSectors]);
      const titleLower = doc.title.toLowerCase();

      for (const client of clientsWithCaps) {
        let baseRelevance = 0;
        const matchedSectors = new Set<SectorTag>();

        if (client.sector_tag && docSectors.has(client.sector_tag as SectorTag)) {
          baseRelevance = Math.max(baseRelevance, 0.5);
          matchedSectors.add(client.sector_tag as SectorTag);
        }
        for (const cap of client.capabilities) {
          if (cap.sector && docSectors.has(cap.sector as SectorTag)) {
            baseRelevance = Math.max(baseRelevance, 0.5);
            matchedSectors.add(cap.sector as SectorTag);
          }
        }

        if (baseRelevance < 0.7) {
          const capKeywords = new Set<string>();
          for (const cap of client.capabilities) {
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
          for (const kw of capKeywords) {
            if (titleLower.includes(kw)) {
              baseRelevance = Math.max(baseRelevance, 0.7);
              break;
            }
          }
        }

        const finalScore = baseRelevance * urgencyMultiplier;
        if (finalScore <= 0.3) continue;

        try {
          const matchedLdaCodes = matchedSectors.size
            ? ldaCodesForSectors([...matchedSectors])
            : docLdaCodes;
          const dedupeKey = commentDeadlineDedupeKey('state_register', doc.id, client.id);
          const data = {
            source: 'state_register',
            changeType: 'comment_deadline_approaching',
            severity,
            title: `Comment period closing in ${daysToDeadline}d: ${doc.title.slice(0, 80)}`,
            description: `${doc.rule_type} from ${doc.state} ${doc.agency} has a comment deadline in ${daysToDeadline} days. Relevant to ${client.name} (relevance: ${Math.round(finalScore * 100)}%).`,
            relatedClientIds: [client.id],
            relatedIssues: matchedLdaCodes,
            data: {
              documentId: doc.id,
              daysToDeadline,
              relevanceScore: finalScore,
              tenantId: tenant.id,
            },
            dedupeKey,
          };
          await prisma.intelligenceChange.upsert({
            where: { dedupeKey },
            create: data,
            update: data,
          });
          emitted++;
        } catch (err) {
          errors++;
          console.error(
            `[check-comment-periods] failed to emit (state) for ${client.name}/${doc.id}:`,
            err,
          );
        }
      }
    }

    console.log(`[check-comment-periods] tenant=${tenant.slug} processed`);
  }

  console.log(
    `[check-comment-periods] done. Emitted ${emitted} alerts, ${errors} errors. Elapsed: ${Date.now() - startedAt.getTime()}ms`,
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
