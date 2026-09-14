import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { PrismaService as WorkspacePrisma } from '../../workspace/src/prisma/prisma.service.js';
import { DraftsService } from '../../workspace/src/drafts/drafts.service.js';
import { FolderSourceDataRepository } from '../src/sourcedata/folder-source-data.repository.js';
import { SourceDataRepository } from '../src/sourcedata/source-data.repository.js';
import { KeywordSourceRepository } from '../src/sourcedata/keyword-source.repository.js';
import { FolderTrackerService } from '../src/tracker/folders/folder-tracker.service.js';
import { FeatureFlagService } from '../src/feature-flags/feature-flag.service.js';
import { ReportService } from '../src/tracker/reports/report.service.js';
import { KeywordRuleService } from '../src/tracker/keywords/keyword-rule.service.js';
import { KeywordDiscoveryService } from '../src/tracker/keywords/keyword-discovery.service.js';
import { SemanticSuggestionService } from '../src/tracker/keywords/semantic-suggestion.service.js';
import { InternalWorkflowService } from '../src/tracker/keywords/internal-workflow.service.js';
import { WorkflowTriggerService } from '../src/tracker/keywords/workflow-trigger.service.js';
import { CalendarPreparationService } from '../src/tracker/calendar/calendar-preparation.service.js';
import { KeywordMeriController } from '../src/tracker/keywords/keyword-meri.controller.js';
import { ResearchService } from '../src/tracker/research/research.service.js';
import { KeywordDeliveryService } from '../src/tracker/keywords/keyword-delivery.service.js';
import { hash } from '../src/tracker/folders/folder-tracker.service.js';

jest.setTimeout(90000);
describe('Phase 6 committed workflows and cross-service recovery', () => {
  const p = new PrismaService(),
    ws = new WorkspacePrisma(),
    folders = new FolderTrackerService(
      p,
      new FolderSourceDataRepository(p),
      new SourceDataRepository(p),
    );
  const flags = new FeatureFlagService(p, new ConfigService()),
    reports = new ReportService(folders, flags),
    rules = new KeywordRuleService(reports, new KeywordSourceRepository(p));
  const calendar = new CalendarPreparationService(folders, flags),
    actions = new InternalWorkflowService(rules, calendar),
    triggers = new WorkflowTriggerService(actions),
    semantic = new SemanticSuggestionService(rules),
    discovery = new KeywordDiscoveryService(rules),
    delivery = new KeywordDeliveryService(rules);
  const drafts = new DraftsService(ws, {} as never);
  const tenant = randomUUID(),
    actor = 'phase6-workflow-' + randomUUID(),
    session = 'phase6-' + randomUUID().slice(0, 8),
    bill = 'fl-' + randomUUID(),
    second = 'fl-' + randomUUID(),
    event = 'phase6-event-' + randomUUID();
  const ctx = { tenantId: tenant, clerkUserId: actor, role: 'org:admin' };
  let folderId: string,
    originalFetch = global.fetch,
    lost = false,
    failAt: string | null = null;
  beforeAll(async () => {
    if (
      process.env.LEGIWATCH_PHASE6_TEST_DATABASE !== 'disposable' ||
      !['localhost', '127.0.0.1'].includes(new URL(process.env.DATABASE_URL ?? '').hostname)
    )
      throw Error('Disposable local DB required');
    await p.$connect();
    await ws.onModuleInit();
    ws.$use(async (params, next) => {
      if (failAt === params.model + ':' + params.action) {
        failAt = null;
        throw Error('Injected Workspace step failure');
      }
      return next(params);
    });
    await p.withSystem(async (tx) => {
      const user = randomUUID();
      await tx.$executeRaw`INSERT INTO tenants(id,slug,name) VALUES(${tenant}::uuid,${tenant},'Synthetic workflow')`;
      await tx.$executeRaw`INSERT INTO users(id,clerk_user_id,email) VALUES(${user}::uuid,${actor},${actor + '@example.invalid'})`;
      await tx.$executeRaw`INSERT INTO tenant_memberships(tenant_id,user_id,role,status) VALUES(${tenant}::uuid,${user}::uuid,'standard_user','active')`;
      for (const feature of [
        'legiwatch_keyword_discovery_v1',
        'legiwatch_internal_workflows_v1',
        'legiwatch_state_calendar_v1',
        'legiwatch_reports_updates_v1',
        'legiwatch_keyword_delivery_v1',
        'legiwatch_keyword_auto_add_v1',
      ])
        await tx.featureFlag.create({ data: { tenantId: tenant, feature, enabled: true } });
      for (const id of [bill, second])
        await tx.$executeRaw`INSERT INTO state_bill(id,state,session,session_key,identifier,bill_number,title) VALUES(${id},'FL',${session},${session},'HB 6','hb6','Synthetic health coverage')`;
      const snapshot = {
        title: 'Synthetic hearing',
        status: 'scheduled',
        time: {
          date: '2026-09-13',
          timezone: 'America/New_York',
          precision: 'relative',
          rawTime: 'Upon adjournment',
        },
        agenda: [
          { kind: 'bill', bill: { id: bill } },
          { kind: 'bill', bill: { id: second } },
        ],
      };
      await tx.$executeRaw`INSERT INTO committee_hearing(id,committee_name,chamber,title,date,geographic_jurisdiction,legislative_session,calendar_revision,calendar_snapshot,calendar_check_state)
    VALUES(${event},'Synthetic committee','Senate','Synthetic hearing',CURRENT_DATE,'FL',${session},1,${JSON.stringify(snapshot)}::jsonb,'complete')`;
    });
    folderId = (
      await folders.create(ctx, {
        name: 'Synthetic preparation',
        jurisdiction: 'FL',
        defaultSession: session,
      })
    ).id;
    await folders.bulk(ctx, folderId, { action: 'add', billIds: [bill] });
    process.env.LEGIWATCH_INTERNAL_WORKFLOWS_ENABLED = 'true';
    process.env.WORKSPACE_BASE_URL = 'https://workspace.example.invalid';
    process.env.INTERNAL_SERVICE_SECRET = 'test-only';
    global.fetch = jest.fn(async (_url, init) => {
      const request = JSON.parse(String(init!.body)),
        authorized = await actions.authorizedPreparation(ctx, request.actionId);
      const result = await drafts.createPreparation(
        request.tenantId,
        request.ownerId,
        request.actionId,
        authorized.prefill,
      );
      if (lost) {
        lost = false;
        throw Error('Acknowledgement lost after Workspace commit');
      }
      return { ok: true, json: async () => result } as Response;
    });
  });
  afterAll(async () => {
    global.fetch = originalFetch;
    delete process.env.LEGIWATCH_INTERNAL_WORKFLOWS_ENABLED;
    delete process.env.WORKSPACE_BASE_URL;
    delete process.env.INTERNAL_SERVICE_SECRET;
    delete process.env.LEGIWATCH_KEYWORD_DELIVERY_ENABLED;
    await p.$disconnect();
    await ws.$disconnect();
  });
  const input = () => ({
    template: 'hearing_preparation',
    eventId: event,
    folderIds: [folderId],
    jurisdiction: 'FL',
    sessionKey: session,
  });
  async function enqueue() {
    const preview = await actions.preview(ctx, input());
    return actions.enqueue(ctx, {
      input: preview.input,
      inputHash: preview.inputHash,
      requestKey: randomUUID(),
    });
  }
  it('preview has no effects and tenant/actor changes cannot read actions', async () => {
    await actions.preview(ctx, input());
    expect(await ws.wsDraft.count({ where: { tenantId: tenant } })).toBe(0);
    expect(await p.withTenant(tenant, (tx) => tx.legiWatchPreparationSnapshot.count())).toBe(0);
    const action = await enqueue();
    await expect(actions.get({ ...ctx, clerkUserId: 'other' }, action.id)).rejects.toThrow(
      'ACTIVE_MEMBERSHIP_REQUIRED',
    );
    await expect(actions.get({ ...ctx, tenantId: randomUUID() }, action.id)).rejects.toThrow();
  });
  it.each(['WsDraft:create', 'WsDocument:create', 'WsDraft:updateMany', 'WsContextItem:create'])(
    'rolls back Workspace transaction after %s and resumes exactly once',
    async (stage) => {
      const action = await enqueue(),
        before = await ws.wsDraft.count({ where: { tenantId: tenant } });
      failAt = stage;
      await expect(actions.execute(ctx, action.id)).rejects.toThrow();
      expect(await ws.wsDraft.count({ where: { tenantId: tenant } })).toBe(before);
      const done = await actions.execute(ctx, action.id);
      expect(done.state).toBe('complete');
      expect(done.steps.contextItemId).toBeTruthy();
      expect(await ws.wsDraft.count({ where: { tenantId: tenant } })).toBe(before + 1);
      expect((await actions.execute(ctx, action.id)).steps.draftId).toBe(done.steps.draftId);
    },
  );
  it('reconciles lost acknowledgement and preserves user edits on replay', async () => {
    const action = await enqueue();
    lost = true;
    await expect(actions.execute(ctx, action.id)).rejects.toThrow('Acknowledgement lost');
    const pending = await actions.get(ctx, action.id);
    expect(pending.state).toBe('partial');
    const rows = await ws.$queryRaw<
      Array<{ draft_id: string }>
    >`SELECT draft_id::text FROM ws_source_action WHERE tenant_id=${tenant}::uuid AND source_key=${action.id}`;
    await ws.wsDraft.update({
      where: { id: rows[0]!.draft_id },
      data: { docTitle: 'User edited title' },
    });
    const done = await actions.execute(ctx, action.id);
    expect(done.steps.draftId).toBe(rows[0]!.draft_id);
    const draft = await ws.wsDraft.findUniqueOrThrow({ where: { id: done.steps.draftId! } });
    expect(draft.docTitle).toBe('User edited title');
    expect(JSON.stringify(draft.config)).not.toContain('folderContext');
    const receipt = await drafts.createPreparation(
      tenant,
      actor,
      action.id,
      pending.steps.prefill!,
    );
    expect(receipt.replayed).toBe(true);
  });
  it('holds paused actions and detects new assignments without rewriting a frozen preparation', async () => {
    const action = await enqueue();
    await actions.pause(ctx, action.id);
    await expect(actions.execute(ctx, action.id)).rejects.toThrow('WORKFLOW_PAUSED');
    const frozen = await calendar.prepare(
      ctx,
      event,
      { folderIds: [folderId], jurisdiction: 'FL', session },
      'stable-key',
    );
    await folders.bulk(ctx, folderId, { action: 'add', billIds: [second] });
    expect((await calendar.snapshotStatus(ctx, frozen.context.snapshotId)).stale).toBe(true);
    await p.$executeRaw`UPDATE committee_hearing SET title='Rescheduled hearing',calendar_revision=2 WHERE id=${event}`;
    const replay = await calendar.prepare(
      ctx,
      event,
      { folderIds: [folderId], jurisdiction: 'FL', session },
      'stable-key',
    );
    expect(replay).toEqual(frozen);
  });
  it('detects committed additions once and a pause invalidates old workflow actions', async () => {
    const config = await triggers.save(ctx, {
      name: 'Review new bills',
      template: 'added_bill_review',
      config: { folderIds: [folderId], jurisdiction: 'FL', sessionKey: session },
    });
    await triggers.activation(ctx, config!.id, {
      enabled: true,
      expectedVersion: 1,
      baseline: 'from_now',
      reviewed: true,
    });
    await folders.bulk(ctx, folderId, { action: 'remove', billIds: [second] });
    await folders.bulk(ctx, folderId, { action: 'add', billIds: [second] });
    await triggers.detect(tenant);
    await triggers.detect(tenant);
    const rows = (await actions.history(ctx, folderId)).filter((a) => a.workflow_id === config!.id);
    expect(rows).toHaveLength(1);
    await triggers.activation(ctx, config!.id, { enabled: false, expectedVersion: 2 });
    await expect(actions.execute(ctx, rows[0]!.id)).rejects.toThrow('WORKFLOW_PAUSED');
  });
  it('verifies semantic quotes, rejects guessed offsets, and never treats semantic relevance as automatic', async () => {
    const scope = { jurisdiction: 'FL', sessionKey: session, fields: ['title'] },
      base = { scope, folderId, billId: bill };
    const evidence = await semantic.preview(ctx, base),
      doc = evidence.documents![0]!;
    await expect(
      semantic.preview(ctx, {
        ...base,
        documentId: doc.id,
        start: 0,
        end: 3,
        quote: 'BAD',
        explanation: 'Test',
      }),
    ).rejects.toThrow('SOURCE_QUOTE_NOT_VERIFIED');
    const preview = await semantic.preview(ctx, {
        ...base,
        documentId: doc.id,
        start: 0,
        end: 9,
        quote: 'Synthetic',
        explanation: 'Potential client relevance; staff should review.',
      }),
      key = randomUUID();
    const saved = await semantic.save(ctx, {
      input: preview.input,
      previewHash: preview.previewHash,
      requestKey: key,
    });
    expect(
      await semantic.save(ctx, {
        input: preview.input,
        previewHash: preview.previewHash,
        requestKey: key,
      }),
    ).toEqual(saved);
    process.env.LEGIWATCH_KEYWORD_AUTO_ADD_ENABLED = 'true';
    await expect(
      discovery.decide(
        ctx,
        String(saved.suggestionId),
        { expectedVersion: saved.version, requestKey: randomUUID(), action: 'add' },
        true,
      ),
    ).rejects.toThrow('AUTOMATIC_ASSIGNMENT_HELD');
    delete process.env.LEGIWATCH_KEYWORD_AUTO_ADD_ENABLED;
    const bridge = new KeywordMeriController(
      rules,
      discovery,
      actions,
      semantic,
      new ResearchService(rules),
    );
    await expect(
      bridge.route(
        {
          tenantId: tenant,
          actor,
          tool: 'apply_legiwatch_suggestion',
          input: { folderId, suggestionId: saved.suggestionId },
        },
        false,
      ),
    ).rejects.toThrow('TOOL_SURFACE_MISMATCH');
  });
  it('observes a late committed event even after a newer event advances the diagnostic cursor', async () => {
    const config = await triggers.save(ctx, {
      name: 'Late commit review',
      template: 'added_bill_review',
      config: { folderIds: [folderId], jurisdiction: 'FL', sessionKey: session },
    });
    await triggers.activation(ctx, config!.id, {
      enabled: true,
      expectedVersion: 1,
      baseline: 'from_now',
      reviewed: true,
    });
    let release!: () => void, inserted!: () => void;
    const ready = new Promise<void>((r) => (inserted = r)),
      gate = new Promise<void>((r) => (release = r));
    async function insert(tx: any, id: string) {
      await tx.$executeRaw`INSERT INTO intel_legiwatch_decision(id,tenant_id,actor_id,folder_id,bill_id,request_key,request_hash,action,origin,state_version,outcome,payload)
   VALUES(${id},${tenant},${actor},${folderId},${bill},${id},${id},'add','manual',1,'added','{"fixture":"committed event ordering"}'::jsonb)`;
    }
    const late = folders.withActor(
      ctx,
      async (tx) => {
        await insert(tx, randomUUID());
        inserted();
        await gate;
      },
      { timeoutMs: 30000 },
    );
    try {
      await ready;
      await folders.withActor(ctx, (tx) => insert(tx, randomUUID()));
      await triggers.detect(tenant);
      expect(
        (await actions.history(ctx, folderId)).filter((a) => a.workflow_id === config!.id),
      ).toHaveLength(1);
    } finally {
      release();
      await late;
    }
    await triggers.detect(tenant);
    await triggers.detect(tenant);
    expect(
      (await actions.history(ctx, folderId)).filter((a) => a.workflow_id === config!.id),
    ).toHaveLength(2);
  });
  it('preserves imported empty rules, selected raw bytes and actual cadence through typed promotion', async () => {
    const sourceAccount = 'synthetic:' + randomUUID(),
      raw = '  "health care"  ';
    const staged = await folders.withActor(ctx, async (tx) => {
      await tx.legiWatchStagedConfiguration.create({
        data: {
          tenantId: tenant,
          sourceAccount,
          sourceId: 'keyword-1',
          kind: 'bill_keyword',
          provenance: { fixture: true },
          payload: { id: 'keyword-1', exactKeyword: raw },
        },
      });
      return tx.legiWatchStagedConfiguration.create({
        data: {
          tenantId: tenant,
          sourceAccount,
          sourceId: 'capture:alert-36',
          kind: 'alert',
          provenance: { fixture: true },
          payload: {
            family: 'Bill Keyword Alert',
            audit_key: 'alert-36',
            name: 'Synthetic capture',
            frequency: ['End of day'],
            selected_targets: [{ type: 'keyword', selected: [{ id: 'keyword-1' }] }],
          },
        },
      });
    });
    const promoted = await rules.promote(ctx, staged.id, {
      expectedVersion: staged.version,
      sourceHash: hash(staged.payload),
      scope: { jurisdiction: 'FL', sessionKey: session, fields: ['title'] },
    });
    const row = await folders.withActor(ctx, (tx) => rules.get(tx, ctx, promoted.id));
    expect(row.config.definitions[0]!.raw).toBe(raw);
    expect(row.config.cadence).toBe('end_of_day');
    expect(row.config.aggregation).toBe('unqualified');
    expect(row.state).toBe('needs_review');
    expect(row.config.folderIds).toEqual([]);
    const empty = await folders.withActor(ctx, (tx) =>
      tx.legiWatchStagedConfiguration.create({
        data: {
          tenantId: tenant,
          sourceAccount,
          sourceId: 'capture:alert-35',
          kind: 'alert',
          provenance: { fixture: true },
          payload: {
            family: 'Bill Keyword Alert',
            audit_key: 'alert-35',
            name: 'Synthetic empty rule',
            frequency: ['Real time'],
            selected_targets: [{ type: 'keyword', selected: [] }],
          },
        },
      }),
    );
    const emptyPromotion = await rules.promote(ctx, empty.id, {
      expectedVersion: empty.version,
      sourceHash: hash(empty.payload),
      scope: { jurisdiction: 'FL', sessionKey: session, fields: ['title'] },
    });
    const emptyRule = await folders.withActor(ctx, (tx) => rules.get(tx, ctx, emptyPromotion.id));
    expect(emptyRule.config.definitions).toEqual([]);
    expect(emptyRule.state).toBe('needs_review');
    await expect(
      discovery.activation(ctx, emptyRule.id, {
        expectedVersion: emptyRule.version,
        action: 'activate',
        baseline: 'from_now',
      }),
    ).rejects.toThrow('RULE_NOT_READY');
  });
});
