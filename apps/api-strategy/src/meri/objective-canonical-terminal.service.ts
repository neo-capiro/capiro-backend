import { HttpException, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import type { Prisma } from '../../generated/prisma-client/index.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { applicationHash, applicationUuid, CanonicalApplicationError } from '../planner/objective-canonical-application.js';
import { ObjectiveCanonicalWorkloadAuthority, type CanonicalGenerationGrant,
  type CanonicalGenerationSubject } from '../planner/objective-canonical-authority.js';
import { ObjectiveCanonicalResultOwner } from './objective-canonical-result-owner.js';
import { checkStoredCanonicalNonSuccess, verifyRetainedCanonicalNonSuccess } from './objective-canonical-completion-receipt.js';
import { generationAssociation, readGenerationLedger } from './objective-canonical-producer-ledger.js';
import { GENERATION_NORMALIZATION, GENERATION_PRODUCER } from './objective-canonical-generation.js';
import { readCanonicalRequestPublication } from './objective-canonical-request-ledger.js';
import { requireCanonicalGenerationReadWithinTx } from './objective-canonical-generation-fence.js';
import { readCanonicalSavedGeneration } from './objective-canonical-saved-generation.js';
import { checkCanonicalTerminal, prepareCanonicalTerminal, type CanonicalTerminalRecord } from './objective-canonical-terminal.js';
import { publicObjectiveReceipt } from './objective-generation.types.js';
import type { DraftJobInput } from './draft-job.types.js';

type Tx = Prisma.TransactionClient;
const fail = (code: CanonicalApplicationError['code'] = 'OUTCOME_UNCONFIRMED'): never => { throw new CanonicalApplicationError(code); };

/** Terminal bookkeeping only. This never calls the Strategy/Planner writer or
 * renews an original worker/effect grant. Generic failed/cancelled run custody
 * has no genuine reader yet and cannot enter the typed-result path below. */
@Injectable()
export class ObjectiveCanonicalTerminalService {
  constructor(private readonly prisma: PrismaService, private readonly authority: ObjectiveCanonicalWorkloadAuthority,
    private readonly results: ObjectiveCanonicalResultOwner) {}

  private body(raw: unknown) {
    applicationHash(raw);
    const b = raw as { schemaVersion: number; generationJobId: string };
    if (!b || Object.keys(b).sort().join(',') !== 'generationJobId,schemaVersion' || b.schemaVersion !== 1) return fail('INPUT_INVALID');
    return { schemaVersion: 1 as const, generationJobId: applicationUuid(b.generationJobId) };
  }
  private async proof(tx: Tx, grant: CanonicalGenerationGrant, subject: CanonicalGenerationSubject, observedExpiry?: number) {
    await this.authority.assertGenerationCurrent(tx, grant, subject);
    const rows = await tx.$queryRaw<Array<{ ms: string }>>`SELECT ceil(extract(epoch FROM clock_timestamp())*1000)::text AS ms`;
    const now = Number(rows[0]?.ms);
    const accounting = grant.terminalAccounting;
    if (rows.length !== 1 || !Number.isSafeInteger(now) || now < 0 || grant.requestSha256 !== subject.requestSha256 ||
        !Number.isSafeInteger(grant.checkedAtMs) || grant.checkedAtMs > now ||
        !accounting || accounting.phase !== subject.phase ||
        !Number.isSafeInteger(accounting.checkedAtMs) || accounting.checkedAtMs > now ||
        [grant.expiresAtMs, accounting.expiresAtMs, accounting.absoluteExpiresAtMs,
          ...(observedExpiry === undefined ? [] : [observedExpiry])].some(n => !Number.isSafeInteger(n) || n <= now))
      return fail('AUTHORITY_UNAVAILABLE');
    return now;
  }
  private async stored<T>(read: () => Promise<T> | T): Promise<T> {
    try { return await read(); }
    catch (error) {
      if (error instanceof CanonicalApplicationError && error.code !== 'AUTHORITY_UNAVAILABLE') return fail();
      throw error;
    }
  }
  private async source(tx: Tx, grant: CanonicalGenerationGrant, subject: CanonicalGenerationSubject, lock: boolean) {
    if (lock) await tx.$queryRaw`SELECT id FROM sp_draft_job WHERE tenant_id=${grant.tenantId}::uuid
      AND owner_user_id=${grant.clerkUserId} AND id=${subject.generationJobId}::uuid FOR UPDATE`;
    const job = await tx.spDraftJob.findFirst({ where: { tenantId: grant.tenantId,
      ownerUserId: grant.clerkUserId, id: subject.generationJobId } });
    if (!job) return fail('NOT_AVAILABLE');
    const association = await this.stored(() => generationAssociation(tx, grant.tenantId, grant.clerkUserId, job.id));
    const a = association.admission;
    if (a.actorUserId !== grant.actorUserId || a.clerkUserId !== grant.clerkUserId || a.canonical.tenantId !== grant.tenantId ||
        a.consentId !== grant.consentId || a.controlVersion !== grant.controlVersion) return fail('REQUEST_CONFLICT');
    await requireCanonicalGenerationReadWithinTx(tx, a, grant.clerkUserId);
    const published = await this.stored(() => readCanonicalRequestPublication(tx, a));
    if (!published) return fail();
    if (a.expectedStrategyVersionId !== null || 'requestVersion' in published.publication.request || published.publication.request.basis !== null)
      return fail('AUTHORITY_UNAVAILABLE');
    const now = await this.proof(tx, grant, subject);
    return { job, association, admission: a, published, now };
  }
  private expected(state: Awaited<ReturnType<ObjectiveCanonicalTerminalService['source']>>) {
    return { admission: state.admission, acceptance: state.association.acceptance,
      publication: state.published.publication };
  }
  private kernelSource(state: Awaited<ReturnType<ObjectiveCanonicalTerminalService['source']>>) {
    return { admission: state.admission, acceptance: state.association.acceptance,
      publicationSha256: state.published.publicationSha256 };
  }
  private async noWrites(tx: Tx, state: Awaited<ReturnType<ObjectiveCanonicalTerminalService['source']>>) {
    const a = state.admission, scope = [tx, a.canonical.tenantId, a.clerkUserId, a.generationJobId] as const;
    if (await readGenerationLedger(scope[0], GENERATION_NORMALIZATION, scope[1], scope[2], scope[3]) ||
        await readGenerationLedger(scope[0], GENERATION_PRODUCER, scope[1], scope[2], scope[3]) ||
        await tx.spStrategy.findFirst({ where: { tenantId: a.canonical.tenantId, id: a.canonical.canonicalStrategyId } })) return fail();
  }
  private observation(state: Awaited<ReturnType<ObjectiveCanonicalTerminalService['source']>>, record: CanonicalTerminalRecord,
    input = state.job.input as unknown as DraftJobInput) {
    const receipt = input.objectiveGeneration?.receipt;
    if (!receipt) return fail();
    return { schemaVersion: 1 as const, generationJobId: state.job.id, status: 'not-applied' as const,
      outcome: record.outcome, terminalReceiptId: record.id, terminalReceiptSha256: record.recordSha256,
      recordedAtMs: record.recordedAtMs, objectiveReceipt: publicObjectiveReceipt(receipt) };
  }
  private async prior(tx: Tx, grant: CanonicalGenerationGrant, subject: CanonicalGenerationSubject,
    state: Awaited<ReturnType<ObjectiveCanonicalTerminalService['source']>>) {
    if (state.job.status === 'completed') {
      const saved = await readCanonicalSavedGeneration(tx, { tenantId: grant.tenantId,
        clerkUserId: grant.clerkUserId, generationJobId: state.job.id });
      await requireCanonicalGenerationReadWithinTx(tx, state.admission, grant.clerkUserId);
      await this.proof(tx, grant, subject);
      return { schemaVersion: 1 as const, generationJobId: state.job.id, status: 'applied' as const, saved: saved.receipt };
    }
    const input = state.job.input as unknown as DraftJobInput;
    if (input.canonicalTerminal === undefined) return null;
    await this.noWrites(tx, state);
    const record = await this.stored(() => checkCanonicalTerminal(state.job, this.kernelSource(state)));
    // No generic run-state/physical-stop proof owner exists. Do not fabricate
    // a typed file or silently accept a broad result enum as that evidence.
    if (record.outcome !== 'needs-information' && record.outcome !== 'refused') return fail('AUTHORITY_UNAVAILABLE');
    const evidence = await this.stored(() => checkStoredCanonicalNonSuccess(record.evidence, this.expected(state)));
    if (evidence.outcome !== record.outcome || record.recordedAtMs > state.now ||
        record.recordedAtMs < (evidence.retained.checkedAtMs as number) ||
        record.recordedAtMs >= (evidence.retained.expiresAtMs as number)) return fail();
    await requireCanonicalGenerationReadWithinTx(tx, state.admission, grant.clerkUserId);
    await this.proof(tx, grant, subject);
    return this.observation(state, record);
  }
  private async retained(source: Parameters<ObjectiveCanonicalResultOwner['read']>[0]) {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([this.results.read(source, { signal: controller.signal }),
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => {
        controller.abort(); reject(new CanonicalApplicationError('AUTHORITY_UNAVAILABLE'));
      }, 3000); })]); }
    finally { if (timer) clearTimeout(timer); controller.abort(); }
  }
  async account(http: Request, raw: unknown) {
    return this.safe(async () => {
      const body = this.body(raw), subject: CanonicalGenerationSubject = { phase: 'terminal-account',
        generationJobId: body.generationJobId, requestSha256: applicationHash(body) };
      const grant = await this.authority.verifyGeneration(http, subject);
      const first = await this.prisma.withTenant(grant.tenantId, async tx => {
        const state = await this.source(tx, grant, subject, true), previous = await this.prior(tx, grant, subject, state);
        if (!previous) {
          if (state.job.status !== 'running' || state.job.attempt !== 2 ||
              state.job.claimedBy !== `canonical:${state.association.acceptance.issuance.issuanceKey}`) return fail();
          await this.noWrites(tx, state);
        }
        return { state, previous };
      }, { timeoutMs: 15_000 });
      if (first.previous) return first.previous;
      const rawOutcome = await this.retained({ generationJobId: body.generationJobId,
        binding: first.state.association.acceptance.sourceBinding,
        sourceAdmissionSha256: first.state.published.publication.sourceAdmissionSha256 });
      return this.prisma.withTenant(grant.tenantId, async tx => {
        const state = await this.source(tx, grant, subject, true), previous = await this.prior(tx, grant, subject, state);
        if (previous) return previous; // A committed Strategy or terminal wins.
        if (applicationHash(state.association) !== applicationHash(first.state.association) ||
            state.published.publicationSha256 !== first.state.published.publicationSha256 ||
            applicationHash(state.job.input) !== applicationHash(first.state.job.input)) return fail('REQUEST_CONFLICT');
        await this.noWrites(tx, state);
        const verified = await this.stored(() => verifyRetainedCanonicalNonSuccess(rawOutcome, { ...this.expected(state), nowMs: state.now }));
        const prepared = await this.stored(() => prepareCanonicalTerminal(state.job, { ...this.kernelSource(state),
          outcome: verified.outcome, evidence: verified.evidence, recordedAtMs: state.now }));
        await requireCanonicalGenerationReadWithinTx(tx, state.admission, grant.clerkUserId);
        await this.proof(tx, grant, subject, verified.expiresAtMs);
        const changed = await tx.$executeRaw`UPDATE sp_draft_job SET status='failed', stage='failed',
          error_message=${prepared.errorMessage}, progress_text=NULL, stream_preview=NULL,
          input=${JSON.stringify(prepared.input)}::jsonb, updated_at=clock_timestamp()
          WHERE tenant_id=${grant.tenantId}::uuid AND id=${state.job.id}::uuid AND owner_user_id=${grant.clerkUserId}
            AND status='running' AND claimed_by=${prepared.record.claimToken} AND attempt=2 AND strategy_id IS NULL
            AND input=${JSON.stringify(state.job.input)}::jsonb AND NOT(input ? 'canonicalCompletion') AND NOT(input ? 'canonicalTerminal')`;
        if (changed !== 1) return fail();
        // These release checks must escape this SAME tx on failure. There is
        // no original-deadline/consent renewal and no follow-on product write.
        await requireCanonicalGenerationReadWithinTx(tx, state.admission, grant.clerkUserId);
        await this.proof(tx, grant, subject, verified.expiresAtMs);
        return this.observation(state, prepared.record, prepared.input);
      }, { timeoutMs: 15_000 });
    });
  }
  async lookup(http: Request, rawId: string) {
    return this.safe(async () => {
      const body = this.body({ schemaVersion: 1, generationJobId: rawId }), subject: CanonicalGenerationSubject = {
        phase: 'terminal-read', generationJobId: body.generationJobId, requestSha256: applicationHash(body) };
      const grant = await this.authority.verifyGeneration(http, subject);
      return this.prisma.withTenant(grant.tenantId, async tx => {
        const state = await this.source(tx, grant, subject, false);
        return await this.prior(tx, grant, subject, state) ?? fail();
      }, { timeoutMs: 15_000 });
    });
  }
  private async safe<T>(run: () => Promise<T>): Promise<T> {
    try { return await run(); }
    catch (error) {
      const code = error instanceof CanonicalApplicationError ? error.code : 'OUTCOME_UNCONFIRMED';
      const status = { INPUT_INVALID: 400, REQUEST_CONFLICT: 409, NOT_AVAILABLE: 404,
        SOURCE_STALE: 409, AUTHORITY_UNAVAILABLE: 503, OUTCOME_UNCONFIRMED: 503 }[code];
      throw new HttpException({ schemaVersion: 1, code, message: 'Objective terminal accounting is unavailable.', outcome: 'unconfirmed' }, status);
    }
  }
}
