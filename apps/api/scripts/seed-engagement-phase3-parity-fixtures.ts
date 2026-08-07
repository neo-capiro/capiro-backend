#!/usr/bin/env tsx
/**
 * Engagement Phase 3 parity fixtures — seed, cleanup, and contract emitter.
 *
 * Micro-session 3.2. Materializes the declarative plan in
 * `engagement-phase3-fixture-plan.ts` into a DISPOSABLE local PostgreSQL
 * database so every current Engagement UI state renders in both main and
 * preview mode.
 *
 * Modes:
 *   --apply             cleanup, then insert the full fixture set
 *   --cleanup           delete every fixture row, in dependency order
 *   --write-contract    regenerate the committed contract JSON
 *   --check-contract    fail if the committed contract differs from a fresh build
 *   --verify            read back and assert the applied row counts
 *
 * Deliberate choices, and why:
 *
 *  - **Typed Prisma, not raw SQL.** Phase 0's seed used `$executeRawUnsafe` with
 *    inlined UUIDs. At this fixture's size (~140 rows across 26 tables) a schema
 *    mistake found by `tsc` costs seconds; the same mistake found by Postgres
 *    costs a container round-trip per attempt.
 *
 *  - **Cleanup-then-create, not upsert.** Upsert-by-id leaves a stale row
 *    whenever a field is removed from the plan, so "idempotent" would drift into
 *    "accumulates". Delete-then-insert makes the END STATE idempotent, which is
 *    the property the parity suites actually depend on.
 *
 *  - **Cleanup deletes by tenant, not by row id.** `OutreachDraftVersion`'s
 *    author FK is `onDelete: Restrict`, so once a parity test authors a version
 *    against a fixture user, deleting that user by id fails. The fixture owns its
 *    tenants outright, so scoping cleanup to them collects test-created rows too.
 *
 *  - **Notes are encrypted by the product's own service.** A fixture that
 *    hand-rolled AES would let the "notes encryption unavailable" edge state in
 *    3.6 be indistinguishable from a fixture whose cipher had drifted.
 *
 * Refuses to run against anything but a loopback database unless
 * ENGAGEMENT_PHASE3_ALLOW_REMOTE_DB is set to the exact acknowledgement string.
 * No provider adapter, no S3, no AWS, no migration.
 */

import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ConfigService } from '@nestjs/config';
import type { Prisma } from '@prisma/client';
import type { AppConfig } from '../src/config/config.schema.js';
import { MeetingNotesCryptoService } from '../src/engagement/meeting-notes-crypto.service.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import {
  buildFixtureContract,
  buildFixturePlan,
  resolveTemporal,
  validateFixturePlan,
  type FixturePlan,
  type TemporalSpec,
} from './engagement-phase3-fixture-plan.js';

/**
 * `__dirname`, not `import.meta.url`: apps/api has no `"type": "module"`, so the
 * repo's Node16 module setting compiles this to CommonJS. `import.meta` would be
 * a compile error under the tsconfig that typechecks this file, and would break
 * the spec's import of it under ts-jest.
 */
export const SEED_DIR = __dirname;
const CONTRACT_PATH = path.resolve(
  SEED_DIR,
  '../src/engagement/__fixtures__/engagement-phase3-fixture-contract.v1.json',
);
const REMOTE_DB_ACK = 'i-understand-this-is-not-a-disposable-database';

type Mode = 'apply' | 'cleanup' | 'write-contract' | 'check-contract' | 'verify';

async function main(): Promise<void> {
  const modes = readModes(process.argv.slice(2));
  const plan = buildFixturePlan();

  const issues = validateFixturePlan(plan);
  if (issues.length) {
    for (const issue of issues) console.error(`INVALID  [${issue.rule}] ${issue.detail}`);
    throw new Error(`Fixture plan failed ${issues.length} validation check(s); nothing was written.`);
  }

  if (modes.has('write-contract')) {
    await writeFile(CONTRACT_PATH, `${JSON.stringify(buildFixtureContract(plan), null, 2)}\n`);
    console.log(`OK  contract written to ${path.relative(process.cwd(), CONTRACT_PATH)}`);
  }

  if (modes.has('check-contract')) {
    const expected = `${JSON.stringify(buildFixtureContract(plan), null, 2)}\n`;
    const actual = await readFile(CONTRACT_PATH, 'utf8').catch(() => '');
    if (actual !== expected) {
      throw new Error(
        `Committed fixture contract differs from a fresh build. Run with --write-contract.`,
      );
    }
    console.log('OK  committed fixture contract matches a fresh build');
  }

  if (!modes.has('apply') && !modes.has('cleanup') && !modes.has('verify')) return;

  assertDisposableDatabase();
  const crypto = buildNotesCrypto();
  const anchor = readAnchor();
  const prisma = new PrismaService();
  await prisma.$connect();

  try {
    if (modes.has('cleanup') || modes.has('apply')) {
      const deleted = await cleanup(prisma, plan);
      console.log(`OK  cleanup removed ${deleted} fixture row(s) across ${plan.cleanupOrder.length} tables`);
    }
    if (modes.has('apply')) {
      const inserted = await apply(prisma, plan, anchor, crypto);
      console.log(`OK  seeded ${inserted} fixture row(s); anchor ${anchor.toISOString()}`);
      const fixtureFile = process.env.ENGAGEMENT_PHASE3_FIXTURE_FILE?.trim();
      if (fixtureFile) {
        await writeFile(fixtureFile, `${JSON.stringify(buildFixtureIndex(plan, anchor), null, 2)}\n`);
        console.log(`OK  fixture index written to ${fixtureFile}`);
      }
    }
    if (modes.has('verify')) {
      await verify(prisma, plan, crypto);
      console.log('OK  every fixture row read back with the expected count and readable body');
    }
  } finally {
    await prisma.$disconnect();
  }
}

function readModes(argv: string[]): Set<Mode> {
  const known: Mode[] = ['apply', 'cleanup', 'write-contract', 'check-contract', 'verify'];
  const modes = new Set<Mode>();
  for (const arg of argv) {
    const name = arg.replace(/^--/, '') as Mode;
    if (!arg.startsWith('--') || !known.includes(name)) {
      throw new Error(`Unknown argument ${arg}. Expected one or more of: ${known.map((m) => `--${m}`).join(' ')}`);
    }
    modes.add(name);
  }
  if (!modes.size) throw new Error(`No mode given. Expected one or more of: ${known.map((m) => `--${m}`).join(' ')}`);
  return modes;
}

/**
 * The fixture set is destructive within its own tenants, so it must never be
 * pointed at a shared database by accident. Loopback-only unless a deliberate
 * acknowledgement is present.
 */
function assertDisposableDatabase(): void {
  const url = process.env.DATABASE_URL?.trim();
  if (!url) throw new Error('DATABASE_URL is required.');
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    throw new Error('DATABASE_URL is not a parseable URL.');
  }
  const loopback = host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
  if (loopback) return;
  if (process.env.ENGAGEMENT_PHASE3_ALLOW_REMOTE_DB?.trim() === REMOTE_DB_ACK) {
    console.warn(`WARN  running against non-loopback host ${host} by explicit acknowledgement`);
    return;
  }
  throw new Error(
    `Refusing to seed Phase 3 fixtures against non-loopback host "${host}". ` +
      `These fixtures delete every row in their own tenants. Set ` +
      `ENGAGEMENT_PHASE3_ALLOW_REMOTE_DB=${REMOTE_DB_ACK} only for a database you are certain is disposable.`,
  );
}

/**
 * The product's own note cipher, constructed with a minimal config reader. The
 * service only ever reads two keys, so a shim is enough — and reusing the
 * service is what guarantees the fixture's ciphertext is readable by the code
 * that will read it.
 */
function buildNotesCrypto(): MeetingNotesCryptoService {
  for (const name of ['NOTES_ENCRYPTION_KEY', 'NOTES_ENCRYPTION_KEY_VERSION']) {
    if (!process.env[name]?.trim()) {
      throw new Error(
        `${name} is required: meeting notes and debriefs are encrypted at rest, so the fixture ` +
          `cannot insert a plaintext body.`,
      );
    }
  }
  const shim = { get: (key: string) => process.env[key] };
  return new MeetingNotesCryptoService(shim as unknown as ConfigService<AppConfig, true>);
}

/**
 * The run anchor. Overridable so a harness can pin it; defaults to now because
 * "upcoming"/"past" meetings must stay upcoming and past whenever the seed runs.
 */
function readAnchor(): Date {
  const raw = process.env.ENGAGEMENT_PHASE3_ANCHOR?.trim();
  if (!raw) return new Date();
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) throw new Error(`ENGAGEMENT_PHASE3_ANCHOR is not a date: ${raw}`);
  return parsed;
}

// ─── apply ──────────────────────────────────────────────────────────────────

async function apply(
  prisma: PrismaService,
  plan: FixturePlan,
  anchor: Date,
  crypto: MeetingNotesCryptoService,
): Promise<number> {
  const id = buildKeyResolver(plan);
  const when = (spec: TemporalSpec | null): Date | null => (spec ? resolveTemporal(spec, anchor) : null);
  const at = (spec: TemporalSpec): Date => resolveTemporal(spec, anchor);
  let count = 0;

  await prisma.withSystem(
    async (tx) => {
      for (const row of plan.tenants) {
        await tx.tenant.create({
          data: {
            id: row.id,
            slug: row.slug,
            name: row.name,
            status: 'active',
            clerkOrgId: row.clerkOrgId,
            settings: { phase3ParityFixture: true },
          },
        });
        count += 1;
      }

      for (const row of plan.users) {
        await tx.user.create({
          data: {
            id: row.id,
            email: row.email,
            clerkUserId: row.clerkUserId,
            firstName: row.firstName,
            lastName: row.lastName,
          },
        });
        count += 1;
      }

      for (const row of plan.memberships) {
        await tx.tenantMembership.create({
          data: {
            id: row.id,
            tenantId: id.tenant(row.tenantKey),
            userId: id.user(row.userKey),
            role: row.role,
            status: row.status,
            joinedAt: anchor,
          },
        });
        count += 1;
      }

      for (const row of plan.impersonations) {
        await tx.impersonationSession.create({
          data: {
            id: row.id,
            tenantId: id.tenant(row.tenantKey),
            actorUserId: id.user(row.actorUserKey),
            reason: row.reason,
            startedAt: at(row.startedAt),
            expiresAt: at(row.expiresAt),
            endedAt: when(row.endedAt),
            endedReason: row.endedAt ? 'fixture: expired' : null,
          },
        });
        count += 1;
      }

      for (const row of plan.clients) {
        await tx.client.create({
          data: {
            id: row.id,
            tenantId: id.tenant(row.tenantKey),
            name: row.name,
            memoryWall: row.memoryWall,
            status: 'active',
          },
        });
        count += 1;
      }

      for (const row of plan.clientMemoryAccess) {
        await tx.clientMemoryAccess.create({
          data: {
            id: row.id,
            tenantId: id.tenant(row.tenantKey),
            clientId: id.client(row.clientKey),
            userId: id.user(row.userKey),
            grantedBy: id.user('actor.admin'),
          },
        });
        count += 1;
      }

      for (const row of plan.contacts) {
        await tx.engagementContact.create({
          data: {
            id: row.id,
            tenantId: id.tenant(row.tenantKey),
            clientId: row.clientKey ? id.client(row.clientKey) : null,
            fullName: row.fullName,
            email: row.email,
            organization: row.organization,
            title: row.title,
            source: 'manual',
            metadata: { phase3ParityFixture: true },
          },
        });
        count += 1;
      }

      for (const row of plan.meetings) {
        await tx.meeting.create({
          data: {
            id: row.id,
            tenantId: id.tenant(row.tenantKey),
            clientId: row.clientKey ? id.client(row.clientKey) : null,
            subject: row.subject,
            startsAt: at(row.startsAt),
            endsAt: at(row.endsAt),
            timeZone: row.timeZone,
            status: row.status,
            visibility: row.visibility,
            createdByUserId: id.user(row.createdByUserKey),
            organizerEmail: row.organizerEmail,
            location: row.location,
            source: 'manual',
            metadata: { phase3ParityFixture: true, allDay: row.allDay },
          },
        });
        count += 1;
      }

      for (const row of plan.attendees) {
        await tx.meetingAttendee.create({
          data: {
            id: row.id,
            tenantId: id.tenant(row.tenantKey),
            meetingId: id.meeting(row.meetingKey),
            contactId: row.contactKey ? id.contact(row.contactKey) : null,
            email: row.email,
            name: row.name,
            role: row.role,
          },
        });
        count += 1;
      }

      for (const row of plan.botSessions) {
        await tx.meetingBotSession.create({
          data: {
            id: row.id,
            tenantId: id.tenant(row.tenantKey),
            meetingId: id.meeting(row.meetingKey),
            requestedByUserId: id.user(row.requestedByUserKey),
            provider: 'recall',
            status: row.status,
            joinUrl: row.joinUrl,
            recordingPolicy: row.recordingPolicy,
            error: row.error,
            metadata: { phase3ParityFixture: true },
          },
        });
        count += 1;
      }

      for (const row of plan.preps) {
        await tx.meetingPrep.create({
          data: {
            id: row.id,
            tenantId: id.tenant(row.tenantKey),
            meetingId: id.meeting(row.meetingKey),
            clientId: row.clientKey ? id.client(row.clientKey) : null,
            status: row.status,
            summary: row.summary,
            agenda: row.agenda,
            generatedFrom: { phase3ParityFixture: true },
          },
        });
        count += 1;
      }

      for (const row of plan.notes) {
        const sealed = crypto.encrypt(row.bodyPlaintext);
        await tx.meetingNote.create({
          data: {
            id: row.id,
            tenantId: id.tenant(row.tenantKey),
            meetingId: id.meeting(row.meetingKey),
            clientId: row.clientKey ? id.client(row.clientKey) : null,
            authorUserId: id.user(row.authorUserKey),
            bodyCiphertext: sealed.bodyCiphertext,
            iv: sealed.iv,
            authTag: sealed.authTag,
            keyVersion: sealed.keyVersion,
            confidential: row.confidential,
            accessLevel: row.accessLevel,
            status: row.status,
            approvedAt: row.status === 'approved' ? anchor : null,
            approvedByUserId: row.status === 'approved' ? id.user(row.authorUserKey) : null,
          },
        });
        count += 1;
      }

      for (const row of plan.debriefs) {
        const sealed = crypto.encrypt(row.bodyPlaintext);
        await tx.meetingDebrief.create({
          data: {
            id: row.id,
            tenantId: id.tenant(row.tenantKey),
            meetingId: id.meeting(row.meetingKey),
            clientId: row.clientKey ? id.client(row.clientKey) : null,
            authorUserId: id.user(row.authorUserKey),
            bodyCiphertext: sealed.bodyCiphertext,
            iv: sealed.iv,
            authTag: sealed.authTag,
            keyVersion: sealed.keyVersion,
            confidential: row.confidential,
            accessLevel: row.accessLevel,
            status: row.status as 'generated' | 'edited' | 'approved',
          },
        });
        count += 1;
      }

      for (const row of plan.tasks) {
        await tx.engagementTask.create({
          data: {
            id: row.id,
            tenantId: id.tenant(row.tenantKey),
            clientId: row.clientKey ? id.client(row.clientKey) : null,
            meetingId: row.meetingKey ? id.meeting(row.meetingKey) : null,
            title: row.title,
            status: row.status,
            createdByUserId: id.user(row.createdByUserKey),
            sourceType: 'phase3_parity_fixture',
          },
        });
        count += 1;
      }

      for (const row of plan.attachments) {
        await tx.engagementAttachment.create({
          data: {
            id: row.id,
            tenantId: id.tenant(row.tenantKey),
            clientId: row.clientKey ? id.client(row.clientKey) : null,
            meetingId: row.meetingKey ? id.meeting(row.meetingKey) : null,
            fileName: row.fileName,
            contentType: row.contentType,
            byteSize: row.byteSize,
            bucket: row.bucket,
            s3Key: row.s3Key,
            lifecycleStatus: row.lifecycleStatus,
            scanStatus: row.scanStatus,
            uploadedByUserId: id.user(row.uploadedByUserKey),
            source: 'manual',
          },
        });
        count += 1;
      }

      for (const row of plan.connections) {
        await tx.integrationConnection.create({
          data: {
            id: row.id,
            tenantId: id.tenant(row.tenantKey),
            provider: row.provider,
            accountEmail: row.accountEmail,
            displayName: row.displayName,
            status: row.status,
            scopes: row.scopes,
            syncState: row.syncState as Prisma.InputJsonValue,
            lastSyncAt: when(row.lastSyncAt),
            lastError: row.lastError,
            createdByUserId: id.user('actor.admin'),
          },
        });
        count += 1;
      }

      for (const row of plan.outreachRecords) {
        await tx.outreachRecord.create({
          data: {
            id: row.id,
            tenantId: id.tenant(row.tenantKey),
            clientId: row.clientKey ? id.client(row.clientKey) : null,
            meetingId: row.meetingKey ? id.meeting(row.meetingKey) : null,
            createdByUserId: id.user(row.createdByUserKey),
            type: row.type,
            status: row.status,
            title: row.title,
            subject: row.subject,
            body: row.body,
            recipients: row.recipients as unknown as Prisma.InputJsonValue,
            recipientCount: row.recipients.length,
            lastStep: row.lastStep,
            sentAt: when(row.sentAt),
            openedInEmailAt: when(row.openedInEmailAt),
            metadata: {
              phase3ParityFixture: true,
              attachmentIds: row.attachmentKeys.map((key) => id.attachment(key)),
            },
          },
        });
        count += 1;
      }

      for (const row of plan.draftArtifacts) {
        await tx.outreachDraftArtifact.create({
          data: {
            id: row.id,
            tenantId: id.tenant(row.tenantKey),
            outreachRecordId: id.outreachRecord(row.outreachRecordKey),
            generationKey: row.generationKey,
            recipientKey: row.recipientKey,
            audienceKind: row.audienceKind,
            recipientSnapshot: { phase3ParityFixture: true, email: row.recipientKey },
            createdByUserId: id.user(row.createdByUserKey),
            currentVersion: row.currentVersion,
          },
        });
        count += 1;
      }

      for (const row of plan.draftVersions) {
        await tx.outreachDraftVersion.create({
          data: {
            id: row.id,
            tenantId: id.tenant(row.tenantKey),
            artifactId: id.draftArtifact(row.artifactKey),
            version: row.version,
            subject: row.subject,
            body: row.body,
            contentHash: sha256(`${row.subject}\n${row.body}`),
            generationStatus: row.generationStatus,
            auditStatus: row.auditStatus,
            approvalStatus: row.approvalStatus,
            auditMode: 'shadow',
            auditDecision: row.auditDecision,
            auditLedger: [],
            provider: row.provider,
            model: row.model,
            createdByUserId: id.user(row.createdByUserKey),
          },
        });
        count += 1;
      }

      for (const row of plan.sendIntents) {
        await tx.outreachSendIntent.create({
          data: {
            id: row.id,
            tenantId: id.tenant(row.tenantKey),
            userId: id.user(row.userKey),
            outreachRecordId: id.outreachRecord(row.outreachRecordKey),
            senderConnectionId: id.connection(row.senderConnectionKey),
            requestKey: row.requestKey,
            requestFingerprint: `sha256:${sha256(row.requestKey)}`,
            appendSignature: false,
            attachmentIds: [],
            testMode: false,
            status: row.status,
            totals: row.totals,
            startedAt: at({ kind: 'anchorOffset', minutes: -3 * 60 * 24 }),
            finishedAt: at({ kind: 'anchorOffset', minutes: -3 * 60 * 24 + 5 }),
          },
        });
        count += 1;
      }

      for (const row of plan.deliveries) {
        const envelope = { to: [{ email: row.toEmail, name: row.toName }], cc: [], bcc: [] };
        await tx.outreachDelivery.create({
          data: {
            id: row.id,
            tenantId: id.tenant(row.tenantKey),
            sendIntentId: id.sendIntent(row.sendIntentKey),
            draftVersionId: id.draftVersion(row.draftVersionKey),
            generationKey: row.generationKey,
            recipientKey: row.recipientKey,
            recipientEnvelope: envelope,
            idempotencyKey: sha256(`${row.id}|${row.draftVersionKey}|${row.toEmail}`),
            renderedSubject: row.renderedSubject,
            renderedBody: row.renderedBody,
            attachmentManifest: [],
            provider: row.provider,
            status: row.status,
            attempt: 1,
            providerMessageId: row.providerMessageId,
          },
        });
        count += 1;
      }

      for (const row of plan.audiences) {
        await tx.outreachAudience.create({
          data: {
            id: row.id,
            tenantId: id.tenant(row.tenantKey),
            createdByUserId: id.user(row.createdByUserKey),
            kind: row.kind,
            name: row.name,
            status: row.status,
            metadata: { phase3ParityFixture: true },
          },
        });
        count += 1;
      }

      for (const row of plan.audienceMembers) {
        await tx.outreachAudienceMember.create({
          data: {
            id: row.id,
            tenantId: id.tenant(row.tenantKey),
            audienceId: id.audience(row.audienceKey),
            source: row.source,
            name: row.name,
            email: row.email,
            office: row.office,
            metadata: { phase3ParityFixture: true },
          },
        });
        count += 1;
      }

      for (const row of plan.templates) {
        await tx.outreachTemplate.create({
          data: {
            id: row.id,
            tenantId: id.tenant(row.tenantKey),
            createdByUserId: id.user(row.createdByUserKey),
            type: row.type,
            name: row.name,
            subject: row.subject,
            body: row.body,
            metadata: { phase3ParityFixture: true },
          },
        });
        count += 1;
      }

      for (const row of plan.aiTemplates) {
        await tx.outreachAiTemplate.create({
          data: {
            id: row.id,
            tenantId: id.tenant(row.tenantKey),
            userId: id.user(row.userKey),
            name: row.name,
            category: row.category,
            prompt: row.prompt,
            metadata: { phase3ParityFixture: true },
          },
        });
        count += 1;
      }

      for (const row of plan.reportTargets) {
        const clientId = row.clientKey ? id.client(row.clientKey) : null;
        await tx.engagementReportTargetOffice.create({
          data: {
            id: row.id,
            tenantId: id.tenant(row.tenantKey),
            clientId,
            // reportScopeKey(clientId) is `clientId || 'all'` — engagement.service.ts.
            scopeKey: row.scopeKeyFrom === 'clientId' ? (clientId ?? 'all') : 'all',
            officeKey: row.officeKey,
            memberPrincipal: row.memberPrincipal,
            committee: row.committee,
            staffer: row.staffer,
            building: row.building,
            leadOwner: row.leadOwner,
            prepStatus: row.prepStatus,
            outreachStatus: row.outreachStatus,
            submissionStatus: row.submissionStatus,
            source: row.source,
            createdByUserId: id.user('actor.admin'),
          },
        });
        count += 1;
      }
    },
    { timeoutMs: 180_000 },
  );

  return count;
}

// ─── cleanup ────────────────────────────────────────────────────────────────

async function cleanup(prisma: PrismaService, plan: FixturePlan): Promise<number> {
  const tenantIds = plan.tenants.map((row) => row.id);
  const userIds = plan.users.map((row) => row.id);
  let deleted = 0;

  // One delete per table, in the plan's declared order. The map is exhaustive
  // over cleanupOrder — a table seeded without a delete entry throws below
  // rather than silently leaking rows into the next run.
  const deleters: Record<string, (tx: Prisma.TransactionClient) => Promise<{ count: number }>> = {
    outreach_deliveries: (tx) => tx.outreachDelivery.deleteMany({ where: { tenantId: { in: tenantIds } } }),
    outreach_send_intents: (tx) => tx.outreachSendIntent.deleteMany({ where: { tenantId: { in: tenantIds } } }),
    outreach_draft_versions: (tx) => tx.outreachDraftVersion.deleteMany({ where: { tenantId: { in: tenantIds } } }),
    outreach_draft_artifacts: (tx) => tx.outreachDraftArtifact.deleteMany({ where: { tenantId: { in: tenantIds } } }),
    outreach_records: (tx) => tx.outreachRecord.deleteMany({ where: { tenantId: { in: tenantIds } } }),
    outreach_audience_members: (tx) => tx.outreachAudienceMember.deleteMany({ where: { tenantId: { in: tenantIds } } }),
    outreach_audiences: (tx) => tx.outreachAudience.deleteMany({ where: { tenantId: { in: tenantIds } } }),
    outreach_templates: (tx) => tx.outreachTemplate.deleteMany({ where: { tenantId: { in: tenantIds } } }),
    outreach_ai_template: (tx) => tx.outreachAiTemplate.deleteMany({ where: { tenantId: { in: tenantIds } } }),
    engagement_report_target_offices: (tx) =>
      tx.engagementReportTargetOffice.deleteMany({ where: { tenantId: { in: tenantIds } } }),
    engagement_tasks: (tx) => tx.engagementTask.deleteMany({ where: { tenantId: { in: tenantIds } } }),
    engagement_attachments: (tx) => tx.engagementAttachment.deleteMany({ where: { tenantId: { in: tenantIds } } }),
    meeting_notes: (tx) => tx.meetingNote.deleteMany({ where: { tenantId: { in: tenantIds } } }),
    meeting_debriefs: (tx) => tx.meetingDebrief.deleteMany({ where: { tenantId: { in: tenantIds } } }),
    meeting_preps: (tx) => tx.meetingPrep.deleteMany({ where: { tenantId: { in: tenantIds } } }),
    meeting_bot_sessions: (tx) => tx.meetingBotSession.deleteMany({ where: { tenantId: { in: tenantIds } } }),
    meeting_attendees: (tx) => tx.meetingAttendee.deleteMany({ where: { tenantId: { in: tenantIds } } }),
    meetings: (tx) => tx.meeting.deleteMany({ where: { tenantId: { in: tenantIds } } }),
    engagement_contacts: (tx) => tx.engagementContact.deleteMany({ where: { tenantId: { in: tenantIds } } }),
    engagement_connection_tokens: (tx) =>
      tx.integrationConnectionToken.deleteMany({ where: { tenantId: { in: tenantIds } } }),
    engagement_connections: (tx) => tx.integrationConnection.deleteMany({ where: { tenantId: { in: tenantIds } } }),
    client_memory_access: (tx) => tx.clientMemoryAccess.deleteMany({ where: { tenantId: { in: tenantIds } } }),
    clients: (tx) => tx.client.deleteMany({ where: { tenantId: { in: tenantIds } } }),
    impersonation_sessions: (tx) => tx.impersonationSession.deleteMany({ where: { tenantId: { in: tenantIds } } }),
    tenant_memberships: (tx) => tx.tenantMembership.deleteMany({ where: { tenantId: { in: tenantIds } } }),
    users: (tx) => tx.user.deleteMany({ where: { id: { in: userIds } } }),
    tenants: (tx) => tx.tenant.deleteMany({ where: { id: { in: tenantIds } } }),
  };

  const missing = plan.cleanupOrder.filter((table) => !deleters[table]);
  if (missing.length) throw new Error(`cleanupOrder names tables with no deleter: ${missing.join(', ')}`);
  const extra = Object.keys(deleters).filter((table) => !plan.cleanupOrder.includes(table));
  if (extra.length) throw new Error(`deleters cover tables absent from cleanupOrder: ${extra.join(', ')}`);

  await prisma.withSystem(
    async (tx) => {
      for (const table of plan.cleanupOrder) {
        const result = await deleters[table]!(tx);
        deleted += result.count;
      }
    },
    { timeoutMs: 180_000 },
  );

  return deleted;
}

// ─── verify ─────────────────────────────────────────────────────────────────

async function verify(
  prisma: PrismaService,
  plan: FixturePlan,
  crypto: MeetingNotesCryptoService,
): Promise<void> {
  const tenantIds = plan.tenants.map((row) => row.id);
  const failures: string[] = [];

  await prisma.withSystem(async (tx) => {
    const check = async (label: string, expected: number, actual: Promise<number>) => {
      const value = await actual;
      if (value !== expected) failures.push(`${label}: expected ${expected}, found ${value}`);
    };
    const scoped = { tenantId: { in: tenantIds } };

    await check('tenants', plan.tenants.length, tx.tenant.count({ where: { id: { in: tenantIds } } }));
    await check('users', plan.users.length, tx.user.count({ where: { id: { in: plan.users.map((r) => r.id) } } }));
    await check('memberships', plan.memberships.length, tx.tenantMembership.count({ where: scoped }));
    await check('impersonations', plan.impersonations.length, tx.impersonationSession.count({ where: scoped }));
    await check('clients', plan.clients.length, tx.client.count({ where: scoped }));
    await check('clientMemoryAccess', plan.clientMemoryAccess.length, tx.clientMemoryAccess.count({ where: scoped }));
    await check('contacts', plan.contacts.length, tx.engagementContact.count({ where: scoped }));
    await check('meetings', plan.meetings.length, tx.meeting.count({ where: scoped }));
    await check('attendees', plan.attendees.length, tx.meetingAttendee.count({ where: scoped }));
    await check('botSessions', plan.botSessions.length, tx.meetingBotSession.count({ where: scoped }));
    await check('preps', plan.preps.length, tx.meetingPrep.count({ where: scoped }));
    await check('notes', plan.notes.length, tx.meetingNote.count({ where: scoped }));
    await check('debriefs', plan.debriefs.length, tx.meetingDebrief.count({ where: scoped }));
    await check('tasks', plan.tasks.length, tx.engagementTask.count({ where: scoped }));
    await check('attachments', plan.attachments.length, tx.engagementAttachment.count({ where: scoped }));
    await check('outreachRecords', plan.outreachRecords.length, tx.outreachRecord.count({ where: scoped }));
    await check('draftArtifacts', plan.draftArtifacts.length, tx.outreachDraftArtifact.count({ where: scoped }));
    await check('draftVersions', plan.draftVersions.length, tx.outreachDraftVersion.count({ where: scoped }));
    await check('sendIntents', plan.sendIntents.length, tx.outreachSendIntent.count({ where: scoped }));
    await check('deliveries', plan.deliveries.length, tx.outreachDelivery.count({ where: scoped }));
    await check('audiences', plan.audiences.length, tx.outreachAudience.count({ where: scoped }));
    await check('audienceMembers', plan.audienceMembers.length, tx.outreachAudienceMember.count({ where: scoped }));
    await check('templates', plan.templates.length, tx.outreachTemplate.count({ where: scoped }));
    await check('aiTemplates', plan.aiTemplates.length, tx.outreachAiTemplate.count({ where: scoped }));
    await check('reportTargets', plan.reportTargets.length, tx.engagementReportTargetOffice.count({ where: scoped }));
    await check('connections', plan.connections.length, tx.integrationConnection.count({ where: scoped }));

    // "No provider credential" is a checkable invariant, not a claim.
    await check('connectionTokens', 0, tx.integrationConnectionToken.count({ where: scoped }));

    // The absence fixtures must genuinely resolve to nothing.
    for (const absent of plan.absentIds) {
      if (absent.key === 'absent.meeting') {
        await check(`absent ${absent.key}`, 0, tx.meeting.count({ where: { id: absent.id } }));
      }
      if (absent.key === 'absent.outreachRecord') {
        await check(`absent ${absent.key}`, 0, tx.outreachRecord.count({ where: { id: absent.id } }));
      }
      if (absent.key === 'absent.connection') {
        await check(`absent ${absent.key}`, 0, tx.integrationConnection.count({ where: { id: absent.id } }));
      }
    }

    // The second tenant renders the empty Outreach list and the empty
    // Integrations page — both are absence states, so assert the absence.
    const secondary = plan.tenants.find((row) => row.key === 'tenant.secondary')!.id;
    await check('secondary tenant outreach records', 0, tx.outreachRecord.count({ where: { tenantId: secondary } }));
    await check('secondary tenant connections', 0, tx.integrationConnection.count({ where: { tenantId: secondary } }));

    // Every encrypted body must decrypt back to its declared plaintext. A row
    // count alone would pass with ciphertext the reading code cannot open, which
    // is the failure mode that would make 3.6's "notes encryption unavailable"
    // edge state indistinguishable from a broken fixture.
    for (const row of plan.notes) {
      const stored = await tx.meetingNote.findUnique({ where: { id: row.id } });
      if (!stored) {
        failures.push(`note ${row.key}: row missing`);
        continue;
      }
      const opened = tryDecrypt(crypto, stored);
      if (opened !== row.bodyPlaintext) {
        failures.push(`note ${row.key}: body did not decrypt to its declared plaintext`);
      }
    }
    for (const row of plan.debriefs) {
      const stored = await tx.meetingDebrief.findUnique({ where: { id: row.id } });
      if (!stored) {
        failures.push(`debrief ${row.key}: row missing`);
        continue;
      }
      const opened = tryDecrypt(crypto, stored);
      if (opened !== row.bodyPlaintext) {
        failures.push(`debrief ${row.key}: body did not decrypt to its declared plaintext`);
      }
    }
  });

  if (failures.length) {
    for (const failure of failures) console.error(`MISMATCH  ${failure}`);
    throw new Error(`${failures.length} fixture verification failure(s).`);
  }
}

// ─── helpers ────────────────────────────────────────────────────────────────

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function tryDecrypt(
  crypto: MeetingNotesCryptoService,
  row: { bodyCiphertext: string; iv: string; authTag: string },
): string | null {
  try {
    return crypto.decrypt(row);
  } catch {
    return null;
  }
}

/** Key → id lookups that throw on an unknown key rather than writing a null FK. */
function buildKeyResolver(plan: FixturePlan) {
  const index = (rows: ReadonlyArray<{ key: string; id: string }>, kind: string) => {
    const map = new Map(rows.map((row) => [row.key, row.id]));
    return (key: string): string => {
      const id = map.get(key);
      if (!id) throw new Error(`Unknown ${kind} fixture key: ${key}`);
      return id;
    };
  };
  return {
    tenant: index(plan.tenants, 'tenant'),
    user: index(plan.users, 'user'),
    client: index(plan.clients, 'client'),
    contact: index(plan.contacts, 'contact'),
    meeting: index(plan.meetings, 'meeting'),
    attachment: index(plan.attachments, 'attachment'),
    outreachRecord: index(plan.outreachRecords, 'outreach record'),
    draftArtifact: index(plan.draftArtifacts, 'draft artifact'),
    draftVersion: index(plan.draftVersions, 'draft version'),
    sendIntent: index(plan.sendIntents, 'send intent'),
    connection: index(plan.connections, 'connection'),
    audience: index(plan.audiences, 'audience'),
  };
}

/** What a browser harness needs: keys, ids, and the anchor they were built from. */
function buildFixtureIndex(plan: FixturePlan, anchor: Date): Record<string, unknown> {
  const ids: Record<string, string> = {};
  for (const rows of Object.values(plan)) {
    if (!Array.isArray(rows)) continue;
    for (const row of rows) {
      if (row && typeof row === 'object' && 'key' in row && 'id' in row) {
        ids[String((row as { key: unknown }).key)] = String((row as { id: unknown }).id);
      }
    }
  }
  return {
    marker: plan.marker,
    anchor: anchor.toISOString(),
    ids,
    states: plan.states.map((state) => ({
      id: state.id,
      planSection: state.planSection,
      requirement: state.requirement,
      requires: state.requires ?? null,
    })),
  };
}

// Only run when invoked as a CLI. The spec imports this module for its pure
// helpers, and must not trigger a database connection by doing so.
if (require.main === module) {
  main().catch((error) => {
    console.error(`Phase 3 fixture seed failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}

export { apply, cleanup, verify, assertDisposableDatabase, CONTRACT_PATH, REMOTE_DB_ACK };
