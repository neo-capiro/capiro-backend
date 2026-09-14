import {
  Injectable,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { WorkspaceTenantContext } from '../../auth/tenant-context.js';
import type { Prisma } from '../../../generated/prisma-client/index.js';
import { object } from '../reports/report-domain.js';
import { hash } from '../folders/folder-tracker.service.js';
import { membershipState, writeMembershipDecision } from '../folders/folder-decisions.js';
import { compileDefinitions, queryReadiness, type KeywordRule } from './keyword-domain.js';
import { evaluateKeywordDefinitions } from './keyword-query.js';
import {
  KeywordRuleService,
  checkedVersion,
  requestKey,
  KEYWORD_AUTO_ADD_FEATURE,
} from './keyword-rule.service.js';
import type { KeywordSourceBill } from '../../sourcedata/keyword-source.repository.js';

type DiscoveryRun = {
  id: string;
  rule_id: string;
  rule_version: number;
  input_hash: string;
  input: { rule: KeywordRule; folderVersions: Record<string, number>; mode: 'preview' | 'active' };
  state: string;
  cursor: string | null;
  counts: { evaluated: number; matched: number; incomplete: number; suggestions: number };
  source_boundary: string;
  lease_token: string | null;
  attempts: number;
  reason: string | null;
};
type Suggestion = {
  id: string;
  rule_id: string;
  rule_version: number;
  run_id: string;
  folder_id: string;
  bill_id: string;
  fingerprint: string;
  version: number;
  state: string;
  decision_id: string | null;
  payload: {
    bill: KeywordSourceBill['bill'];
    sourceFingerprint: string;
    folderVersion: number;
    stateVersion: number;
    coverage: KeywordSourceBill['coverage'];
    matches: unknown[];
    sourceScope: KeywordRule['config']['scope'];
    origin: 'deterministic' | 'semantic';
    explanation?: string;
  };
};
@Injectable()
export class KeywordDiscoveryService {
  constructor(readonly rules: KeywordRuleService) {}
  async start(ctx: WorkspaceTenantContext, ruleId: string, body: unknown) {
    await this.rules.authorize(ctx);
    const b = object(body),
      key = requestKey(b.requestKey),
      expected = checkedVersion(b.expectedVersion);
    const rule = await this.rules.reports.folders.withActor(ctx, (tx) =>
      this.rules.get(tx, ctx, ruleId),
    );
    if (rule.version !== expected) throw new ConflictException('RULE_CHANGED_RELOAD');
    const boundary = await this.rules.sources.boundary(rule.config.scope),
      mode = b.mode === 'active' ? 'active' : 'preview';
    const inputHash = hash({ ruleId, expected, mode });
    return this.rules.reports.folders.withActor(ctx, async (tx) => {
      // Serialize caller request keys as well as rule versions.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${ctx.tenantId + ':' + ctx.clerkUserId + ':' + key},0))`;
      const previous = await tx.$queryRaw<
        DiscoveryRun[]
      >`SELECT * FROM intel_legiwatch_discovery_run WHERE tenant_id=${ctx.tenantId} AND owner_clerk_id=${ctx.clerkUserId} AND request_key=${key}`;
      if (previous[0]) {
        if (previous[0].input_hash !== inputHash)
          throw new ConflictException('SCAN_REQUEST_KEY_REUSED');
        return previous[0];
      }
      const current = await this.rules.get(tx, ctx, ruleId, true);
      if (current.version !== expected) throw new ConflictException('RULE_CHANGED_RELOAD');
      if (mode === 'active' && (current.state !== 'active' || !current.activation))
        throw new ConflictException('RULE_NOT_ACTIVE');
      const folderVersions: Record<string, number> = {};
      for (const id of [...rule.config.folderIds].sort())
        folderVersions[id] = (await this.rules.folder(tx, ctx, id)).version;
      const id = randomUUID(),
        input = { rule: current, folderVersions, mode };
      await tx.$executeRaw`INSERT INTO intel_legiwatch_discovery_run(id,tenant_id,owner_clerk_id,rule_id,rule_version,request_key,input_hash,input,source_boundary)
        VALUES(${id},${ctx.tenantId},${ctx.clerkUserId},${ruleId},${expected},${key},${inputHash},${JSON.stringify(input)}::jsonb,${boundary})`;
      return this.run(tx, ctx, id);
    });
  }
  async run(tx: Prisma.TransactionClient, ctx: WorkspaceTenantContext, id: string, lock = false) {
    const [run] = await tx.$queryRawUnsafe<DiscoveryRun[]>(
      `SELECT * FROM intel_legiwatch_discovery_run WHERE tenant_id=$1 AND owner_clerk_id=$2 AND id=$3 ${lock ? 'FOR UPDATE' : ''}`,
      ctx.tenantId,
      ctx.clerkUserId,
      id,
    );
    if (!run) throw new NotFoundException('DISCOVERY_RUN_NOT_FOUND');
    return run;
  }
  async history(ctx: WorkspaceTenantContext, ruleId: string) {
    await this.rules.authorize(ctx);
    return this.rules.reports.folders.withActor(ctx, async (tx) => {
      await this.rules.get(tx, ctx, ruleId);
      return tx.$queryRaw<
        DiscoveryRun[]
      >`SELECT * FROM intel_legiwatch_discovery_run WHERE tenant_id=${ctx.tenantId} AND owner_clerk_id=${ctx.clerkUserId} AND rule_id=${ruleId} ORDER BY created_at DESC,id DESC LIMIT 100`;
    });
  }
  async read(ctx: WorkspaceTenantContext, id: string) {
    await this.rules.authorize(ctx);
    return this.rules.reports.folders.withActor(ctx, (tx) => this.run(tx, ctx, id));
  }
  async suggestions(ctx: WorkspaceTenantContext, folderId: string, body: unknown) {
    await this.rules.authorize(ctx);
    const b = object(body),
      cursor = typeof b.cursor === 'string' ? b.cursor : '';
    return this.rules.reports.folders.withActor(ctx, async (tx) => {
      await this.rules.folder(tx, ctx, folderId);
      const rows = await tx.$queryRaw<
        Suggestion[]
      >`SELECT * FROM intel_legiwatch_suggestion WHERE tenant_id=${ctx.tenantId} AND owner_clerk_id=${ctx.clerkUserId}
        AND folder_id=${folderId} AND payload->'sourceScope'->>'jurisdiction'=${String(b.jurisdiction ?? '')} AND payload->'sourceScope'->>'sessionKey'=${String(b.sessionKey ?? '')}
        AND id>${cursor} ORDER BY id LIMIT 51`;
      return { rows: rows.slice(0, 50), next: rows.length > 50 ? rows[49]!.id : null };
    });
  }
  /** A worker owns one page under a renewable lease. Replays after committed
   * pages preserve cursors and suggestion identities. No effects from preview.
   */
  async advance(ctx: WorkspaceTenantContext, id: string) {
    await this.rules.authorize(ctx);
    const token = randomUUID();
    const claimed = await this.rules.reports.folders.withActor(ctx, async (tx) => {
      const r = await this.run(tx, ctx, id, true);
      if (!['pending', 'running', 'partial', 'failed'].includes(r.state)) return false;
      const changed =
        await tx.$executeRaw`UPDATE intel_legiwatch_discovery_run SET state='running',lease_token=${token},lease_until=now()+interval '3 minutes',attempts=attempts+1
        WHERE tenant_id=${ctx.tenantId} AND owner_clerk_id=${ctx.clerkUserId} AND id=${id} AND (lease_until IS NULL OR lease_until<now()) AND attempts<5`;
      return !!changed;
    });
    if (!claimed) return this.read(ctx, id);
    try {
      const run = await this.read(ctx, id),
        rule = run.input.rule;
      if ((await this.rules.sources.boundary(rule.config.scope)) !== run.source_boundary)
        return this.hold(ctx, id, token, 'stale', 'SOURCE_CHANGED_RESTART_SCAN');
      const page = await this.rules.sources.page(rule.config.scope, run.cursor, 25),
        definitions = compileDefinitions(rule.config.definitions);
      if ((await this.rules.sources.boundary(rule.config.scope)) !== run.source_boundary)
        return this.hold(ctx, id, token, 'stale', 'SOURCE_CHANGED_RESTART_SCAN');
      const evaluated = page.rows.map((r) => ({
        source: r,
        matches: r.documents
          .map((d) => ({
            document: {
              id: d.id,
              kind: d.kind,
              revision: d.revision,
              observationId: d.observationId,
              sourceUrl: d.sourceUrl,
            },
            evaluation: evaluateKeywordDefinitions(
              definitions,
              d.text,
              d.complete,
              rule.config.aggregation,
            ),
          }))
          .filter((m) => m.evaluation.outcome === 'match'),
      }));
      await this.rules.authorize(ctx);
      await this.rules.reports.folders.withActor(
        ctx,
        async (tx) => {
          // Lock rule before folder; decisions use the same ordering.
          const current = await this.rules.get(tx, ctx, rule.id, true);
          const locked = await this.run(tx, ctx, id, true);
          const lease = await tx.$queryRaw<
            Array<{ ok: number }>
          >`SELECT 1 AS ok FROM intel_legiwatch_discovery_run WHERE tenant_id=${ctx.tenantId} AND owner_clerk_id=${ctx.clerkUserId} AND id=${id} AND lease_token=${token} AND lease_until>now()`;
          if (!lease.length) throw new ConflictException('SCAN_LEASE_LOST');
          let held: string | null =
            current.version !== run.rule_version
              ? 'RULE_CHANGED_RESTART_SCAN'
              : current.state === 'paused'
                ? 'RULE_PAUSED'
                : null;
          if (
            run.input.mode === 'active' &&
            current.activation?.fromNow !== rule.activation?.fromNow
          )
            held = 'ACTIVATION_CHANGED_RESTART_SCAN';
          for (const folderId of Object.keys(run.input.folderVersions).sort()) {
            const f = await this.rules.folder(tx, ctx, folderId, true);
            if (f.version !== run.input.folderVersions[folderId])
              held = 'FOLDER_CONTEXT_CHANGED_RESTART_SCAN';
            if (
              !f.ownerClerkId ||
              !(await this.rules.reports.folders.source.activeMember(
                ctx.tenantId,
                f.ownerClerkId,
                tx,
              ))
            )
              held = 'FOLDER_OWNER_INACTIVE';
          }
          if (held) {
            await tx.$executeRaw`UPDATE intel_legiwatch_discovery_run SET state='stale',reason=${held},lease_until=NULL,lease_token=NULL WHERE tenant_id=${ctx.tenantId} AND owner_clerk_id=${ctx.clerkUserId} AND id=${id}`;
            return;
          }
          let created = 0;
          for (const item of evaluated)
            for (const folderId of Object.keys(run.input.folderVersions)) {
              if (!item.matches.length) continue;
              const state = await membershipState(tx, ctx, folderId, item.source.bill.id);
              const payload: Suggestion['payload'] = {
                bill: item.source.bill,
                sourceFingerprint: item.source.fingerprint,
                folderVersion: run.input.folderVersions[folderId]!,
                stateVersion: state.version,
                coverage: item.source.coverage,
                matches: item.matches,
                sourceScope: rule.config.scope,
                origin: 'deterministic',
              };
              const fingerprint = hash({
                source: item.source.fingerprint,
                folderId,
                folderVersion: payload.folderVersion,
                ruleId: rule.id,
                ruleVersion: rule.version,
                humanRevision: state.human_revision,
              });
              created +=
                await tx.$executeRaw`INSERT INTO intel_legiwatch_suggestion(id,tenant_id,owner_clerk_id,rule_id,rule_version,run_id,folder_id,bill_id,fingerprint,payload)
            VALUES(${randomUUID()},${ctx.tenantId},${ctx.clerkUserId},${rule.id},${rule.version},${id},${folderId},${item.source.bill.id},${fingerprint},${JSON.stringify(payload)}::jsonb)
            ON CONFLICT(tenant_id,owner_clerk_id,folder_id,bill_id,fingerprint) DO NOTHING`;
            }
          const counts = {
            evaluated: (locked.counts.evaluated ?? 0) + page.rows.length,
            matched:
              (locked.counts.matched ?? 0) + evaluated.filter((r) => r.matches.length).length,
            incomplete:
              (locked.counts.incomplete ?? 0) +
              page.rows.filter((r) => !r.coverage.complete).length,
            suggestions: (locked.counts.suggestions ?? 0) + created,
          };
          await tx.$executeRaw`UPDATE intel_legiwatch_discovery_run SET state=${page.next ? 'partial' : 'complete'},cursor=${page.next},counts=${JSON.stringify(counts)}::jsonb,
          lease_token=NULL,lease_until=NULL,attempts=0,reason=NULL,updated_at=now() WHERE tenant_id=${ctx.tenantId} AND owner_clerk_id=${ctx.clerkUserId} AND id=${id} AND lease_token=${token}`;
        },
        { timeoutMs: 30000 },
      );
      return this.read(ctx, id);
    } catch (e) {
      await this.hold(
        ctx,
        id,
        token,
        e instanceof ForbiddenException ? 'denied' : 'failed',
        e instanceof ConflictException ? 'STALE_INPUT' : 'SCAN_RETRY_REQUIRED',
      );
      throw e;
    }
  }
  private async hold(
    ctx: WorkspaceTenantContext,
    id: string,
    token: string,
    state: string,
    reason: string,
  ) {
    await this.rules.reports.folders.withActor(
      ctx,
      (
        tx,
      ) => tx.$executeRaw`UPDATE intel_legiwatch_discovery_run SET state=${state},reason=${reason},lease_until=NULL,lease_token=NULL,updated_at=now()
      WHERE tenant_id=${ctx.tenantId} AND owner_clerk_id=${ctx.clerkUserId} AND id=${id} AND lease_token=${token}`,
    );
    return this.read(ctx, id);
  }
  async decide(ctx: WorkspaceTenantContext, id: string, body: unknown, automatic = false) {
    await this.rules.authorize(ctx);
    const b = object(body),
      key = requestKey(b.requestKey),
      expected = checkedVersion(b.expectedVersion);
    if (!['add', 'dismiss', 'exclude', 'restore', 'undo'].includes(String(b.action)))
      throw new BadRequestException('UNKNOWN_SUGGESTION_ACTION');
    const initial = await this.rules.reports.folders.withActor(ctx, async (tx) => {
      const [s] = await tx.$queryRaw<
        Suggestion[]
      >`SELECT * FROM intel_legiwatch_suggestion WHERE tenant_id=${ctx.tenantId} AND owner_clerk_id=${ctx.clerkUserId} AND id=${id}`;
      if (!s) throw new NotFoundException('SUGGESTION_NOT_FOUND');
      return s;
    });
    const source = await this.rules.sources.bill(initial.payload.sourceScope, initial.bill_id);
    return this.rules.reports.folders.withActor(
      ctx,
      async (tx) => {
        const lockedSource =
          b.action === 'add'
            ? await this.rules.sources.lockBill(tx, initial.payload.sourceScope, initial.bill_id)
            : source;
        const rule = await this.rules.get(tx, ctx, initial.rule_id, true);
        const folder = await this.rules.folder(tx, ctx, initial.folder_id, true);
        const [s] = await tx.$queryRaw<
          Suggestion[]
        >`SELECT * FROM intel_legiwatch_suggestion WHERE tenant_id=${ctx.tenantId} AND owner_clerk_id=${ctx.clerkUserId} AND id=${id} FOR UPDATE`;
        if (!s) throw new NotFoundException('SUGGESTION_NOT_FOUND');
        const receipts = await tx.$queryRaw<
          Array<{ outcome: string; payload: Record<string, unknown> }>
        >`SELECT outcome,payload FROM intel_legiwatch_suggestion_operation WHERE tenant_id=${ctx.tenantId} AND owner_clerk_id=${ctx.clerkUserId} AND request_key=${key}`;
        const binding = hash({ id, expected, action: b.action });
        if (receipts[0]) {
          if (receipts[0].payload.binding !== binding)
            throw new ConflictException('SUGGESTION_REQUEST_KEY_REUSED');
          return receipts[0];
        }
        if (s.version !== expected) throw new ConflictException('SUGGESTION_CHANGED_RELOAD');
        if (
          !(await this.rules.reports.folders.source.activeMember(
            ctx.tenantId,
            ctx.clerkUserId,
            tx,
          )) ||
          !folder.ownerClerkId ||
          !(await this.rules.reports.folders.source.activeMember(
            ctx.tenantId,
            folder.ownerClerkId,
            tx,
          ))
        )
          throw new ForbiddenException('ACTIVE_OWNER_REQUIRED');
        const action = String(b.action);
        if (action === 'dismiss' && s.state !== 'pending')
          throw new ConflictException('ONLY_PENDING_SUGGESTIONS_CAN_BE_DISMISSED');
        if (action === 'undo' && !['added', 'already_present'].includes(s.state))
          throw new ConflictException('NO_CURRENT_ASSIGNMENT_ACTION_TO_UNDO');
        let outcome =
            action === 'dismiss' ? 'dismissed' : action === 'exclude' ? 'excluded' : 'pending',
          decisionId: string | null = s.decision_id;
        if (action === 'add') {
          if (automatic) {
            const enabled = await tx.featureFlag.findUnique({
              where: {
                feature_tenantId: { tenantId: ctx.tenantId, feature: KEYWORD_AUTO_ADD_FEATURE },
              },
            });
            const activeRun = await this.run(tx, ctx, s.run_id);
            if (
              process.env.LEGIWATCH_KEYWORD_AUTO_ADD_ENABLED !== 'true' ||
              !enabled?.enabled ||
              rule.state !== 'active' ||
              rule.config.mode !== 'auto_add' ||
              rule.activation?.version !== rule.version ||
              activeRun.input.mode !== 'active' ||
              activeRun.input.rule.activation?.fromNow !== rule.activation?.fromNow ||
              s.payload.origin !== 'deterministic' ||
              !s.payload.coverage.complete ||
              queryReadiness(rule.config).length
            )
              throw new ConflictException('AUTOMATIC_ASSIGNMENT_HELD');
            if (rule.config.source && rule.config.source.ownerMapping !== 'reviewed')
              throw new ConflictException('IMPORTED_OWNER_MAPPING_REQUIRES_REVIEW');
          }
          if (s.state !== 'pending') throw new ConflictException('SUGGESTION_NOT_PENDING');
          if (
            rule.version !== s.rule_version ||
            folder.version !== s.payload.folderVersion ||
            lockedSource?.fingerprint !== s.payload.sourceFingerprint ||
            rule.state === 'paused'
          )
            outcome = 'stale';
          else {
            const excluded = await tx.$queryRaw<
              Array<{ excluded: boolean }>
            >`SELECT excluded FROM intel_legiwatch_rule_exclusion WHERE tenant_id=${ctx.tenantId} AND owner_clerk_id=${ctx.clerkUserId} AND rule_id=${rule.id} AND folder_id=${folder.id} AND bill_id=${s.bill_id}`;
            if (excluded[0]?.excluded) outcome = 'excluded';
            else {
              const receipt = await writeMembershipDecision(tx, ctx, {
                folderId: folder.id,
                billId: s.bill_id,
                action: 'add',
                origin: 'rule',
                ruleId: rule.id,
                requestKey: key,
                expectedStateVersion: s.payload.stateVersion,
                sourceFingerprint: s.payload.sourceFingerprint,
                bill: source!.bill,
              });
              outcome = receipt.outcome;
              decisionId = receipt.id;
            }
          }
        } else if (action === 'exclude' || action === 'restore') {
          await tx.$executeRaw`INSERT INTO intel_legiwatch_rule_exclusion(tenant_id,owner_clerk_id,rule_id,folder_id,bill_id,excluded)
          VALUES(${ctx.tenantId},${ctx.clerkUserId},${rule.id},${folder.id},${s.bill_id},${action === 'exclude'})
          ON CONFLICT(tenant_id,owner_clerk_id,rule_id,folder_id,bill_id) DO UPDATE SET excluded=EXCLUDED.excluded,version=intel_legiwatch_rule_exclusion.version+1`;
          // Restoring a rule-specific exclusion never clears a manual removal.
          if (action === 'restore') {
            outcome =
              source?.fingerprint === s.payload.sourceFingerprint &&
              rule.version === s.rule_version &&
              folder.version === s.payload.folderVersion
                ? 'pending'
                : 'stale';
            const state = await membershipState(tx, ctx, folder.id, s.bill_id);
            s.payload.stateVersion = state.version;
            await tx.$executeRaw`UPDATE intel_legiwatch_suggestion SET payload=${JSON.stringify(s.payload)}::jsonb WHERE tenant_id=${ctx.tenantId} AND owner_clerk_id=${ctx.clerkUserId} AND id=${id}`;
          }
        } else if (action === 'undo') {
          const receipt = await writeMembershipDecision(tx, ctx, {
            folderId: folder.id,
            billId: s.bill_id,
            action: 'undo',
            origin: 'manual',
            requestKey: key,
            undoDecisionId: s.decision_id ?? '',
          });
          outcome = receipt.outcome === 'undone' ? 'undone' : s.state;
          if (receipt.outcome === 'undone') decisionId = receipt.id;
          if (receipt.outcome === 'undo_conflict') outcome = 'undo_conflict';
        }
        await tx.$executeRaw`UPDATE intel_legiwatch_suggestion SET state=${outcome === 'undo_conflict' ? s.state : outcome},version=version+1,decision_id=${decisionId}
        WHERE tenant_id=${ctx.tenantId} AND owner_clerk_id=${ctx.clerkUserId} AND id=${id}`;
        const payload = { binding, suggestionId: id, decisionId, version: s.version + 1, action };
        await tx.$executeRaw`INSERT INTO intel_legiwatch_suggestion_operation(id,tenant_id,owner_clerk_id,request_key,outcome,payload)
        VALUES(${randomUUID()},${ctx.tenantId},${ctx.clerkUserId},${key},${outcome},${JSON.stringify(payload)}::jsonb)`;
        return { outcome, payload };
      },
      { timeoutMs: 30000 },
    );
  }
  async batch(ctx: WorkspaceTenantContext, body: unknown) {
    const b = object(body);
    if (!Array.isArray(b.items) || !b.items.length || b.items.length > 200)
      throw new BadRequestException('SELECT_1_TO_200_EXACT_CANDIDATES');
    const results = [];
    for (const value of b.items) {
      const item = object(value),
        id = String(item.id ?? '');
      try {
        results.push({ id, ...(await this.decide(ctx, id, { ...item, action: b.action })) });
      } catch (e) {
        results.push({
          id,
          outcome:
            e instanceof ForbiddenException
              ? 'denied'
              : e instanceof ConflictException
                ? 'stale'
                : 'failed',
        });
      }
    }
    return { selected: b.items.length, results };
  }
  async activation(ctx: WorkspaceTenantContext, id: string, body: unknown) {
    await this.rules.authorize(ctx);
    const b = object(body),
      expected = checkedVersion(b.expectedVersion);
    if (!['activate', 'pause'].includes(String(b.action)))
      throw new BadRequestException('EXPLICIT_ACTIVATION_ACTION_REQUIRED');
    const current = await this.rules.reports.folders.withActor(ctx, (tx) =>
      this.rules.get(tx, ctx, id),
    );
    const boundary = await this.rules.sources.boundary(current.config.scope);
    return this.rules.reports.folders.withActor(ctx, async (tx) => {
      const rule = await this.rules.get(tx, ctx, id, true);
      if (rule.version !== expected) throw new ConflictException('RULE_CHANGED_RELOAD');
      if (b.action === 'pause') {
        await tx.$executeRaw`UPDATE intel_legiwatch_keyword_rule SET state='paused',updated_at=now() WHERE tenant_id=${ctx.tenantId} AND owner_clerk_id=${ctx.clerkUserId} AND id=${id}`;
        return this.rules.get(tx, ctx, id);
      }
      const issues = queryReadiness(rule.config);
      if (rule.config.source && rule.config.source.ownerMapping !== 'reviewed')
        issues.push('IMPORTED_OWNER_MAPPING_REQUIRES_REVIEW');
      if (issues.length) throw new BadRequestException({ message: 'RULE_NOT_READY', issues });
      const preview = await this.run(tx, ctx, String(b.previewRunId ?? ''));
      if (
        preview.rule_id !== id ||
        preview.rule_version !== rule.version ||
        preview.state !== 'complete' ||
        preview.input.mode !== 'preview' ||
        preview.source_boundary !== boundary ||
        preview.counts.incomplete !== 0 ||
        !preview.counts.evaluated
      )
        throw new ConflictException('COMPLETE_CURRENT_PREVIEW_REQUIRED');
      for (const folderId of rule.config.folderIds.sort()) {
        const folder = await this.rules.folder(tx, ctx, folderId, true);
        if (
          folder.version !== preview.input.folderVersions[folderId] ||
          !folder.ownerClerkId ||
          !(await this.rules.reports.folders.source.activeMember(
            ctx.tenantId,
            folder.ownerClerkId,
            tx,
          ))
        )
          throw new ConflictException('FOLDER_OWNER_OR_CONTEXT_CHANGED');
      }
      if (b.baseline !== 'from_now') throw new BadRequestException('FROM_NOW_BASELINE_REQUIRED');
      const activation = {
        fromNow: new Date().toISOString(),
        previewRunId: preview.id,
        version: rule.version,
        folderVersions: preview.input.folderVersions,
      };
      await tx.$executeRaw`UPDATE intel_legiwatch_keyword_rule SET state='active',activation=${JSON.stringify(activation)}::jsonb,updated_at=now()
        WHERE tenant_id=${ctx.tenantId} AND owner_clerk_id=${ctx.clerkUserId} AND id=${id}`;
      return this.rules.get(tx, ctx, id);
    });
  }
  /** Explicit tenant from the existing scheduled runner. Only persisted active
   * owner scopes are read under system scope; every action reauthorizes as owner.
   */
  async due(tenantId: string) {
    if (process.env.LEGIWATCH_KEYWORD_DISCOVERY_ENABLED !== 'true')
      return { state: 'disabled', processed: 0 };
    const owners = await this.rules.reports.folders.prisma.withSystem(
      (tx) => tx.$queryRaw<Array<{ id: string; owner_clerk_id: string; version: number }>>`
      SELECT id,owner_clerk_id,version FROM intel_legiwatch_keyword_rule WHERE tenant_id=${tenantId} AND state='active' ORDER BY updated_at,id LIMIT 10`,
    );
    const results = [];
    for (const owner of owners) {
      const ctx = { tenantId, clerkUserId: owner.owner_clerk_id, role: null };
      try {
        await this.rules.authorize(ctx);
        const rule = await this.rules.reports.folders.withActor(ctx, (tx) =>
          this.rules.get(tx, ctx, owner.id),
        );
        const boundary = await this.rules.sources.boundary(rule.config.scope);
        let run = await this.start(ctx, rule.id, {
          expectedVersion: rule.version,
          requestKey:
            'scheduled:' +
            hash({ id: rule.id, version: rule.version, boundary, activation: rule.activation }),
          mode: 'active',
        });
        if (['pending', 'running', 'partial', 'failed'].includes(run.state))
          run = await this.advance(ctx, run.id);
        const pending = await this.rules.reports.folders.withActor(
          ctx,
          (tx) =>
            tx.$queryRaw<
              Suggestion[]
            >`SELECT * FROM intel_legiwatch_suggestion WHERE tenant_id=${tenantId} AND owner_clerk_id=${ctx.clerkUserId} AND run_id=${run.id} AND state='pending' ORDER BY id LIMIT 25`,
        );
        let applied = 0,
          held = 0;
        if (rule.config.mode === 'auto_add')
          for (const s of pending) {
            try {
              const r = await this.decide(
                ctx,
                s.id,
                { action: 'add', expectedVersion: s.version, requestKey: 'automatic:' + s.id },
                true,
              );
              if (r.outcome === 'added') applied++;
              else held++;
            } catch {
              held++;
            }
          }
        await this.rules.reports.folders.withActor(
          ctx,
          (tx) =>
            tx.$executeRaw`UPDATE intel_legiwatch_keyword_rule SET updated_at=now() WHERE tenant_id=${tenantId} AND owner_clerk_id=${ctx.clerkUserId} AND id=${rule.id}`,
        );
        results.push({ ruleId: rule.id, runId: run.id, state: run.state, applied, held });
      } catch {
        results.push({ ruleId: owner.id, state: 'held' });
      }
    }
    return { processed: results.length, results };
  }
}
