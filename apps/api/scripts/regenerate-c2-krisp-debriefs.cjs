'use strict';

// Run inside the main API image with its existing production configuration.
// Dry-run by default. --apply requires an exact tenant slug.
const { NestFactory } = require('@nestjs/core');
const { ConfigModule } = require('@nestjs/config');
const { validateConfig } = require('../dist/config/config.schema.js');
const { EngagementModule } = require('../dist/engagement/engagement.module.js');
const { PrismaService } = require('../dist/prisma/prisma.service.js');
const { KrispNotetakerService } = require('../dist/engagement/krisp/krisp-notetaker.service.js');
const { MeetingNotesCryptoService } = require('../dist/engagement/meeting-notes-crypto.service.js');
const { MeetingCapturePersistenceService } = require('../dist/meeting-capture/meeting-capture-persistence.service.js');
const { EngagementRuntimePolicyService } = require('../dist/engagement/runtime/engagement-runtime-policy.service.js');
const { formatDebriefBody } = require('../dist/engagement/notetaker/meeting-debrief-format.js');
const { regenerateC2KrispDebriefs } = require('./lib/krisp-debrief-regeneration.cjs');

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  if (!args.includes('--tenant=c2-strategies') || args.some((arg) =>
      !['--apply', '--tenant=c2-strategies'].includes(arg) && !/^--limit=\d+$/.test(arg)))
    throw new Error('Specify --tenant=c2-strategies [--limit=N] [--apply].');
  const limit = Number(args.find((arg) => arg.startsWith('--limit='))?.split('=')[1] ?? 100000);
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('Invalid limit.');
  const app = await NestFactory.createApplicationContext({
    module: class KrispDebriefBackfillModule {},
    imports: [ConfigModule.forRoot({ isGlobal: true, validate: validateConfig }), EngagementModule],
  }, { logger: ['error'] });
  try {
    const prisma = app.get(PrismaService);
    const service = app.get(KrispNotetakerService);
    const crypto = app.get(MeetingNotesCryptoService);
    const persistence = app.get(MeetingCapturePersistenceService);
    const runtime = app.get(EngagementRuntimePolicyService);
    const tenant = await prisma.withSystem((tx) => tx.tenant.findUnique({
      where: { slug: 'c2-strategies' }, select: { id: true, slug: true },
    }));
    if (!tenant) throw new Error('C2 tenant not found.');
    const preferences = await prisma.withTenant(tenant.id, (tx) =>
      tx.krispNotetakerPreference.findMany({ where: { tenantId: tenant.id, enabled: true } }));
    const totals = { scanned: 0, eligible: 0, converted: 0, changed: 0, missing: 0, failed: 0 };
    for (const preference of preferences) {
      const ctx = await service.context(preference);
      if (!ctx || ctx.tenantSlug !== 'c2-strategies') continue;
      const result = await regenerateC2KrispDebriefs({
        prisma, service, crypto, ctx, preference, apply,
        limit: Math.max(0, limit - totals.scanned),
        format: formatDebriefBody,
        generate: async (context, meetingId, sourceText) => {
          runtime.assertExternalAction('meeting_debrief_generate');
          return persistence.generateMeetingDebriefDraft(context, meetingId, {
            method: 'upload', sourceText,
          });
        },
        progress: (snapshot) => {
          if (snapshot.converted && snapshot.converted % 10 === 0)
            process.stdout.write(JSON.stringify({ userId: ctx.userId, ...snapshot }) + '\n');
        },
      });
      for (const key of Object.keys(totals)) totals[key] += result[key];
      process.stdout.write(JSON.stringify({ userId: ctx.userId, ...result }) + '\n');
      if (totals.scanned >= limit) break;
    }
    process.stdout.write(JSON.stringify({ apply, tenant: tenant.slug, ...totals }) + '\n');
    if (totals.failed) process.exitCode = 2;
  } finally {
    await app.close();
  }
}

main().catch((error) => {
  // Provider errors may contain source text. Keep diagnostic detail out of logs.
  process.stderr.write(`C2 Krisp debrief backfill stopped: ${error.name || 'Error'}\n`);
  process.exitCode = 1;
});
