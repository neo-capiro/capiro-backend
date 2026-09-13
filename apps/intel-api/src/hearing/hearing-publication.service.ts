import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { OrchestratorClient } from './orchestrator.client.js';
import { ClientBriefContextClient } from './client-brief-context.client.js';
import { publicReviewCapture, publicReviewEvidence } from './public-hearing-review-source.js';
import { randomUUID } from 'node:crypto';
import type {
  Prisma,
  HearingPublication,
  LegiWatchDelivery,
} from '../../generated/prisma-client/index.js';
import type { WorkspaceTenantContext } from '../auth/tenant-context.js';
import { ReportService } from '../tracker/reports/report.service.js';
import {
  ReportRecipientsService,
  type RecipientSnapshot,
} from '../tracker/reports/recipients.service.js';
import { digest, escapeHtml, ids, json, object, text } from '../tracker/reports/report-domain.js';
import {
  HEARING_UPDATES_FEATURE,
  HEARING_RECAPS_FEATURE,
  HEARING_SMS_FEATURE,
} from '../feature-flags/feature-flag.service.js';
import { smsSize } from '../tracker/sms/sms.service.js';
import { HEARING_SMS_CONSENT_VERSION } from '../tracker/sms/sms-verification.service.js';
import { HearingSessionService } from './hearing-session.service.js';
import { HearingCryptoService } from './hearing-crypto.service.js';
import {
  evidenceHash,
  hearingBillMentions,
  publicationMarkdown,
  validateHearingClaims,
  type HearingClaim,
  type HearingEvidence,
  type HearingPublicationPayload,
} from './publication-domain.js';

export const publicationFeature = (kind: string) =>
  kind === 'live_update' ? HEARING_UPDATES_FEATURE : HEARING_RECAPS_FEATURE;
export type HearingSmsRecipient = RecipientSnapshot & {
  phone: string;
  consentId: string;
  verificationId: string;
};
export type HearingInboxRecipient = RecipientSnapshot & { userId: string };
const smsRecipientHash = (r: HearingSmsRecipient) =>
  digest([
    r.phone,
    r.consentId,
    r.verificationId,
    r.email,
    r.name,
    r.role,
    r.manual,
    r.contacts.map((c) => [c.id, c.version]).sort(),
    r.lists.map((l) => [l.id, l.version]).sort(),
  ]);
export function publicationSms(payload: HearingPublicationPayload) {
  return `Capiro unofficial hearing ${payload.kind === 'hearing_recap' ? 'recap' : 'update'}: ${payload.claims.map((c) => (c.kind === 'analysis' ? 'Analysis: ' : '') + c.text).join(' ')} Reply STOP to opt out.`;
}

/** The existing report dispatcher owns delivery. This service owns frozen facts. */
@Injectable()
export class HearingPublicationService {
  constructor(
    readonly reports: ReportService,
    readonly recipients: ReportRecipientsService,
    readonly sessions: HearingSessionService,
    readonly crypto: HearingCryptoService,
    @Optional() readonly orchestrator?: OrchestratorClient,
    @Optional() readonly clientContext?: ClientBriefContextClient,
  ) {}

  actor<T>(ctx: WorkspaceTenantContext, fn: (tx: Prisma.TransactionClient) => Promise<T>) {
    return this.reports.folders.withActor(ctx, async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.hearing_actor',${ctx.clerkUserId},true)`;
      return fn(tx);
    });
  }
  async authorize(ctx: WorkspaceTenantContext, sessionId: string, kind: string) {
    if (!['live_update', 'hearing_recap'].includes(kind))
      throw new BadRequestException('HEARING_PUBLICATION_KIND_REQUIRED');
    await this.reports.authorize(ctx, publicationFeature(kind));
    const session = await this.sessions.getAccessible(ctx.tenantId, sessionId, ctx.clerkUserId);
    if (session.recordingPolicy === 'no_storage')
      throw new ForbiddenException('NO_STORAGE_SESSION');
    if (session.publicCaptureId) await this.actor(ctx, (tx) => this.publicSource(tx, ctx, session));
    await this.requireAnalysis(ctx, session);
    return session;
  }
  private async publicSource(
    tx: Prisma.TransactionClient,
    ctx: WorkspaceTenantContext,
    session: {
      publicCaptureId: string | null;
      hearingId: string | null;
      createdBy: string;
      sourceUrl: string | null;
    },
  ) {
    if (!session.publicCaptureId || !session.hearingId || session.createdBy !== ctx.clerkUserId)
      throw new ForbiddenException('REVIEW_CONTEXT_OWNER_REQUIRED');
    const capture = await publicReviewCapture(tx, ctx, session.hearingId, session.publicCaptureId);
    if (capture.sourceUrl !== session.sourceUrl)
      throw new ForbiddenException('REVIEW_SOURCE_CHANGED');
    return capture;
  }
  async openPublicReview(ctx: WorkspaceTenantContext, hearingId: string, kind: string) {
    if (!['live_update', 'hearing_recap'].includes(kind))
      throw new BadRequestException('HEARING_PUBLICATION_KIND_REQUIRED');
    await this.reports.authorize(ctx, publicationFeature(kind));
    return this.actor(ctx, async (tx) => {
      const capture = await publicReviewCapture(tx, ctx, hearingId);
      const row = await tx.liveHearingSession.upsert({
        where: {
          tenantId_createdBy_publicCaptureId: {
            tenantId: ctx.tenantId,
            createdBy: ctx.clerkUserId,
            publicCaptureId: capture.id,
          },
        },
        update: {},
        create: {
          tenantId: ctx.tenantId,
          createdBy: ctx.clerkUserId,
          publicCaptureId: capture.id,
          hearingId,
          title: capture.title,
          sourceUrl: capture.sourceUrl,
          sourceType: 'hearing',
          audioSource: 'stream_url',
          status: 'ended',
          consentStatus: 'not_required',
          recordingPolicy: 'transcript_only',
          issueIds: [],
          billIds: [],
          programElementIds: [],
          agencyIds: [],
        },
      });
      if (row.sourceUrl !== capture.sourceUrl)
        throw new ForbiddenException('REVIEW_SOURCE_CHANGED');
      return { sessionId: row.id, hearingId, title: row.title, captureId: capture.id };
    });
  }
  private decode(row: HearingPublication): HearingPublicationPayload {
    const payload = object(row.payload);
    const value = JSON.parse(
      this.crypto.decrypt({
        textCiphertext: String(payload.textCiphertext),
        iv: String(payload.iv),
        authTag: String(payload.authTag),
      }),
    );
    if (digest(value) !== row.contentHash)
      throw new ConflictException('PUBLICATION_CONTENT_INTEGRITY_FAILED');
    return value;
  }
  async get(
    tx: Prisma.TransactionClient,
    ctx: WorkspaceTenantContext,
    id: string,
    sessionId?: string,
  ) {
    const row = await tx.hearingPublication.findFirst({
      where: {
        tenantId: ctx.tenantId,
        id,
        ownerClerkId: ctx.clerkUserId,
        ...(sessionId ? { sessionId } : {}),
      },
    });
    if (!row) throw new NotFoundException('HEARING_PUBLICATION_NOT_FOUND');
    return { row, payload: this.decode(row) };
  }
  async list(ctx: WorkspaceTenantContext, sessionId: string, kind: string) {
    await this.authorize(ctx, sessionId, kind);
    return this.actor(ctx, async (tx) => {
      const rows = await tx.hearingPublication.findMany({
        where: { tenantId: ctx.tenantId, sessionId, kind, ownerClerkId: ctx.clerkUserId },
        orderBy: { createdAt: 'desc' },
        take: 50,
      });
      return rows.map((row) => ({
        id: row.id,
        seriesId: row.seriesId,
        version: row.version,
        status: row.status,
        contentHash: row.contentHash,
        createdAt: row.createdAt,
        approvedAt: row.approvedAt,
        supersedesId: row.supersedesId,
        payload: this.decode(row),
      }));
    });
  }
  async version(ctx: WorkspaceTenantContext, sessionId: string, id: string) {
    const target = await this.actor(ctx, (tx) => this.get(tx, ctx, id, sessionId));
    await this.authorize(ctx, sessionId, target.row.kind);
    return {
      id: target.row.id,
      kind: target.row.kind,
      version: target.row.version,
      status: target.row.status,
      contentHash: target.row.contentHash,
      payload: target.payload,
    };
  }
  async candidates(ctx: WorkspaceTenantContext, sessionId: string, kind: string) {
    const session = await this.authorize(ctx, sessionId, kind);
    return this.actor(ctx, async (tx) => {
      if (session.publicCaptureId) {
        await this.publicSource(tx, ctx, session);
        const evidence = (await publicReviewEvidence(tx, session.publicCaptureId)).slice(-100);
        return {
          evidence,
          candidates: [],
          selection:
            'Latest 100 persisted final passages from the canonical server capture. Select evidence before creating a reviewed version.',
        };
      }
      const rows = await tx.transcriptSegment.findMany({
        where: { tenantId: ctx.tenantId, sessionId, isFinal: true },
        orderBy: [{ startMs: 'desc' }, { id: 'desc' }],
        take: 100,
      });
      const evidence = rows.length
        ? await this.evidence(
            tx,
            ctx,
            sessionId,
            rows.map((row) => row.id),
          )
        : [];
      const cards = await tx.liveSummaryCard.findMany({
        where: {
          tenantId: ctx.tenantId,
          sessionId,
          segmentId: {
            in: rows.filter((row) => row.analysisState === 'ready').map((row) => row.id),
          },
        },
        orderBy: { startMs: 'desc' },
        take: 100,
      });
      const reveal = (
        plain: string | null,
        cipher: string | null,
        iv: string | null,
        authTag: string | null,
      ) =>
        cipher && iv && authTag
          ? this.crypto.decrypt({ textCiphertext: cipher, iv, authTag })
          : (plain ?? '');
      return {
        evidence,
        candidates: cards.map((card) => ({
          id: card.id,
          kind: 'analysis',
          title: reveal(card.title, card.titleCiphertext, card.titleIv, card.titleAuthTag),
          text: reveal(card.body, card.bodyCiphertext, card.bodyIv, card.bodyAuthTag),
          evidenceIds: [card.segmentId],
          startMs: card.startMs,
        })),
        selection:
          'Latest 100 persisted final transcript passages. Select evidence before creating a reviewed version.',
      };
    });
  }
  async deliveryHistory(ctx: WorkspaceTenantContext, sessionId: string, id: string) {
    const target = await this.actor(ctx, (tx) => this.get(tx, ctx, id, sessionId));
    await this.authorize(ctx, sessionId, target.row.kind);
    return this.actor(ctx, async (tx) => {
      const rows = await tx.legiWatchDelivery.findMany({
        where: {
          tenantId: ctx.tenantId,
          ownerClerkId: ctx.clerkUserId,
          composition: { path: ['publicationId'], equals: id },
        },
        orderBy: { approvedAt: 'desc' },
        take: 50,
        include: { recipients: true },
      });
      return rows.map((row) => ({
        id: row.id,
        approvedAt: row.approvedAt,
        contentHash: row.contentHash,
        recipients: row.recipients.map((recipient) => {
          const snapshot = object(recipient.recipient);
          return {
            id: recipient.id,
            channel: recipient.channel,
            state: recipient.state,
            name: String(snapshot.name ?? ''),
            destination:
              recipient.channel === 'sms'
                ? '••• ••• ' + String(snapshot.phone ?? '').slice(-4)
                : String(snapshot.email ?? ''),
            providerId: recipient.providerId,
            acceptedAt: recipient.acceptedAt,
            error: recipient.error,
          };
        }),
      }));
    });
  }
  async approvedDocument(
    ctx: WorkspaceTenantContext,
    sessionId: string,
    id: string,
    contentHash: string,
  ) {
    await this.authorize(ctx, sessionId, 'hearing_recap');
    return this.actor(ctx, async (tx) => {
      const { row, payload } = await this.get(tx, ctx, id, sessionId);
      if (
        row.kind !== 'hearing_recap' ||
        row.status !== 'approved' ||
        row.contentHash !== contentHash ||
        !payload.clientId
      )
        throw new ConflictException('APPROVED_CLIENT_RECAP_VERSION_REQUIRED');
      const session = await this.recheck(tx, ctx, row, payload);
      const grants = await tx.$queryRaw<
        Array<{ id: string }>
      >`SELECT id FROM intel_hearing_media_permission
        WHERE tenant_id=${ctx.tenantId} AND source_url=${session.sourceUrl ?? ''} AND hearing_id IS NOT DISTINCT FROM ${session.hearingId}::text
          AND mode=${session.publicCaptureId ? 'server' : 'browser'} AND revoked_at IS NULL AND expires_at>clock_timestamp() AND operations @> ARRAY['analysis','distribution']::text[] LIMIT 1 FOR SHARE`;
      if (!grants.length) throw new ForbiddenException('SOURCE_DISTRIBUTION_PERMISSION_REQUIRED');
      return {
        schema: 'legiwatch.approved-recap-document.v1',
        tenantId: ctx.tenantId,
        sessionId,
        clientId: payload.clientId,
        publicationId: row.id,
        contentHash: row.contentHash,
        version: row.version,
        title: payload.title,
        approvedAt: row.approvedAt,
        markdown:
          publicationMarkdown(payload) +
          `\n\nApproved recap version ${row.version}\nPublication: ${row.id}\nContent SHA-256: ${row.contentHash}\n`,
      };
    });
  }
  private async evidence(
    tx: Prisma.TransactionClient,
    ctx: WorkspaceTenantContext,
    sessionId: string,
    segmentIds: string[],
  ) {
    if (!segmentIds.length || segmentIds.length > 500)
      throw new BadRequestException('SELECT_1_TO_500_FINAL_SEGMENTS');
    const session = await tx.liveHearingSession.findFirst({
      where: { tenantId: ctx.tenantId, id: sessionId },
    });
    if (session?.publicCaptureId) {
      await this.publicSource(tx, ctx, session);
      return publicReviewEvidence(tx, session.publicCaptureId, segmentIds);
    }
    const rows = await tx.transcriptSegment.findMany({
      where: { tenantId: ctx.tenantId, sessionId, id: { in: segmentIds }, isFinal: true },
      orderBy: [{ startMs: 'asc' }, { id: 'asc' }],
    });
    if (rows.length !== segmentIds.length)
      throw new BadRequestException('FINAL_TRANSCRIPT_EVIDENCE_REQUIRED');
    return rows.map((row) => {
      const value =
        row.textCiphertext && row.iv && row.authTag
          ? this.crypto.decrypt({
              textCiphertext: row.textCiphertext,
              iv: row.iv,
              authTag: row.authTag,
            })
          : row.textPlain;
      if (!value) throw new ConflictException('TRANSCRIPT_EVIDENCE_UNAVAILABLE');
      const evidence = {
        segmentId: row.id,
        text: value,
        startMs: row.startMs,
        endMs: row.endMs,
        speakerLabel: row.speakerLabel,
      };
      return { ...evidence, hash: evidenceHash(evidence) };
    });
  }
  async create(
    ctx: WorkspaceTenantContext,
    sessionId: string,
    input: unknown,
    provenance?: HearingPublicationPayload['provenance'],
    generatedFolders?: HearingPublicationPayload['folders'],
  ) {
    const body = object(input),
      kind = text(body.kind, 30);
    const session = await this.authorize(ctx, sessionId, kind);
    await this.requireAnalysis(ctx, session);
    const clientId =
      typeof body.clientId === 'string' ? text(body.clientId, 100) : session.clientId;
    if (clientId)
      await this.reports.folders.validateReferences(ctx, { name: 'Hearing publication', clientId });
    const folderIds = ids(body.folderIds ?? []);
    if (folderIds.length > 20) throw new BadRequestException('MAX_20_PUBLICATION_FOLDERS');
    const segmentIds = ids(body.evidenceIds);
    const claims: HearingClaim[] = (Array.isArray(body.claims) ? body.claims : []).map((value) => {
      const claim = object(value);
      return {
        id: text(claim.id, 100),
        kind: text(claim.kind, 20) as HearingClaim['kind'],
        text: text(claim.text, 2500),
        evidenceIds: ids(claim.evidenceIds),
      };
    });
    const event = session.hearingId
      ? await this.reports.folders.prisma.$queryRaw<
          Array<{ jurisdiction: string | null; legislativeSession: string | null }>
        >`
      SELECT geographic_jurisdiction AS jurisdiction,legislative_session AS "legislativeSession"
      FROM committee_hearing WHERE id=${session.hearingId} AND visibility='public'`
      : [];
    const jurisdiction = event[0]?.jurisdiction ?? null,
      legislativeSession = event[0]?.legislativeSession ?? null;
    return this.actor(ctx, async (tx) => {
      const evidence = await this.evidence(tx, ctx, sessionId, segmentIds);
      validateHearingClaims(claims, evidence);
      const folders = [];
      for (const id of folderIds) {
        const folder = await this.reports.folders.folder(tx, ctx, id);
        if (folder.archived || !folder.ownerClerkId || folder.clientId !== clientId)
          throw new ForbiddenException('FOLDER_CLIENT_SCOPE_CHANGED');
        const generated = generatedFolders?.find((ref) => ref.id === id);
        if (generated && generated.version !== folder.version)
          throw new ConflictException('FOLDER_CONTEXT_CHANGED_REGENERATE');
        if (generated?.assignments)
          for (const ref of generated.assignments) {
            const assignment = await tx.legiWatchFolderBill.findFirst({
              where: { tenantId: ctx.tenantId, folderId: id, id: ref.id, version: ref.version },
            });
            if (!assignment) throw new ConflictException('FOLDER_CONTEXT_CHANGED_REGENERATE');
          }
        folders.push({
          id,
          version: folder.version,
          clientId: folder.clientId,
          ...(generated?.assignments ? { assignments: generated.assignments } : {}),
        });
      }
      const mentions = hearingBillMentions(evidence.map((e) => e.text).join('\n'), jurisdiction);
      const resolved =
        jurisdiction && legislativeSession && mentions.length
          ? await this.reports.folders.source.resolve(jurisdiction, legislativeSession, mentions)
          : [];
      const uniqueNumbers = new Map<string, number>();
      for (const bill of resolved)
        uniqueNumbers.set(bill.number, (uniqueNumbers.get(bill.number) ?? 0) + 1);
      const bills = resolved
        .filter((b) => uniqueNumbers.get(b.number) === 1)
        .map(({ id, number, jurisdiction, sessionKey }) => ({
          id,
          number,
          jurisdiction,
          sessionKey,
        }));
      const media = await tx.hearingRecording.findFirst({
        where: { tenantId: ctx.tenantId, sessionId },
        include: { epochs: true },
      });
      const missing: string[] = [];
      if (!jurisdiction || !legislativeSession)
        missing.push(
          'Jurisdiction or legislative session is unresolved; bill references cannot drive automatic alerts.',
        );
      if (!media) missing.push('This transcript has no retained audio.');
      if (media?.state !== 'ready')
        missing.push('Recording coverage is partial, still processing, or unavailable.');
      if (media?.transcriptState !== 'finalized')
        missing.push('Final transcript coverage is incomplete or still arriving.');
      if (session.status !== 'ended') missing.push('The hearing capture has not finalized.');
      let total = await tx.transcriptSegment.count({
        where: { tenantId: ctx.tenantId, sessionId, isFinal: true },
      });
      let coverage: HearingPublicationPayload['coverage'] = {
        audio: media ? (media.expiresAt <= new Date() ? 'expired' : media.state) : 'not_retained',
        transcript: media?.transcriptState ?? 'coverage_unknown',
        recordingId: media?.id ?? null,
        missing,
      };
      if (session.publicCaptureId) {
        const capture = await this.publicSource(tx, ctx, session);
        const epochs = await this.reports.folders.prisma.withSystem(
          (system) => system.$queryRaw<
            Array<{
              state: string;
              transcript_state: string;
              start_ms: bigint;
              durable_end_ms: bigint;
              expires_at: Date;
            }>
          >`
          SELECT state,transcript_state,start_ms,durable_end_ms,expires_at FROM intel_public_hearing_audio_epoch
          WHERE capture_id=${capture.id}::uuid AND source_url=${capture.sourceUrl} ORDER BY start_ms LIMIT 100`,
        );
        missing.splice(0);
        if (!jurisdiction || !legislativeSession)
          missing.push(
            'Jurisdiction or legislative session is unresolved; bill references cannot drive automatic alerts.',
          );
        if (capture.status !== 'COMPLETE')
          missing.push(`Canonical capture status: ${capture.status}. Coverage may be incomplete.`);
        for (const gap of (Array.isArray(capture.gaps) ? capture.gaps : []).slice(0, 100)) {
          if (gap && typeof gap === 'object' && 'startMs' in gap && 'endMs' in gap)
            missing.push(
              `No transcript covers ${Number(gap.startMs)}–${Number(gap.endMs)} ms (${String(gap.reason ?? 'capture gap')}).`,
            );
        }
        let previousEnd = 0;
        for (const epoch of epochs) {
          if (Number(epoch.start_ms) > previousEnd)
            missing.push(`No saved audio covers ${previousEnd}–${Number(epoch.start_ms)} ms.`);
          previousEnd = Math.max(previousEnd, Number(epoch.durable_end_ms));
        }
        const audio = !epochs.length
          ? 'not_retained'
          : epochs.every((e) => e.expires_at <= new Date())
            ? 'expired'
            : epochs.every((e) => e.state === 'ready' && e.expires_at > new Date())
              ? 'ready'
              : 'partial';
        const transcript =
          epochs.length &&
          epochs.every((e) => e.transcript_state === 'finalized') &&
          capture.status === 'COMPLETE'
            ? 'finalized'
            : 'partial';
        if (audio !== 'ready')
          missing.push('Retained server audio is incomplete, unavailable, or expired.');
        if (transcript !== 'finalized')
          missing.push('Final transcript coverage is incomplete or still arriving.');
        total = Number(
          (
            await tx.$queryRaw<
              Array<{ count: bigint }>
            >`SELECT count(*) FROM public_hearing_transcript_segment WHERE capture_id=${capture.id} AND is_final`
          )[0]?.count ?? 0,
        );
        coverage = { audio, transcript, recordingId: null, captureId: capture.id, missing };
      }
      if (evidence.length < total)
        missing.push(`This version cites ${evidence.length} of ${total} persisted final segments.`);
      const payload: HearingPublicationPayload = {
        schema: 'legiwatch.hearing-publication.v1',
        kind: kind as HearingPublicationPayload['kind'],
        title: text(body.title, 200),
        label:
          kind === 'hearing_recap'
            ? 'Unofficial transcript-based hearing recap'
            : 'Unofficial transcript-based hearing update',
        sessionId,
        hearingId: session.hearingId,
        clientId,
        jurisdiction,
        legislativeSession,
        folders,
        bills,
        claims,
        evidence,
        coverage,
        provenance: provenance ?? {
          tool: 'staff_reviewed_evidence',
          promptVersion: 'hearing-publication-v1',
          model: null,
        },
      };
      if (JSON.stringify(payload).length > 250000)
        throw new BadRequestException('PUBLICATION_EVIDENCE_TOO_LARGE');
      let seriesId: string = randomUUID(),
        version = 1,
        supersedesId: string | null = null;
      if (typeof body.supersedesId === 'string') {
        const previous = await this.get(tx, ctx, body.supersedesId, sessionId);
        if (previous.row.kind !== kind) throw new BadRequestException('CORRECTION_KIND_MISMATCH');
        seriesId = previous.row.seriesId;
        supersedesId = previous.row.id;
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${ctx.tenantId + ':' + seriesId},0))`;
        const latest = await tx.hearingPublication.aggregate({
          where: { tenantId: ctx.tenantId, seriesId },
          _max: { version: true },
        });
        version = (latest._max.version ?? 0) + 1;
      }
      const row = await tx.hearingPublication.create({
        data: {
          tenantId: ctx.tenantId,
          sessionId,
          ownerClerkId: ctx.clerkUserId,
          seriesId,
          version,
          kind,
          supersedesId,
          contentHash: digest(payload),
          payload: json(this.crypto.encrypt(JSON.stringify(payload))),
        },
      });
      return {
        id: row.id,
        version: row.version,
        contentHash: row.contentHash,
        status: row.status,
        payload,
      };
    });
  }
  async generate(ctx: WorkspaceTenantContext, sessionId: string, input: unknown) {
    const body = object(input),
      kind = text(body.kind, 30),
      session = await this.authorize(ctx, sessionId, kind);
    await this.requireAnalysis(ctx, session);
    const clientId =
      typeof body.clientId === 'string' ? text(body.clientId, 100) : session.clientId;
    if (clientId)
      await this.reports.folders.validateReferences(ctx, { name: 'Hearing publication', clientId });
    const evidence = await this.actor(ctx, (tx) =>
      this.evidence(tx, ctx, sessionId, ids(body.evidenceIds)),
    );
    if (JSON.stringify(evidence).length > 200000)
      throw new BadRequestException('SELECT_A_SMALLER_EVIDENCE_RANGE');
    const event = session.hearingId
      ? await this.reports.folders.prisma.$queryRaw<
          Array<{ jurisdiction: string | null; legislativeSession: string | null }>
        >`
      SELECT geographic_jurisdiction AS jurisdiction,legislative_session AS "legislativeSession" FROM committee_hearing WHERE id=${session.hearingId} AND visibility='public'`
      : [];
    const profiles = clientId
      ? await this.reports.folders.prisma.withSystem(
          (tx) =>
            tx.$queryRaw<
              Array<{ name: string }>
            >`SELECT name FROM clients WHERE tenant_id=${ctx.tenantId}::uuid AND id=${clientId}::uuid`,
        )
      : [];
    const profile = profiles[0];
    const context = clientId
      ? await this.clientContext?.fetch({
          tenantId: ctx.tenantId,
          clientId,
          hearingId: session.hearingId,
        })
      : null;
    const jurisdiction = event[0]?.jurisdiction ?? null,
      legislativeSession = event[0]?.legislativeSession ?? null;
    const mentions = hearingBillMentions(evidence.map((row) => row.text).join('\n'), jurisdiction);
    const bills =
      jurisdiction && legislativeSession && mentions.length
        ? await this.reports.folders.source.resolve(jurisdiction, legislativeSession, mentions)
        : [];
    const folderIds = ids(body.folderIds ?? []);
    if (folderIds.length > 20) throw new BadRequestException('MAX_20_PUBLICATION_FOLDERS');
    const selectedFolders = await this.actor(ctx, async (tx) => {
      const result = [];
      for (const id of folderIds) {
        const folder = await this.reports.folders.folder(tx, ctx, id);
        if (folder.archived || !folder.ownerClerkId || folder.clientId !== clientId)
          throw new ForbiddenException('FOLDER_CLIENT_SCOPE_CHANGED');
        const assignments = await tx.legiWatchFolderBill.findMany({
          where: {
            tenantId: ctx.tenantId,
            folderId: id,
            billId: { in: bills.map((b) => b.id) },
            jurisdiction: jurisdiction ?? '',
            sessionKey: legislativeSession ?? '',
          },
          orderBy: { id: 'asc' },
          take: 101,
        });
        if (assignments.length > 100) throw new BadRequestException('FOLDER_CONTEXT_TOO_LARGE');
        result.push({
          reference: {
            id,
            version: folder.version,
            clientId: folder.clientId,
            assignments: assignments.map((a) => ({ id: a.id, version: a.version })),
          },
          context: {
            id,
            name: folder.name,
            jurisdiction: folder.jurisdiction,
            session: folder.defaultSession,
            bills: assignments.map((a) => ({
              id: a.billId,
              number: bills.find((b) => b.id === a.billId)!.number,
              position: a.position,
              importance: a.importance,
              topPriority: a.topPriority,
              externalComments: a.externalComments.slice(0, 2000),
            })),
          },
        });
      }
      return result;
    });
    const draft = await this.orchestrator?.summarizeHearing({
      tenantId: ctx.tenantId,
      clerkUserId: ctx.clerkUserId,
      sessionId,
      title: session.title,
      evidence,
      jurisdiction: event[0]?.jurisdiction,
      legislativeSession: event[0]?.legislativeSession,
      publicationKind: kind as 'live_update' | 'hearing_recap',
      folderContext: selectedFolders.map((f) => f.context),
      quotes: [],
      mentions: [],
      actionItems: [],
      ...(clientId
        ? {
            client: {
              clientId,
              name: context?.clientName ?? profile?.name ?? null,
              relevance: context?.relevance ?? null,
            },
          }
        : {}),
    });
    if (!draft?.claims?.length || draft.promptVersion !== 'hearing-evidence-v1')
      throw new ServiceUnavailableException(
        'MERI_EVIDENCE_RECAP_UNAVAILABLE_CREATE_A_QUOTE_DRAFT_OR_RETRY',
      );
    validateHearingClaims(draft.claims, evidence);
    const current = await this.actor(ctx, (tx) =>
      this.evidence(
        tx,
        ctx,
        sessionId,
        evidence.map((e) => e.segmentId),
      ),
    );
    if (
      evidence.some(
        (e) => !current.some((now) => now.segmentId === e.segmentId && now.hash === e.hash),
      )
    )
      throw new ConflictException('EVIDENCE_CHANGED_REGENERATE');
    return this.create(
      ctx,
      sessionId,
      { ...body, clientId, title: session.title, claims: draft.claims },
      {
        tool: 'generate_post_hearing_summary',
        promptVersion: draft.promptVersion,
        model: null,
        clientContext: draft.clientContext ?? (clientId ? 'unavailable' : 'none'),
        folderContextHash: digest(selectedFolders.map((f) => f.context)),
      },
      selectedFolders.map((f) => f.reference),
    );
  }
  private async requireAnalysis(
    ctx: WorkspaceTenantContext,
    session: {
      hearingId: string | null;
      sourceUrl: string | null;
      publicCaptureId?: string | null;
    },
  ) {
    const grants = await this.reports.folders.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.hearingMediaPermission.count({
        where: {
          tenantId: ctx.tenantId,
          hearingId: session.hearingId,
          sourceUrl: session.sourceUrl ?? '',
          mode: session.publicCaptureId ? 'server' : 'browser',
          revokedAt: null,
          expiresAt: { gt: new Date() },
          operations: { has: 'analysis' },
        },
      }),
    );
    if (!grants) throw new ForbiddenException('SOURCE_ANALYSIS_PERMISSION_REQUIRED');
  }
  async recheck(
    tx: Prisma.TransactionClient,
    ctx: WorkspaceTenantContext,
    row: HearingPublication,
    payload: HearingPublicationPayload,
  ) {
    await tx.$queryRaw`SELECT id FROM intel_live_hearing_session WHERE tenant_id=${ctx.tenantId} AND id=${row.sessionId} FOR SHARE`;
    const session = await tx.liveHearingSession.findFirst({
      where: { tenantId: ctx.tenantId, id: row.sessionId },
    });
    if (
      !session ||
      session.recordingPolicy === 'no_storage' ||
      (!['hearing', 'markup'].includes(session.sourceType) && session.createdBy !== ctx.clerkUserId)
    )
      throw new ForbiddenException('SESSION_ACCESS_CHANGED');
    const analysis = await tx.$queryRaw<
      Array<{ id: string }>
    >`SELECT id FROM intel_hearing_media_permission
      WHERE tenant_id=${ctx.tenantId} AND hearing_id IS NOT DISTINCT FROM ${session.hearingId}::text AND source_url=${session.sourceUrl ?? ''}
        AND mode=${session.publicCaptureId ? 'server' : 'browser'} AND revoked_at IS NULL AND expires_at>clock_timestamp()
        AND operations @> ARRAY['analysis']::text[] FOR SHARE`;
    if (!analysis.length) throw new ForbiddenException('SOURCE_ANALYSIS_PERMISSION_REQUIRED');
    if (payload.clientId) {
      const clients = await tx.$queryRaw<
        Array<{ id: string }>
      >`SELECT id FROM clients WHERE tenant_id=${ctx.tenantId}::uuid AND id=${payload.clientId}::uuid FOR SHARE`;
      if (!clients.length) throw new ForbiddenException('PUBLICATION_CLIENT_SCOPE_CHANGED');
    }
    for (const ref of payload.folders) {
      await tx.$queryRaw`SELECT id FROM intel_legiwatch_folder WHERE tenant_id=${ctx.tenantId} AND id=${ref.id} FOR SHARE`;
      const folder = await this.reports.folders.folder(tx, ctx, ref.id);
      if (folder.archived || folder.version !== ref.version || folder.clientId !== ref.clientId)
        throw new ConflictException('FOLDER_SCOPE_CHANGED');
      for (const assignment of ref.assignments ?? []) {
        const rows = await tx.$queryRaw<
          Array<{ version: number }>
        >`SELECT version FROM intel_legiwatch_folder_bill
          WHERE tenant_id=${ctx.tenantId} AND folder_id=${ref.id} AND id=${assignment.id} FOR SHARE`;
        if (rows[0]?.version !== assignment.version)
          throw new ConflictException('FOLDER_CONTEXT_CHANGED_REGENERATE');
      }
    }
    const segmentIds = payload.evidence.map((e) => e.segmentId);
    await tx.$queryRaw`SELECT id FROM intel_transcript_segment WHERE tenant_id=${ctx.tenantId} AND session_id=${row.sessionId} AND id=ANY(${segmentIds}::text[]) FOR SHARE`;
    const current = await this.evidence(tx, ctx, row.sessionId, segmentIds);
    if (
      payload.evidence.some(
        (e) => !current.some((now) => now.segmentId === e.segmentId && now.hash === e.hash),
      )
    )
      throw new ConflictException('EVIDENCE_CHANGED_CREATE_CORRECTION');
    validateHearingClaims(payload.claims, current);
    return session;
  }
  async approve(ctx: WorkspaceTenantContext, sessionId: string, id: string, input: unknown) {
    const body = object(input);
    const target = await this.actor(ctx, (tx) => this.get(tx, ctx, id, sessionId));
    await this.authorize(ctx, sessionId, target.row.kind);
    return this.actor(ctx, async (tx) => {
      const { row, payload } = await this.get(tx, ctx, id, sessionId);
      if (body.contentHash !== row.contentHash || body.attestSupported !== true)
        throw new ConflictException('REVIEW_ALL_CLAIMS_AND_EXACT_CONTENT_REQUIRED');
      await this.recheck(tx, ctx, row, payload);
      if (row.status === 'approved')
        return { id, status: 'approved', contentHash: row.contentHash };
      const approved = await tx.hearingPublication.updateMany({
        where: { tenantId: ctx.tenantId, id, status: 'draft' },
        data: { status: 'approved', approvedAt: new Date(), approvedBy: ctx.clerkUserId },
      });
      if (approved.count !== 1) throw new ConflictException('PUBLICATION_CHANGED_RELOAD');
      return { id, status: 'approved', contentHash: row.contentHash };
    });
  }
  async previewDelivery(
    ctx: WorkspaceTenantContext,
    sessionId: string,
    id: string,
    input: unknown,
  ) {
    const body = object(input);
    const target = await this.actor(ctx, (tx) => this.get(tx, ctx, id, sessionId));
    await this.authorize(ctx, sessionId, target.row.kind);
    return this.actor(ctx, async (tx) => {
      const { row, payload } = await this.get(tx, ctx, id, sessionId);
      if (row.status !== 'approved') throw new ConflictException('APPROVED_PUBLICATION_REQUIRED');
      await this.recheck(tx, ctx, row, payload);
      const channel =
        body.channel === 'sms' ? 'sms' : body.channel === 'in_app' ? 'in_app' : 'email';
      const recipients =
        channel === 'sms'
          ? await this.smsRecipients(tx, ctx, payload, ids(body.consentIds))
          : channel === 'in_app'
            ? await this.inboxRecipients(tx, ctx)
            : await this.recipients.resolve(tx, ctx, body.selection);
      if (!recipients.length || recipients.length > 25)
        throw new BadRequestException('HEARING_PILOT_REQUIRES_1_TO_25_RECIPIENTS');
      const plainText = publicationMarkdown(payload),
        subject = payload.label + ': ' + payload.title;
      const smsText = channel === 'sms' ? publicationSms(payload) : null;
      const size = smsText ? smsSize(smsText) : null;
      if (size && size.segments > 3)
        throw new BadRequestException(
          'SMS_EXCEEDS_THREE_SEGMENTS_CREATE_A_SHORTER_REVIEWED_VERSION',
        );
      const composition = {
        publicationId: id,
        contentHash: row.contentHash,
        subject,
        plainText,
        html: `<html><body><pre style="white-space:pre-wrap">${escapeHtml(plainText)}</pre></body></html>`,
        recipients,
        channel,
        smsText,
        smsSize: size,
      };
      return { composition, approvalHash: digest(composition) };
    });
  }
  async enqueue(ctx: WorkspaceTenantContext, sessionId: string, id: string, input: unknown) {
    const body = object(input),
      preview = await this.previewDelivery(ctx, sessionId, id, input);
    if (body.approvalHash !== preview.approvalHash)
      throw new ConflictException('AUDIENCE_OR_CONTENT_CHANGED_REVIEW_AGAIN');
    return this.actor(ctx, async (tx) => {
      const { row, payload } = await this.get(tx, ctx, id, sessionId);
      await this.checkDispatch(
        tx,
        ctx,
        {
          kind: row.kind,
          contentHash: row.contentHash,
          composition: json({ publicationId: id }),
          approvedAt: new Date(),
        } as LegiWatchDelivery,
        preview.composition.recipients[0]!,
        preview.composition.channel,
      );
      const intentKey = `hearing:${id}:${preview.approvalHash}`;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${ctx.tenantId + ':' + intentKey},0))`;
      const existing = await tx.legiWatchDelivery.findFirst({
        where: { tenantId: ctx.tenantId, intentKey },
      });
      if (existing) return { id: existing.id, state: 'already_queued' };
      for (const recipient of preview.composition.recipients) {
        if (preview.composition.channel === 'sms')
          await this.recheckSms(tx, ctx, payload, recipient as HearingSmsRecipient);
        else if (preview.composition.channel === 'in_app') await this.inboxRecipients(tx, ctx);
        else await this.recipients.recheck(tx, ctx, recipient);
      }
      const delivery = await tx.legiWatchDelivery.create({
        data: {
          tenantId: ctx.tenantId,
          kind: row.kind,
          intentKey,
          ownerClerkId: ctx.clerkUserId,
          contentHash: row.contentHash,
          composition: json({
            publicationId: id,
            approvalHash: preview.approvalHash,
            smsText: preview.composition.smsText,
          }),
          recipients: {
            create: preview.composition.recipients.map((recipient) => ({
              destinationHash: digest(
                preview.composition.channel === 'sms'
                  ? (recipient as HearingSmsRecipient).phone
                  : recipient.email,
              ),
              recipient: json(recipient),
              channel: preview.composition.channel,
            })),
          },
        },
      });
      return { id: delivery.id, state: 'queued', publicationId: row.id };
    });
  }
  async checkDispatch(
    tx: Prisma.TransactionClient,
    ctx: WorkspaceTenantContext,
    delivery: LegiWatchDelivery,
    recipient: RecipientSnapshot,
    channel: string,
  ) {
    const runtime = await tx.$queryRaw<
      Array<{ enabled: boolean }>
    >`SELECT (enabled AND schedule_enabled) AS enabled
      FROM legiwatch_runtime_heartbeat WHERE job_key='hearing-delivery-worker' FOR SHARE`;
    if (!runtime[0]?.enabled) throw new ForbiddenException('HEARING_DELIVERY_RUNTIME_DISABLED');
    if (
      !['live_update', 'hearing_recap'].includes(delivery.kind) ||
      !['email', 'sms', 'in_app'].includes(channel)
    )
      throw new ForbiddenException('HEARING_CHANNEL_NOT_QUALIFIED');
    if (!(await this.reports.flags.isEnabled(publicationFeature(delivery.kind), ctx.tenantId)))
      throw new ForbiddenException('HEARING_DELIVERY_DISABLED');
    if (channel === 'email' && process.env.LEGIWATCH_HEARING_EMAIL_ENABLED !== 'true')
      throw new ForbiddenException('HEARING_EMAIL_DISABLED');
    if (channel === 'in_app' && process.env.LEGIWATCH_HEARING_INBOX_ENABLED !== 'true')
      throw new ForbiddenException('HEARING_INBOX_DISABLED');
    if (
      channel === 'sms' &&
      (process.env.LEGIWATCH_HEARING_SMS_ENABLED !== 'true' ||
        process.env.HEARING_SMS_READINESS_APPROVED !== 'true' ||
        !(await this.reports.flags.isEnabled(HEARING_SMS_FEATURE, ctx.tenantId)))
    )
      throw new ForbiddenException('HEARING_SMS_NOT_QUALIFIED');
    if (!(await this.reports.folders.source.activeMember(ctx.tenantId, ctx.clerkUserId, tx)))
      throw new ForbiddenException('ACTIVE_MEMBERSHIP_REQUIRED');
    if (
      Date.now() - delivery.approvedAt.getTime() >
      (delivery.kind === 'live_update' ? 3600_000 : 86400_000)
    )
      throw new ConflictException('STALE_HEARING_DELIVERY_REQUIRES_NEW_REVIEW');
    const { row, payload } = await this.get(
      tx,
      ctx,
      String(object(delivery.composition).publicationId),
    );
    if (
      row.status !== 'approved' ||
      row.contentHash !== delivery.contentHash ||
      row.kind !== delivery.kind
    )
      throw new ConflictException('APPROVED_PUBLICATION_UNAVAILABLE');
    const session = await this.recheck(tx, ctx, row, payload);
    const grants = await tx.$queryRaw<
      Array<{ id: string }>
    >`SELECT id FROM intel_hearing_media_permission
      WHERE tenant_id=${ctx.tenantId} AND source_url=${session.sourceUrl ?? ''} AND hearing_id IS NOT DISTINCT FROM ${session.hearingId}::text
        AND mode=${session.publicCaptureId ? 'server' : 'browser'} AND revoked_at IS NULL AND expires_at>clock_timestamp() AND operations @> ARRAY['analysis','distribution']::text[] LIMIT 1 FOR SHARE`;
    if (!grants.length) throw new ForbiddenException('SOURCE_DISTRIBUTION_PERMISSION_REQUIRED');
    if (channel === 'in_app') {
      if ((recipient as HearingInboxRecipient).userId !== ctx.clerkUserId)
        throw new ForbiddenException('INBOX_OWNER_SCOPE_CHANGED');
      await this.inboxRecipients(tx, ctx);
      return payload;
    }
    if (channel === 'sms') {
      await this.recheckSms(tx, ctx, payload, recipient as HearingSmsRecipient);
      if (smsSize(publicationSms(payload)).segments > 3)
        throw new ConflictException('SMS_SEGMENT_LIMIT_EXCEEDED');
      return payload;
    }
    const contacts = recipient.contacts.map((c) => c.id),
      lists = recipient.lists.map((l) => l.id);
    await tx.$queryRaw`SELECT id FROM intel_legiwatch_report_contact WHERE tenant_id=${ctx.tenantId} AND (id=ANY(${contacts}::text[]) OR lower(email)=${recipient.email}) FOR SHARE`;
    await tx.$queryRaw`SELECT id FROM intel_legiwatch_report_list WHERE tenant_id=${ctx.tenantId} AND id=ANY(${lists}::text[]) FOR SHARE`;
    await this.recipients.recheck(tx, ctx, recipient);
    return payload;
  }
  private async smsRecipients(
    tx: Prisma.TransactionClient,
    ctx: WorkspaceTenantContext,
    payload: HearingPublicationPayload,
    consentIds: string[],
  ): Promise<HearingSmsRecipient[]> {
    if (!payload.clientId || !consentIds.length || consentIds.length > 25)
      throw new BadRequestException('SELECT_CLIENT_SMS_CONSENTS');
    const rows = await tx.hearingSmsConsent.findMany({
      where: {
        tenantId: ctx.tenantId,
        userId: ctx.clerkUserId,
        clientId: payload.clientId,
        id: { in: consentIds },
        revokedAt: null,
      },
    });
    if (rows.length !== consentIds.length) throw new ForbiddenException('SMS_CONSENT_UNAVAILABLE');
    const result: HearingSmsRecipient[] = [];
    for (const row of rows) {
      const contact = row.contactId
        ? await tx.legiWatchReportContact.findFirst({
            where: {
              tenantId: ctx.tenantId,
              id: row.contactId,
              active: true,
              optedOut: false,
              phone: row.phone,
            },
          })
        : null;
      if (!contact) throw new ForbiddenException('SMS_DIRECTORY_CONTACT_UNAVAILABLE');
      result.push({
        email: contact.email ?? '',
        role: 'to',
        name: contact.name,
        contacts: [{ id: contact.id, version: contact.version }],
        lists: [],
        manual: false,
        phone: row.phone,
        consentId: row.id,
        verificationId: row.verificationId,
      });
    }
    return result.sort((a, b) => a.phone.localeCompare(b.phone));
  }
  private async inboxRecipients(
    tx: Prisma.TransactionClient,
    ctx: WorkspaceTenantContext,
  ): Promise<HearingInboxRecipient[]> {
    const rows = await tx.$queryRaw<Array<{ email: string }>>`SELECT u.email FROM users u
      JOIN tenant_memberships m ON m.user_id=u.id AND m.tenant_id=${ctx.tenantId}::uuid AND m.status::text='active'
      WHERE u.clerk_user_id=${ctx.clerkUserId}`;
    if (!rows[0]) throw new ForbiddenException('ACTIVE_MEMBERSHIP_REQUIRED');
    return [
      {
        userId: ctx.clerkUserId,
        email: rows[0].email,
        name: 'My LegiWatch inbox',
        role: 'to',
        manual: false,
        contacts: [],
        lists: [],
      },
    ];
  }
  private async recheckSms(
    tx: Prisma.TransactionClient,
    ctx: WorkspaceTenantContext,
    payload: HearingPublicationPayload,
    recipient: HearingSmsRecipient,
  ) {
    await tx.$queryRaw`SELECT id FROM intel_hearing_sms_consent WHERE tenant_id=${ctx.tenantId} AND id=${recipient.consentId} FOR SHARE`;
    const current = await this.smsRecipients(tx, ctx, payload, [recipient.consentId]);
    const row = await tx.hearingSmsConsent.findFirst({
      where: {
        tenantId: ctx.tenantId,
        id: recipient.consentId,
        consentVersion: HEARING_SMS_CONSENT_VERSION,
      },
    });
    if (!row || smsRecipientHash(current[0]!) !== smsRecipientHash(recipient))
      throw new ConflictException('SMS_CONSENT_OR_DESTINATION_CHANGED');
    await tx.$queryRaw`SELECT id FROM intel_legiwatch_report_contact WHERE tenant_id=${ctx.tenantId} AND id=${row.contactId} FOR SHARE`;
    const locked = await this.smsRecipients(tx, ctx, payload, [recipient.consentId]);
    if (smsRecipientHash(locked[0]!) !== smsRecipientHash(recipient))
      throw new ConflictException('SMS_DIRECTORY_CHANGED');
  }
}
