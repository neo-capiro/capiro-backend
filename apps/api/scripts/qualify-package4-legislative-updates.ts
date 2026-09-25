/** Disposable-Postgres Package 4 exit qualification. No live provider calls. */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import {
  persistFederalEvidenceRemoval,
  persistFederalEvidenceSnapshot,
  replayPendingFederalEvidenceMentions,
} from '../src/program-element/federal-evidence/persistence.js';
import { drainFederalEvidenceOutbox } from '../src/program-element/federal-evidence/outbox.js';
import { FederalEvidenceReadService } from '../src/program-element/federal-evidence/federal-evidence-read.service.js';
import { replaceCongressBillActionsAtomically } from './lib/congress-actions.js';

function arg(name: string): string | undefined {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 ? process.argv[at + 1] : undefined;
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const prisma = new PrismaClient();
  await prisma.$connect();
  const run = randomUUID().slice(0, 8);
  const tenantId = randomUUID();
  const userId = randomUUID();
  const clientId = randomUUID();
  const billId = `119-hr-${9000 + Math.floor(Math.random() * 900)}`;
  const peCode = `0604${String(Math.floor(Math.random() * 1000)).padStart(3, '0')}F`;
  const packageId = `BILLS-119hr${billId.split('-').at(-1)}ih`;
  const sourceKey = `govinfo:${packageId}`;
  const at = (hour: number) => new Date(`2026-09-24T${String(hour).padStart(2, '0')}:00:00Z`);
  const evidence: Record<string, unknown> = {
    run,
    database: new URL(process.env.DATABASE_URL).pathname.slice(1),
    scenarios: {},
  };
  try {
    await prisma.tenant.create({ data: { id: tenantId, slug: `package4-${run}`, name: `Package 4 ${run}` } });
    await prisma.user.create({
      data: { id: userId, clerkUserId: `package4_${run}`, email: `package4-${run}@example.test` },
    });
    await prisma.congressBill.create({
      data: {
        id: billId,
        congress: 119,
        billType: 'hr',
        billNumber: billId.split('-').at(-1)!,
        title: 'Package 4 Qualification Bill',
      },
    });
    await prisma.trackedBill.create({ data: { tenantId, clientId, billId, source: 'imported' } });

    const first = await persistFederalEvidenceSnapshot(prisma, {
      provider: 'govinfo',
      collection: 'BILLS',
      packageId,
      billId,
      versionCode: 'ih',
      lineageKey: `${billId}:house`,
      sourceUrl: `https://www.govinfo.gov/content/pkg/${packageId}/xml/${packageId}.xml`,
      rawContent: `<bill><section>Initial support for ${peCode}.</section></bill>`,
      extractedText: `Initial support for ${peCode}.`,
      completeness: 'complete',
      inventoryWindowEnd: at(1),
      observationKey: `${run}:initial`,
    });
    assert.deepEqual(first.pendingUnknownCodes, [peCode]);
    assert.equal(await prisma.federalEvidenceMention.count({ where: { qualificationState: 'pending' } }), 1);

    await prisma.programElement.create({
      data: { peCode, title: 'Qualification Program Element', source: 'package4-qualification' },
    });
    await prisma.programElementWatch.create({ data: { tenantId, userId, peCode } });
    const replay = await replayPendingFederalEvidenceMentions(prisma);
    assert.deepEqual(replay, { scanned: 1, resolved: 1 });
    assert.deepEqual(await replayPendingFederalEvidenceMentions(prisma), { scanned: 0, resolved: 0 });
    const historicalDrain = await drainFederalEvidenceOutbox(prisma);
    assert.equal(historicalDrain.suppressedHistorical, 1);
    assert.equal(await prisma.intelligenceChange.count({ where: { changeType: 'resolved' } }), 0);
    (evidence.scenarios as Record<string, unknown>).unknownCodeReplay = {
      first,
      replay,
      historicalDrain,
    };

    const changed = await persistFederalEvidenceSnapshot(prisma, {
      provider: 'govinfo',
      collection: 'BILLS',
      packageId,
      billId,
      versionCode: 'ih',
      lineageKey: `${billId}:house`,
      sourceUrl: `https://www.govinfo.gov/content/pkg/${packageId}/xml/${packageId}.xml`,
      rawContent: `<bill><section>Revised restriction and amount for ${peCode}.</section></bill>`,
      extractedText: `Revised restriction and amount for ${peCode}.`,
      completeness: 'complete',
      inventoryWindowEnd: at(2),
      observationKey: `${run}:changed`,
    });
    assert.deepEqual(changed.eventTypes.sort(), ['changed', 'text_changed']);
    assert.equal(await prisma.federalEvidenceRevision.count({ where: { sourceKey } }), 2);
    const changedDrain = await drainFederalEvidenceOutbox(prisma);
    assert.equal(changedDrain.failed, 0);
    assert.equal(changedDrain.alertsInserted, 2);

    const retry = await persistFederalEvidenceSnapshot(prisma, {
      provider: 'govinfo',
      collection: 'BILLS',
      packageId,
      billId,
      versionCode: 'ih',
      lineageKey: `${billId}:house`,
      sourceUrl: `https://www.govinfo.gov/content/pkg/${packageId}/xml/${packageId}.xml`,
      rawContent: `<bill><section>Revised restriction and amount for ${peCode}.</section></bill>`,
      extractedText: `Revised restriction and amount for ${peCode}.`,
      completeness: 'complete',
      inventoryWindowEnd: at(2),
      observationKey: `${run}:changed`,
    });
    assert.equal(retry.observationInserted, false);
    assert.deepEqual(retry.eventTypes, []);

    const changedOutbox = await prisma.federalEvidenceChangeOutbox.findFirstOrThrow({
      where: { payload: { path: ['eventType'], equals: 'changed' } },
    });
    await prisma.federalEvidenceChangeOutbox.update({
      where: { id: changedOutbox.id },
      data: { status: 'failed', availableAt: new Date(0), processedAt: null },
    });
    const uncertainRetry = await drainFederalEvidenceOutbox(prisma, 1);
    assert.equal(uncertainRetry.processed, 1);
    assert.equal(uncertainRetry.alertsInserted, 0);
    (evidence.scenarios as Record<string, unknown>).sameCodeChangedLanguage = {
      changed,
      changedDrain,
      retry,
      uncertainRetry,
    };

    const partial = await persistFederalEvidenceSnapshot(prisma, {
      provider: 'govinfo',
      collection: 'BILLS',
      packageId,
      billId,
      versionCode: 'ih',
      lineageKey: `${billId}:house`,
      sourceUrl: `https://www.govinfo.gov/content/pkg/${packageId}/xml/${packageId}.xml`,
      rawContent: '<bill><section>Truncated publisher response',
      extractedText: 'Truncated publisher response',
      completeness: 'partial',
      inventoryWindowEnd: at(2),
      observationKey: `${run}:partial`,
    });
    assert.deepEqual(partial.eventTypes, []);
    const currentAfterPartial = await prisma.$queryRaw<Array<{ revisionId: string; state: string }>>`
      SELECT revision_id AS "revisionId", state
        FROM federal_evidence_current
       WHERE source_key = ${sourceKey}`;
    assert.equal(currentAfterPartial[0]?.revisionId, changed.revisionId);
    assert.equal(currentAfterPartial[0]?.state, 'present');
    assert.equal((await drainFederalEvidenceOutbox(prisma)).claimed, 0);
    (evidence.scenarios as Record<string, unknown>).partialSafety = {
      partial,
      currentRevisionId: currentAfterPartial[0]?.revisionId,
    };

    await assert.rejects(
      () =>
        persistFederalEvidenceRemoval(prisma, {
          sourceKey,
          observationKey: `${run}:unsafe-removal`,
          inventoryWindowEnd: at(3),
          inventoryComplete: false,
        }),
      /INCOMPLETE_INVENTORY_CANNOT_REMOVE_EVIDENCE/,
    );
    const removed = await persistFederalEvidenceRemoval(prisma, {
      sourceKey,
      observationKey: `${run}:removed`,
      inventoryWindowEnd: at(3),
      inventoryComplete: true,
    });
    assert.deepEqual(removed.eventTypes, ['removed']);
    const removalDrain = await drainFederalEvidenceOutbox(prisma);
    assert.equal(removalDrain.failed, 0);

    const reinstated = await persistFederalEvidenceSnapshot(prisma, {
      provider: 'govinfo',
      collection: 'BILLS',
      packageId,
      billId,
      versionCode: 'ih',
      lineageKey: `${billId}:house`,
      sourceUrl: `https://www.govinfo.gov/content/pkg/${packageId}/xml/${packageId}.xml`,
      rawContent: `<bill><section>Revised restriction and amount for ${peCode}.</section></bill>`,
      extractedText: `Revised restriction and amount for ${peCode}.`,
      completeness: 'complete',
      inventoryWindowEnd: at(4),
      observationKey: `${run}:reinstated`,
    });
    assert.deepEqual(reinstated.eventTypes, ['reinstated']);
    const reinstatementDrain = await drainFederalEvidenceOutbox(prisma);
    assert.equal(reinstatementDrain.failed, 0);
    (evidence.scenarios as Record<string, unknown>).removalAndReinstatement = {
      removed,
      removalDrain,
      reinstated,
      reinstatementDrain,
    };

    // A historical full-inventory removal must be retained for lifecycle
    // reads but consumed by the outbox without creating a client alert.
    const historicalPackageId = `${packageId}-historical-${run}`;
    const historicalSourceKey = `govinfo:${historicalPackageId}`;
    await persistFederalEvidenceSnapshot(prisma, {
      provider: 'govinfo',
      collection: 'BILLS',
      packageId: historicalPackageId,
      billId,
      versionCode: 'historical',
      lineageKey: `${billId}:house`,
      sourceUrl: `https://www.govinfo.gov/content/pkg/${historicalPackageId}/xml/${historicalPackageId}.xml`,
      rawContent: `<bill><section>Historical mention of ${peCode}.</section></bill>`,
      extractedText: `Historical mention of ${peCode}.`,
      completeness: 'complete',
      inventoryWindowEnd: at(5),
      observationKey: `${run}:historical-baseline`,
      historical: true,
    });
    const historicalBaselineDrain = await drainFederalEvidenceOutbox(prisma);
    assert.equal(historicalBaselineDrain.failed, 0);
    assert.ok(historicalBaselineDrain.suppressedHistorical >= 1);
    const notificationsBeforeHistoricalRemoval = await prisma.intelligenceChange.count();
    const historicalRemoval = await persistFederalEvidenceRemoval(prisma, {
      sourceKey: historicalSourceKey,
      observationKey: `${run}:historical-removal`,
      inventoryWindowEnd: at(6),
      historical: true,
      inventoryComplete: true,
    });
    assert.deepEqual(historicalRemoval.eventTypes, ['removed']);
    const historicalRemovalDrain = await drainFederalEvidenceOutbox(prisma);
    assert.equal(historicalRemovalDrain.failed, 0);
    assert.equal(historicalRemovalDrain.suppressedHistorical, 1);
    assert.equal(historicalRemovalDrain.alertsInserted, 0);
    assert.equal(
      await prisma.intelligenceChange.count(),
      notificationsBeforeHistoricalRemoval,
    );
    (evidence.scenarios as Record<string, unknown>).historicalRemovalSuppression = {
      historicalBaselineDrain,
      historicalRemoval,
      historicalRemovalDrain,
      notificationsBeforeHistoricalRemoval,
    };

    const oldAction = {
      date: new Date('2026-09-23T00:00:00Z'),
      text: 'Introduced in House',
      type: 'IntroReferral',
      chamber: 'House',
    };
    const newAction = {
      date: new Date('2026-09-24T00:00:00Z'),
      text: 'Ordered to be Reported by Voice Vote.',
      type: 'Committee',
      chamber: 'House',
    };
    await replaceCongressBillActionsAtomically(prisma, billId, [oldAction]);
    assert.equal((await drainFederalEvidenceOutbox(prisma)).claimed, 0);
    await replaceCongressBillActionsAtomically(prisma, billId, [oldAction, newAction]);
    const actionDrain = await drainFederalEvidenceOutbox(prisma);
    assert.equal(actionDrain.alertsInserted, 1);
    await replaceCongressBillActionsAtomically(prisma, billId, [oldAction, newAction]);
    assert.equal((await drainFederalEvidenceOutbox(prisma)).claimed, 0);
    (evidence.scenarios as Record<string, unknown>).actionOutbox = { actionDrain };

    const reads = new FederalEvidenceReadService(prisma as never);
    const current = await reads.currentQualifiedMentions(peCode, { limit: 10 });
    const timeline = await reads.lifecycleTimeline({ peCode, billId }, { limit: 50 });
    assert.equal(current.items.length, 1);
    assert.deepEqual(
      new Set(timeline.items.map((item) => item.eventType)),
      new Set(['resolved', 'changed', 'removed', 'reinstated']),
    );
    const billTimeline = await reads.lifecycleTimeline({ billId }, { limit: 50 });
    assert.ok(billTimeline.items.some((item) => item.eventType === 'text_changed'));
    assert.ok(billTimeline.items.some((item) => item.eventType === 'action_added'));
    (evidence.scenarios as Record<string, unknown>).qualifiedReads = {
      currentCount: current.items.length,
      peEventTypes: [...new Set(timeline.items.map((item) => item.eventType))],
      billEventTypes: [...new Set(billTimeline.items.map((item) => item.eventType))],
    };

    const revision = await prisma.federalEvidenceRevision.findFirstOrThrow({ where: { sourceKey } });
    await assert.rejects(
      () =>
        prisma.$executeRaw`UPDATE federal_evidence_revision SET extracted_text = 'tampered' WHERE id = ${revision.id}::uuid`,
      /immutable|rewrite|P2010/i,
    );
    assert.equal(await prisma.federalEvidenceChangeOutbox.count({ where: { status: { not: 'processed' } } }), 0);
    evidence.counts = {
      revisions: await prisma.federalEvidenceRevision.count(),
      observations: await prisma.federalEvidenceObservation.count(),
      mentions: await prisma.federalEvidenceMention.count(),
      events: await prisma.federalEvidenceMentionEvent.count(),
      outboxProcessed: await prisma.federalEvidenceChangeOutbox.count({ where: { status: 'processed' } }),
      alerts: await prisma.intelligenceChange.count({ where: { source: 'federal_legislative_evidence' } }),
    };
    evidence.result = 'PASS';
    const output = arg('out');
    if (output) {
      const path = resolve(output);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
    }
    console.log(JSON.stringify(evidence, null, 2));
  } finally {
    await prisma.$disconnect();
  }
}

void main().catch((error) => {
  console.error('[qualify-package4-legislative-updates] FAILED', error);
  process.exit(1);
});
