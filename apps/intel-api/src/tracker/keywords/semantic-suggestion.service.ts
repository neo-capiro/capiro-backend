import { Injectable, BadRequestException, ConflictException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { WorkspaceTenantContext } from '../../auth/tenant-context.js';
import { KeywordRuleService, requestKey } from './keyword-rule.service.js';
import { keywordScope } from '../../sourcedata/keyword-source.repository.js';
import { object } from '../reports/report-domain.js';
import { hash } from '../folders/folder-tracker.service.js';
import { membershipState } from '../folders/folder-decisions.js';
@Injectable()
export class SemanticSuggestionService {
  constructor(readonly rules: KeywordRuleService) {}
  async preview(ctx: WorkspaceTenantContext, body: unknown) {
    await this.rules.authorize(ctx);
    const b = object(body),
      scope = keywordScope(b.scope);
    if (typeof b.folderId !== 'string' || typeof b.billId !== 'string')
      throw new BadRequestException('EXACT_BILL_AND_FOLDER_REQUIRED');
    const source = await this.rules.sources.bill(scope, b.billId);
    if (!source) throw new BadRequestException('CANONICAL_BILL_SCOPE_UNAVAILABLE');
    const folder = await this.rules.reports.folders.withActor(ctx, (tx) =>
      this.rules.folder(tx, ctx, b.folderId as string),
    );
    if (typeof b.explanation !== 'string' || !b.explanation.trim()) {
      return {
        bill: source.bill,
        coverage: source.coverage,
        documents: source.documents.map((d) => ({
          ...d,
          text: d.text?.slice(0, 12000),
          excerptOnly: !!d.text && d.text.length > 12000,
        })),
        effects: [],
        previewHash: null,
      };
    }
    if (
      b.explanation.length > 2000 ||
      !Number.isSafeInteger(b.start) ||
      !Number.isSafeInteger(b.end) ||
      Number(b.start) < 0 ||
      Number(b.end) <= Number(b.start) ||
      Number(b.end) - Number(b.start) > 2000 ||
      typeof b.quote !== 'string'
    )
      throw new BadRequestException('BOUNDED_SOURCE_QUOTE_AND_RATIONALE_REQUIRED');
    const document = source.documents.find((d) => d.id === b.documentId);
    if (!document?.text || document.text.slice(Number(b.start), Number(b.end)) !== b.quote)
      throw new ConflictException('SOURCE_QUOTE_NOT_VERIFIED');
    const input = {
      scope,
      folderId: folder.id,
      billId: source.bill.id,
      explanation: b.explanation,
      documentId: document.id,
      start: Number(b.start),
      end: Number(b.end),
      quote: b.quote,
    };
    const binding = { input, sourceFingerprint: source.fingerprint, folderVersion: folder.version };
    return {
      input,
      binding,
      previewHash: hash(binding),
      coverage: source.coverage,
      effects: [{ kind: 'pending_semantic_suggestion', automaticAssignment: false }],
      source,
    };
  }
  async save(ctx: WorkspaceTenantContext, body: unknown) {
    const b = object(body),
      key = requestKey(b.requestKey),
      p = await this.preview(ctx, b.input);
    if (!p.previewHash || p.previewHash !== b.previewHash || !p.input || !p.source)
      throw new ConflictException('CURRENT_SEMANTIC_PREVIEW_REQUIRED');
    const binding = hash([p.previewHash, key]),
      input = p.input,
      source = p.source;
    return this.rules.reports.folders.withActor(ctx, async (tx) => {
      const locked = await this.rules.sources.lockBill(tx, input.scope, input.billId);
      if (locked?.fingerprint !== source.fingerprint) throw new ConflictException('SOURCE_CHANGED');
      const folder = await this.rules.folder(tx, ctx, input.folderId, true);
      if (folder.version !== p.binding.folderVersion) throw new ConflictException('FOLDER_CHANGED');
      const [old] = await tx.$queryRaw<
        Array<{ payload: Record<string, unknown> }>
      >`SELECT payload FROM intel_legiwatch_suggestion_operation WHERE tenant_id=${ctx.tenantId} AND owner_clerk_id=${ctx.clerkUserId} AND request_key=${key}`;
      if (old) {
        if (old.payload.binding !== binding)
          throw new ConflictException('SEMANTIC_REQUEST_KEY_REUSED');
        return old.payload;
      }
      const ruleId = 'meri:' + hash([ctx.tenantId, ctx.clerkUserId, folder.id, input.scope]);
      const config = {
        scope: input.scope,
        folderIds: [folder.id],
        definitions: [],
        aggregation: 'unqualified',
        semanticsReviewed: false,
        mode: 'suggest',
        cadence: 'realtime',
        timezone: null,
        localMinutes: null,
        source: { kind: 'meri_suggestions' },
        deliveryEnabled: false,
      };
      await tx.$executeRaw`INSERT INTO intel_legiwatch_keyword_rule(id,tenant_id,owner_clerk_id,name,config) VALUES(${ruleId},${ctx.tenantId},${ctx.clerkUserId},'Meri relevance suggestions',${JSON.stringify(config)}::jsonb) ON CONFLICT DO NOTHING`;
      const runId = randomUUID(),
        state = await membershipState(tx, ctx, folder.id, input.billId),
        fingerprint = hash([ruleId, p.previewHash, state.human_revision]);
      const runInput = {
        mode: 'semantic',
        folderVersions: { [folder.id]: folder.version },
        rule: { id: ruleId, version: 1, config },
      };
      await tx.$executeRaw`INSERT INTO intel_legiwatch_discovery_run(id,tenant_id,owner_clerk_id,rule_id,rule_version,request_key,input_hash,input,state,source_boundary)
    VALUES(${runId},${ctx.tenantId},${ctx.clerkUserId},${ruleId},1,${'semantic:' + key},${p.previewHash},${JSON.stringify(runInput)}::jsonb,'complete',${source.fingerprint})`;
      const d = source.documents.find((d) => d.id === input.documentId)!;
      const payload = {
        bill: source.bill,
        sourceFingerprint: source.fingerprint,
        folderVersion: folder.version,
        stateVersion: state.version,
        coverage: source.coverage,
        sourceScope: input.scope,
        origin: 'semantic',
        explanation: input.explanation,
        matches: [
          {
            document: { id: d.id, kind: d.kind, revision: d.revision, sourceUrl: d.sourceUrl },
            evaluation: {
              results: [
                {
                  id: 'meri-relevance',
                  outcome: 'suggestion',
                  evidence: [
                    {
                      quote: input.quote,
                      expression: 'Meri relevance — review required',
                      start: input.start,
                      end: input.end,
                    },
                  ],
                },
              ],
            },
          },
        ],
      };
      await tx.$executeRaw`INSERT INTO intel_legiwatch_suggestion(id,tenant_id,owner_clerk_id,rule_id,rule_version,run_id,folder_id,bill_id,fingerprint,payload)
    VALUES(${randomUUID()},${ctx.tenantId},${ctx.clerkUserId},${ruleId},1,${runId},${folder.id},${input.billId},${fingerprint},${JSON.stringify(payload)}::jsonb) ON CONFLICT DO NOTHING`;
      const [s] = await tx.$queryRaw<
        Array<{ id: string; version: number }>
      >`SELECT id,version FROM intel_legiwatch_suggestion WHERE tenant_id=${ctx.tenantId} AND owner_clerk_id=${ctx.clerkUserId} AND folder_id=${folder.id} AND bill_id=${input.billId} AND fingerprint=${fingerprint}`;
      const receipt = {
        binding,
        suggestionId: s!.id,
        version: s!.version,
        origin: 'semantic',
        state: 'pending',
      };
      await tx.$executeRaw`INSERT INTO intel_legiwatch_suggestion_operation(id,tenant_id,owner_clerk_id,request_key,outcome,payload) VALUES(${randomUUID()},${ctx.tenantId},${ctx.clerkUserId},${key},'suggested',${JSON.stringify(receipt)}::jsonb)`;
      return receipt;
    });
  }
}
