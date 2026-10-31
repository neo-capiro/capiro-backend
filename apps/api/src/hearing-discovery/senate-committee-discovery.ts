import type { PrismaClient } from '@prisma/client';
import { CommitteeSourceRepository } from './committee-source.repository.js';
import { HearingReconcilerService } from './hearing-reconciler.service.js';
import { SenateCommitteeCalendarAdapter } from './adapters/senate-committee-calendar.adapter.js';
import { sleep } from './adapters/source-http.js';
import type { DiscoveryContext } from './hearing-discovery.types.js';

/** Supplement the central Senate feed using the existing registered official
 * calendars. Each source records its own failure and all healthy peers proceed. */
export async function discoverSenateCommitteeCalendars(
  prisma: PrismaClient,
  input: { congress: number; ctx: DiscoveryContext; now: Date },
) {
  const sources = new CommitteeSourceRepository(prisma);
  const reconciler = new HearingReconcilerService(prisma);
  const adapter = new SenateCommitteeCalendarAdapter({ congress: input.congress });
  const result = { inserted: 0, updated: 0, skipped: 0, errors: 0 };
  for (const source of await sources.listEnabled({
    adapterKey: adapter.adapterKey,
    chamber: 'senate',
  })) {
    await sources.markChecked(source.id, input.now);
    try {
      await sleep(input.ctx.delayMs);
      const events = await adapter.discoverEvents(source, input.ctx);
      const { totals } = await reconciler.reconcileBatch(source, events, input.now, input.ctx.log);
      result.inserted += totals.hearingsCreated;
      result.updated += totals.hearingsUpdated;
      result.skipped += totals.events - totals.hearingsCreated - totals.hearingsUpdated;
      if (totals.errors)
        throw new Error(`${totals.errors} committee event(s) failed reconciliation`);
      await sources.recordOutcome(
        source.id,
        { ok: true, observedEvents: events.length },
        input.now,
        adapter.parserVersion,
      );
    } catch (error) {
      result.errors += 1;
      await sources.recordOutcome(
        source.id,
        {
          ok: false,
          error: (error instanceof Error ? error.message : String(error)).slice(0, 1000),
        },
        input.now,
        adapter.parserVersion,
      );
    }
  }
  return result;
}
