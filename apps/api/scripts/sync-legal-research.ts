import {
  legalResearchManifest,
  type LegalResearchManifest,
} from '../src/ingestion/legal-research-manifest.js';
import { hydrateResearchDocuments } from '../src/ingestion/research-document-hydration.js';
import { fetchAdoptedRuleText } from '../src/external/state-register/fl-adopted-text.client.js';
import { fetchFloridaConstitution } from '../src/external/state-register/fl-constitution.client.js';

import {
  inventoryObservedAt,
  qualifyLegislativeCorpus,
} from '../src/ingestion/legislative-corpus.js';

/** Bounded API-owned pilot ingestion. Explicit manifest required; no notification owner here. */

import { readFileSync } from 'node:fs';

import { createHash } from 'node:crypto';

import { PrismaClient } from '@prisma/client';

import {
  parseFloridaCitation,
  parseFloridaConstitutionCitation,
  legalReferenceKey,
} from '@capiro/shared';

import { fetchFloridaStatutes } from '../src/external/state-register/fl-statutes.client.js';

import {
  persistLegalReference,
  indexLegislativeReferences,
} from '../src/ingestion/legal-research-evidence.js';

const hash = (s: unknown) => createHash('sha256').update(JSON.stringify(s)).digest('hex');

export async function runLegalResearch(prisma: PrismaClient, input: LegalResearchManifest) {
  const manifest = legalResearchManifest(input);
  const outcomes: Array<Record<string, unknown>> = [];

  for (const citation of manifest.citations) {
    const reference = parseFloridaCitation(citation);

    if (!reference) {
      outcomes.push({
        citation,
        status: 'unresolved',
        reason: 'CITATION_IDENTITY_REQUIRES_REVIEW',
      });
      continue;
    }

    try {
      const result = await fetchFloridaStatutes(manifest.edition, reference);

      await prisma.$transaction((tx) => persistLegalReference(tx, reference));
      // Each immutable section is its own checkpoint. A large chapter must not
      // lose completed sections when a later insert reaches the transaction limit.
      // The enclosing source receipt remains incomplete until every section succeeds.
      for (const revision of result.revisions) {
        await prisma.$transaction(
          async (tx) => {
            const referenceId = await persistLegalReference(tx, revision.reference);

            await tx.$executeRaw`INSERT INTO legal_text_revision(id,reference_id,edition,source_url,content_hash,extraction_hash,parser_version,title,sections,original_html,history_text,complete,coverage)

      VALUES(${revision.id},${referenceId},${revision.edition},${revision.sourceUrl},${revision.contentHash},${revision.extractionHash},${revision.parserVersion},${revision.title},${JSON.stringify(revision.sections)}::jsonb,${revision.originalHtml},${revision.historyText},${revision.complete},${JSON.stringify(revision.coverage)}::jsonb) ON CONFLICT DO NOTHING`;
          },
          { timeout: 30000 },
        );
      }

      outcomes.push({ citation, status: 'ingested', revisions: result.revisions.map((r) => r.id) });
    } catch (e) {
      outcomes.push({ citation, status: 'unresolved', reason: (e as Error).message });
    }
  }

  for (const article of manifest.constitutionArticles ?? []) {
    try {
      const v = await fetchFloridaConstitution(article);
      await prisma.$transaction(async (tx) => {
        const id = await persistLegalReference(tx, v.reference);
        await tx.$executeRaw`INSERT INTO legal_text_revision(id,reference_id,edition,source_url,content_hash,extraction_hash,parser_version,title,sections,original_html,complete,coverage) VALUES(${v.id},${id},NULL,${v.sourceUrl},${v.contentHash},${v.extractionHash},${v.parserVersion},${v.title},${JSON.stringify(v.sections)}::jsonb,${v.originalHtml},${v.complete},${JSON.stringify(v.coverage)}::jsonb) ON CONFLICT DO NOTHING`;
        for (const section of v.sections) {
          const number = section.locator.split(':').at(-1)!,
            ref = parseFloridaConstitutionCitation(
              `Article ${v.reference.chapter}, Section ${number}`,
            )!;
          const sectionId = await persistLegalReference(tx, ref),
            revisionId = hash([
              legalReferenceKey(ref),
              v.contentHash,
              section.hash,
              v.parserVersion,
            ]);
          await tx.$executeRaw`INSERT INTO legal_text_revision(id,reference_id,edition,source_url,content_hash,extraction_hash,parser_version,title,sections,original_html,complete,coverage) VALUES(${revisionId},${sectionId},NULL,${v.sourceUrl},${v.contentHash},${section.hash},${v.parserVersion},${v.title + ' — Section ' + number},${JSON.stringify([section])}::jsonb,${v.originalHtml},${!section.text.includes('\uFFFD')},${JSON.stringify({ scope: 'selected_constitution_section', parentRevision: v.id })}::jsonb) ON CONFLICT DO NOTHING`;
        }
      });
      outcomes.push({
        article,
        status: v.complete ? 'ingested' : 'unresolved',
        revisionId: v.id,
        coverage: v.coverage,
      });
    } catch (e) {
      outcomes.push({ article, status: 'unresolved', reason: (e as Error).message });
    }
  }

  for (const selected of manifest.adoptedRules ?? []) {
    try {
      const v = await fetchAdoptedRuleText(selected.ruleNumber, selected.sourceUrl);
      const reference = {
        jurisdiction: 'FL',
        code: 'administrative_rule' as const,
        kind: 'rule' as const,
        chapter: null,
        section: selected.ruleNumber,
        subdivisions: [],
      };
      const revisionId = hash([reference, v.contentHash, v.extractionHash, v.parserVersion]);
      await prisma.$transaction(async (tx) => {
        const id = await persistLegalReference(tx, reference);
        await tx.$executeRaw`INSERT INTO legal_text_revision(id,reference_id,edition,source_url,content_hash,extraction_hash,parser_version,title,sections,original_bytes_base64,source_dates,complete,coverage) VALUES(${revisionId},${id},NULL,${v.sourceUrl},${v.contentHash},${v.extractionHash},${v.parserVersion},${'Selected adopted text for ' + v.ruleNumber},${JSON.stringify(v.sections)}::jsonb,${v.originalBytesBase64},${JSON.stringify(v.sourceDates)}::jsonb,${v.complete},${JSON.stringify({ ...v.coverage, historyHash: v.historyHash })}::jsonb) ON CONFLICT DO NOTHING`;
      });
      outcomes.push({
        ruleNumber: v.ruleNumber,
        revisionId,
        status: v.complete ? 'ingested' : 'partial',
        coverage: v.coverage,
      });
    } catch (e) {
      outcomes.push({
        ruleNumber: selected.ruleNumber,
        status: 'unresolved',
        reason: (e as Error).message,
      });
    }
  }
  const hydration = await hydrateResearchDocuments(prisma, manifest);
  if (hydration.requested) outcomes.push({ documentHydration: hydration });
  const documents = await prisma.$queryRaw<
    Array<{
      document_id: string;
      bill_id: string;
      jurisdiction: string;
      session_key: string;
      revision_hash: string;
      document_kind: string;
      provider_id: string;
      provider_hash: string | null;
      extractor_version: string | null;
      coverage: string;
      extraction_state: string;
      is_current: boolean;
      sections: Array<{ locator: string; text: string }>;
    }>
  >`SELECT * FROM legiwatch_research_document_source WHERE jurisdiction=${manifest.jurisdiction} AND session_key=${manifest.sessionKey} AND bill_id=ANY(${manifest.billIds}::text[]) ORDER BY document_id LIMIT 501`;

  if (documents.length > 500) throw Error('SELECTED_DOCUMENT_BUDGET_EXCEEDED');

  for (const d of documents) {
    const result = await prisma.$transaction(
      (tx) =>
        indexLegislativeReferences(tx, {
          id: d.document_id,
          billId: d.bill_id,
          jurisdiction: d.jurisdiction,
          sessionKey: d.session_key,
          revision: d.revision_hash,
          kind: d.document_kind,
          sections: Array.isArray(d.sections) ? d.sections : [],
        }),
      { timeout: 30000 },
    );
    outcomes.push({ documentId: d.document_id, ...result });
  }

  const inventories = await prisma.stateBill.findMany({
    where: {
      id: { in: manifest.billIds },
      state: manifest.jurisdiction,
      sessionKey: manifest.sessionKey,
    },
    select: { id: true, reportSourceFacts: true, legiscanChangeHash: true, sourceCheckedAt: true },
  });

  const corpus = manifest.billIds.length
    ? qualifyLegislativeCorpus(
        manifest.billIds,
        inventories.map((b) => {
          const facts = (b.reportSourceFacts ?? {}) as Record<string, any>,
            inventory = facts.documentInventory ?? {};
          return {
            billId: b.id,
            providerChangeHash: b.legiscanChangeHash,
            sourceCheckedAt: inventoryObservedAt(
              inventory,
              b.legiscanChangeHash,
              b.sourceCheckedAt?.toISOString() ?? null,
            ),
            sourceListComplete:
              inventory.sourceListComplete === true &&
              inventory.providerChangeHash === b.legiscanChangeHash,
            expected: Array.isArray(inventory.expected) ? inventory.expected : [],
          };
        }),
        documents.map((d) => ({
          documentId: d.document_id,
          billId: d.bill_id,
          kind: d.document_kind,
          providerId: d.provider_id,
          providerHash: d.provider_hash,
          revision: d.revision_hash,
          parserVersion: d.extractor_version,
          complete: d.coverage === 'complete_document' && d.extraction_state === 'extracted',
          isCurrent: d.is_current,
        })),
      )
    : null;

  const [fingerprint] = await prisma.$queryRaw<
    Array<{ value: string }>
  >`SELECT md5(coalesce(string_agg(document_id||revision_hash||is_current::text,'|' ORDER BY document_id COLLATE "C"),'')) AS value FROM legiwatch_research_document_source WHERE jurisdiction=${manifest.jurisdiction} AND session_key=${manifest.sessionKey} AND bill_id=ANY(${manifest.billIds}::text[])`;

  const [inventoryFingerprint] = await prisma.$queryRaw<
    Array<{ value: string }>
  >`SELECT md5(coalesce(string_agg(id||coalesce(legiscan_change_hash,'')||coalesce(report_source_facts->'documentInventory','{}'::jsonb)::text,'|' ORDER BY id COLLATE "C"),'')) AS value FROM state_bill WHERE state=${manifest.jurisdiction} AND session_key=${manifest.sessionKey} AND id=ANY(${manifest.billIds}::text[])`;

  const inventoryRecheck = await prisma.stateBill.findMany({
    where: {
      id: { in: manifest.billIds },
      state: manifest.jurisdiction,
      sessionKey: manifest.sessionKey,
    },
    select: { id: true, reportSourceFacts: true, legiscanChangeHash: true, sourceCheckedAt: true },
  });

  const stableInventories =
    hash([...inventories].sort((a, b) => a.id.localeCompare(b.id))) ===
    hash([...inventoryRecheck].sort((a, b) => a.id.localeCompare(b.id)));

  const readFingerprint = createHash('md5')
    .update(documents.map((d) => d.document_id + d.revision_hash + String(d.is_current)).join('|'))
    .digest('hex');

  const stableDocuments = readFingerprint === fingerprint?.value;

  if (corpus && (!stableInventories || !stableDocuments)) {
    corpus.complete = false;
    corpus.gaps.push('SOURCE_CHANGED_DURING_QUALIFICATION');
  }

  const receipt = {
    manifest,
    outcomes,
    corpus,
    inventoryFingerprint: inventoryFingerprint?.value,
    sourceFingerprint: fingerprint?.value,
    complete:
      outcomes.every((o) => !('status' in o) || o.status === 'ingested') &&
      (!corpus || corpus.complete),
    billDocumentCorpusComplete: corpus?.complete ?? false,
    clientAssignments: 0,
    notifications: 0,
  };

  await prisma.$executeRaw`INSERT INTO legal_source_receipt(id,source,scope,manifest,complete) VALUES(${hash([receipt, new Date().toISOString()])},'fl-legal-pilot',${JSON.stringify(manifest)}::jsonb,${JSON.stringify(receipt)}::jsonb,${receipt.complete})`;

  return receipt;
}

if (require.main === module) {
  const file = process.env.LEGIWATCH_RESEARCH_MANIFEST;
  if (!file) throw Error('LEGIWATCH_RESEARCH_MANIFEST_REQUIRED');
  const manifest = legalResearchManifest(JSON.parse(readFileSync(file, 'utf8')));
  if (process.env.LEGIWATCH_RESEARCH_APPLY !== 'true') {
    console.log(JSON.stringify({ mode: 'dry_run', manifest, sideEffects: false }));
  } else {
    const prisma = new PrismaClient();
    runLegalResearch(prisma, manifest)
      .then((r) => console.log(JSON.stringify(r)))
      .catch((e) => {
        console.error(e);
        process.exitCode = 1;
      })
      .finally(() => prisma.$disconnect());
  }
}
