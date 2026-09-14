import {
  Injectable,
  BadRequestException,
  NotFoundException,
  ConflictException,
  ForbiddenException,
  ServiceUnavailableException,
} from '@nestjs/common';

import { randomUUID } from 'node:crypto';

import {
  compareResearchVersions,
  parseFloridaCitation,
  parseFloridaConstitutionCitation,
  legalReferenceKey,
  validDateOnly,
  type ResearchVersion,
  type ResearchSection,
} from '@capiro/shared';

import type { Prisma } from '../../../generated/prisma-client/index.js';

import type { WorkspaceTenantContext } from '../../auth/tenant-context.js';

import { KeywordRuleService } from '../keywords/keyword-rule.service.js';

import { compileKeywordQuery, evaluateKeywordQuery } from '../keywords/keyword-query.js';

import { checkedVersion, requestKey } from '../keywords/keyword-rule.service.js';

import { hash, isFolderAdmin } from '../folders/folder-tracker.service.js';

import { object } from '../reports/report-domain.js';

export const RESEARCH_FEATURE = 'legiwatch_research_v1';

type Scope = {
  jurisdiction: string;
  sessionKey: string;
  folderId: string | null;
  clientId: string | null;
};

type DocumentRow = {
  bill_identifier: string;
  bill_title: string;
  bill_sponsor: string | null;
  bill_chamber: string | null;
  latest_action_text: string | null;
  version_type: string | null;
  document_id: string;
  bill_id: string;
  jurisdiction: string;
  session_key: string;
  revision_hash: string;
  content_hash: string | null;
  extractor_version: string | null;
  source_url: string | null;
  document_kind: string;
  event_date: string | null;
  observed_at: Date;
  coverage: string;
  extraction_state: string;
  sections: ResearchSection[];
  is_current: boolean;
  title: string | null;
};

const scopeOf = (b: Record<string, unknown>): Scope => {
  const jurisdiction = String(b.jurisdiction ?? 'FL'),
    sessionKey = String(b.sessionKey ?? '');

  if (!/^[A-Z]{2}$/.test(jurisdiction) || sessionKey.length > 60)
    throw new BadRequestException('INVALID_RESEARCH_SCOPE');

  for (const key of ['folderId', 'clientId'])
    if (b[key] && (typeof b[key] !== 'string' || String(b[key]).length > 100))
      throw new BadRequestException('INVALID_PRIVATE_SCOPE');

  return {
    jurisdiction,
    sessionKey,
    folderId: b.folderId ? String(b.folderId) : null,
    clientId: b.clientId ? String(b.clientId) : null,
  };
};

const doc = (r: DocumentRow): ResearchVersion => {
  const sections = Array.isArray(r.sections)
    ? r.sections.filter(
        (s) =>
          s &&
          typeof s.locator === 'string' &&
          typeof s.text === 'string' &&
          typeof s.hash === 'string',
      )
    : [];

  return {
    id: r.document_id,
    billId: r.bill_id,
    jurisdiction: r.jurisdiction,
    sessionKey: r.session_key,
    revision: r.revision_hash,
    contentHash: r.content_hash ?? '',
    extractorVersion: r.extractor_version ?? 'unknown',
    sourceUrl: r.source_url,
    kind: r.document_kind,
    publishedDate: r.event_date,
    observedAt: r.observed_at.toISOString(),
    complete:
      r.coverage === 'complete_document' &&
      r.extraction_state === 'extracted' &&
      sections.length > 0 &&
      sections.length === r.sections.length,
    sections,
  };
};

@Injectable()
export class ResearchService {
  constructor(readonly keywords: KeywordRuleService) {}

  async authorize(ctx: WorkspaceTenantContext) {
    await this.keywords.reports.authorize(ctx, RESEARCH_FEATURE);
  }

  async context(
    tx: Prisma.TransactionClient,
    ctx: WorkspaceTenantContext,
    scope: Scope,
    write = false,
  ) {
    if (scope.folderId) {
      const f = await this.keywords.folder(tx, ctx, scope.folderId, write);

      if (scope.clientId && f.clientId !== scope.clientId)
        throw new NotFoundException('RESEARCH_FOLDER_CLIENT_MISMATCH');
    }

    if (scope.clientId) {
      const allowed = await tx.$queryRaw<
        Array<{ id: string }>
      >`SELECT c.id FROM clients c JOIN tenant_memberships m ON m.tenant_id=c.tenant_id AND m.status::text='active' JOIN users u ON u.id=m.user_id AND u.clerk_user_id=${ctx.clerkUserId}

    WHERE c.id::text=${scope.clientId} AND c.tenant_id=${ctx.tenantId}::uuid AND c.status::text<>'archived' AND (NOT c.memory_wall OR EXISTS(SELECT 1 FROM client_memory_access a WHERE a.tenant_id=c.tenant_id AND a.client_id=c.id AND a.user_id=u.id))`;

      if (!allowed.length) throw new NotFoundException('RESEARCH_CLIENT_UNAVAILABLE');
    }
  }

  async run<T>(
    ctx: WorkspaceTenantContext,
    input: unknown,
    fn: (tx: Prisma.TransactionClient, b: Record<string, unknown>, scope: Scope) => Promise<T>,
  ) {
    await this.authorize(ctx);
    const b = object(input),
      scope = scopeOf(b);

    return this.keywords.reports.folders.withActor(
      ctx,
      async (tx) => {
        await this.context(tx, ctx, scope);
        return fn(tx, b, scope);
      },
      { timeoutMs: 30000 },
    );
  }

  async contextVersion(tx: Prisma.TransactionClient, ctx: WorkspaceTenantContext, scope: Scope) {
    const folder = scope.folderId ? await this.keywords.folder(tx, ctx, scope.folderId) : null;

    const clients = scope.clientId
      ? await tx.$queryRaw<
          Array<{ revision: string }>
        >`SELECT md5(to_jsonb(c)::text) AS revision FROM clients c WHERE c.id::text=${scope.clientId} AND c.tenant_id=${ctx.tenantId}::uuid`
      : [];

    return hash({ folder, clientId: scope.clientId, clientRevision: clients[0]?.revision ?? null });
  }

  async coverage(ctx: WorkspaceTenantContext, input: unknown) {
    return this.run(ctx, input, async (tx, _b, scope) => {
      const receipts =
        await tx.$queryRaw`SELECT id,source,scope,manifest,complete,observed_at FROM legal_source_receipt WHERE scope->>'jurisdiction'=${scope.jurisdiction} OR source='fl-far' AND ${scope.jurisdiction}='FL' ORDER BY observed_at DESC LIMIT 20`;

      return { scope, receipts };
    });
  }

  async exact(tx: Prisma.TransactionClient, id: unknown, scope: Scope) {
    if (typeof id !== 'string' || id.length > 180)
      throw new BadRequestException('EXACT_DOCUMENT_ID_REQUIRED');

    const rows = await tx.$queryRaw<
      DocumentRow[]
    >`SELECT * FROM legiwatch_research_document_source WHERE document_id=${id} AND jurisdiction=${scope.jurisdiction} AND (${scope.sessionKey}='' OR session_key=${scope.sessionKey})`;

    if (!rows[0]) throw new NotFoundException('RESEARCH_VERSION_NOT_FOUND');

    return doc(rows[0]);
  }

  async compare(ctx: WorkspaceTenantContext, input: unknown) {
    return this.run(ctx, input, async (tx, b, scope) => {
      const left = await this.exact(tx, b.leftId, scope);

      const rightScope =
        b.allowCrossBill === true
          ? scopeOf({ ...scope, sessionKey: b.rightSessionKey ?? scope.sessionKey })
          : scope;

      const right = await this.exact(tx, b.rightId, rightScope);

      if (left.revision !== b.leftRevision || right.revision !== b.rightRevision)
        throw new ConflictException('EXACT_REVISION_REQUIRED');

      try {
        return { ...compareResearchVersions(left, right, b.allowCrossBill === true), scope };
      } catch (e) {
        throw new BadRequestException((e as Error).message);
      }
    });
  }

  async versions(ctx: WorkspaceTenantContext, input: unknown) {
    return this.run(ctx, input, async (tx, b, scope) => {
      if (typeof b.billId !== 'string' || !scope.sessionKey)
        throw new BadRequestException('BILL_AND_SESSION_REQUIRED');

      const rows = await tx.$queryRaw<
        DocumentRow[]
      >`SELECT * FROM legiwatch_research_document_source WHERE bill_id=${b.billId} AND jurisdiction=${scope.jurisdiction} AND session_key=${scope.sessionKey} ORDER BY document_id COLLATE "C" LIMIT 201`;

      return {
        scope,
        versions: rows.slice(0, 200).map((r) => ({
          ...doc(r),
          sections: undefined,
          title: r.title,
          isCurrent: r.is_current,
        })),
        complete: rows.length <= 200,
        order: 'source_identity_not_legislative_sequence',
      };
    });
  }

  async search(ctx: WorkspaceTenantContext, input: unknown) {
    return this.run(ctx, input, async (tx, b, scope) => {
      if (!scope.sessionKey) throw new BadRequestException('EXPLICIT_SESSION_REQUIRED');

      const expression = typeof b.query === 'string' ? b.query : '',
        compiled = expression ? compileKeywordQuery(expression) : null;

      if (compiled && !compiled.ast)
        throw new BadRequestException({ code: 'QUERY_REQUIRES_REVIEW', compiled });

      const policy = b.versionPolicy ?? 'any_retained';

      if (!['any_retained', 'current_extractions', 'newest_dated_text'].includes(String(policy)))
        throw new BadRequestException('VERSION_POLICY_UNSUPPORTED');
      const stage = String(b.versionStage ?? 'all');
      if (!['all', 'enrolled', 'chaptered'].includes(stage))
        throw new BadRequestException('VERSION_STAGE_UNSUPPORTED');

      const kind = String(b.kind ?? 'all');
      if (!['all', 'text', 'amendment', 'supplement'].includes(kind))
        throw new BadRequestException('DOCUMENT_KIND_UNSUPPORTED');

      if (
        b.billIds !== undefined &&
        (!Array.isArray(b.billIds) ||
          !b.billIds.length ||
          b.billIds.length > 30 ||
          b.billIds.some((id) => typeof id !== 'string' || id.length > 180))
      )
        throw new BadRequestException('INVALID_SELECTED_BILL_SCOPE');

      const billIds = b.billIds ? [...new Set(b.billIds as string[])].sort() : [];
      const filters = {
        title: String(b.title ?? ''),
        sponsor: String(b.sponsor ?? ''),
        chamber: String(b.chamber ?? ''),
        action: String(b.action ?? ''),
      };
      if (Object.values(filters).some((v) => v.length > 160))
        throw new BadRequestException('BOUNDED_BILL_FILTERS_REQUIRED');
      const like = (s: string) => '%' + s.replace(/[%_\\]/g, '\\$&') + '%';

      const binding = hash([
        scope,
        billIds,
        expression,
        policy,
        stage,
        kind,
        filters,
        b.referenceId ?? null,
        ctx.tenantId,
        ctx.clerkUserId,
      ]);

      const fingerprints = await tx.$queryRaw<
        Array<{ value: string; metadata: string }>
      >`SELECT md5(coalesce(string_agg(document_id||revision_hash||is_current::text,'|' ORDER BY document_id COLLATE "C"),'')) AS value,md5(coalesce(string_agg(jsonb_build_array(bill_id,bill_title,bill_sponsor,bill_chamber,latest_action_text)::text,'|' ORDER BY document_id COLLATE "C"),'')) AS metadata FROM legiwatch_research_document_source WHERE jurisdiction=${scope.jurisdiction} AND session_key=${scope.sessionKey} AND (${billIds.length}=0 OR bill_id=ANY(${billIds}::text[]))`;

      const sourceFingerprint = fingerprints[0]!.value,
        fingerprint = sourceFingerprint + ':' + fingerprints[0]!.metadata;
      let after = '';

      if (b.cursor) {
        try {
          const c = JSON.parse(Buffer.from(String(b.cursor), 'base64url').toString());
          if (
            c.binding !== binding ||
            c.fingerprint !== fingerprint ||
            typeof c.after !== 'string' ||
            c.after.length > 180
          )
            throw Error();
          after = c.after;
        } catch {
          throw new ConflictException('SEARCH_CHANGED_RESTART');
        }
      }

      const rows = await tx.$queryRaw<
        DocumentRow[]
      >`SELECT d.* FROM legiwatch_research_document_source d WHERE jurisdiction=${scope.jurisdiction} AND session_key=${scope.sessionKey}

    AND (${billIds.length}=0 OR bill_id=ANY(${billIds}::text[])) AND document_id COLLATE "C">${after} COLLATE "C" AND (${policy}='any_retained' OR is_current) AND (${kind}='all' OR document_kind=${kind})
    AND (${stage}='all' OR document_kind='text' AND lower(version_type)=${stage})
    AND (${policy}<>'newest_dated_text' OR document_kind='text' AND event_date IS NOT NULL AND NOT EXISTS(SELECT 1 FROM legiwatch_research_document_source newer WHERE newer.bill_id=d.bill_id AND newer.jurisdiction=d.jurisdiction AND newer.session_key=d.session_key AND newer.document_kind='text' AND newer.is_current AND newer.event_date>d.event_date))
    AND (${filters.title}='' OR bill_title ILIKE ${like(filters.title)}) AND (${filters.sponsor}='' OR bill_sponsor ILIKE ${like(filters.sponsor)}) AND (${filters.chamber}='' OR bill_chamber=${filters.chamber}) AND (${filters.action}='' OR latest_action_text ILIKE ${like(filters.action)})

    AND (${String(b.referenceId ?? '')}='' OR EXISTS(SELECT 1 FROM legislative_legal_occurrence o WHERE o.document_id=d.document_id AND o.reference_id=${String(b.referenceId ?? '')})) ORDER BY document_id COLLATE "C" LIMIT 26`;

      const items = rows.slice(0, 25).flatMap((r) => {
        const version = doc(r),
          separator =
            version.extractorVersion.includes('character') ||
            version.extractorVersion.includes('html-normalizer')
              ? ''
              : '\n';

        const text = version.sections.map((s) => s.text).join(separator),
          evaluation = compiled ? evaluateKeywordQuery(compiled, text, version.complete) : null;

        if (evaluation && evaluation.outcome !== 'match') return [];

        return [
          {
            ...version,
            sections: undefined,
            title: r.title,
            billTitle: r.bill_title,
            billIdentifier: r.bill_identifier,
            sponsor: r.bill_sponsor,
            chamber: r.bill_chamber,
            lastAction: r.latest_action_text,
            versionType: r.version_type,
            isCurrent: r.is_current,
            excerpt: evaluation?.evidence[0] ?? {
              quote: text.slice(0, 280),
              start: 0,
              end: Math.min(280, text.length),
            },
            evaluation,
          },
        ];
      });

      const receipts = billIds.length
        ? await tx.$queryRaw<
            Array<{ id: string; manifest: Record<string, any>; complete: boolean }>
          >`SELECT id,manifest,complete FROM legal_source_receipt WHERE source='fl-legal-pilot' AND scope->>'jurisdiction'=${scope.jurisdiction} AND scope->>'sessionKey'=${scope.sessionKey} AND scope->'billIds'=${JSON.stringify(billIds)}::jsonb ORDER BY observed_at DESC LIMIT 1`
        : [];

      const [inventoryFingerprint] = await tx.$queryRaw<
        Array<{ value: string }>
      >`SELECT md5(coalesce(string_agg(id||coalesce(legiscan_change_hash,'')||coalesce(report_source_facts->'documentInventory','{}'::jsonb)::text,'|' ORDER BY id COLLATE "C"),'')) AS value FROM state_bill WHERE state=${scope.jurisdiction} AND session_key=${scope.sessionKey} AND id=ANY(${billIds}::text[])`;

      const receipt = receipts[0],
        qualified = Boolean(
          receipt?.manifest.billDocumentCorpusComplete &&
          receipt.manifest.sourceFingerprint === sourceFingerprint &&
          receipt.manifest.inventoryFingerprint === inventoryFingerprint?.value,
        );

      return {
        scope,
        items,
        interpretedQuery: compiled,
        versionPolicy: policy,
        searchedKinds: kind,
        scanned: Math.min(rows.length, 25),
        cursor:
          rows.length > 25
            ? Buffer.from(
                JSON.stringify({ binding, fingerprint, after: rows[24]!.document_id }),
              ).toString('base64url')
            : null,

        coverage: {
          complete: qualified && !b.referenceId,
          reason: b.referenceId
            ? 'LEGAL_REFERENCE_CLASSIFICATION_NOT_QUALIFIED'
            : qualified
              ? 'EXPLICIT_BILL_INVENTORY_ONLY'
              : 'SOURCE_DOCUMENT_INVENTORY_NOT_QUALIFIED',
          manifestId: receipt?.id ?? null,
          billIds,
          retainedVersionsOnly: !qualified,
        },
        message: qualified
          ? 'Coverage is limited to the explicit bill selection and its retained provider inventory.'
          : 'Positive matches use retained source versions. Search completeness requires a qualified provider inventory.',
      };
    });
  }

  async references(ctx: WorkspaceTenantContext, input: unknown) {
    return this.run(ctx, input, async (tx, b, scope) => {
      const raw = String(b.citation ?? '');
      if (raw.length > 180) throw new BadRequestException('CITATION_TOO_LONG');

      const parsed = parseFloridaCitation(raw) ?? parseFloridaConstitutionCitation(raw),
        referenceId = b.referenceId
          ? String(b.referenceId)
          : parsed
            ? legalReferenceKey(parsed)
            : '';

      const edition =
        parsed?.code === 'constitution' || b.code === 'constitution' ? '' : String(b.edition ?? '');
      if (edition && !/^20\d{2}$/.test(edition)) throw new BadRequestException('EDITION_REQUIRED');

      const rows =
        await tx.$queryRaw`SELECT r.*,v.id AS revision_id,v.edition,v.title,v.source_url,v.content_hash,v.extraction_hash,v.parser_version,v.sections,v.history_text,v.complete,v.coverage,v.observed_at FROM legal_reference r LEFT JOIN LATERAL(SELECT * FROM legal_text_revision v WHERE v.reference_id=r.id AND (${edition}='' OR v.edition=${edition}) ORDER BY v.observed_at DESC LIMIT 1) v ON true

    WHERE r.jurisdiction=${scope.jurisdiction} AND r.code_kind IN ('statute','constitution') AND (${String(b.code ?? '')}='' OR r.code_kind=${String(b.code)}) AND (${referenceId}='' OR r.id=${referenceId} OR EXISTS(SELECT 1 FROM legal_reference parent WHERE parent.id=${referenceId} AND parent.reference_kind IN ('chapter','article') AND parent.code_kind=r.code_kind AND parent.chapter=r.chapter)) AND (${raw}='' OR ${referenceId}<>'' OR v.title ILIKE ${'%' + raw.replace(/[%_\\]/g, '\\$&') + '%'}) ORDER BY r.id COLLATE "C" LIMIT 101`;

      const related = referenceId
        ? await tx.$queryRaw`SELECT o.*,d.source_url,d.document_kind,d.is_current FROM legislative_legal_occurrence o JOIN legiwatch_research_document_source d ON d.document_id=o.document_id WHERE o.reference_id=${referenceId} AND (${scope.sessionKey}='' OR o.session_key=${scope.sessionKey}) ORDER BY o.id LIMIT 201`
        : [];

      return {
        scope,
        referenceId,
        edition: edition || null,
        rows,
        related,
        coverage: { complete: false, reason: 'SELECTED_INGESTED_REFERENCES_ONLY' },
      };
    });
  }

  async rules(ctx: WorkspaceTenantContext, input: unknown) {
    return this.run(ctx, input, async (tx, b, scope) => {
      const ruleNumber = String(b.ruleNumber ?? ''),
        noticeId = String(b.noticeId ?? '');
      if (ruleNumber.length > 60 || noticeId.length > 100)
        throw new BadRequestException('INVALID_RULE_FILTER');

      const rows =
        await tx.$queryRaw`SELECT n.id,n.notice_id,n.payload,n.source_url,n.content_hash,n.observed_at FROM rule_notice_revision n JOIN state_rule s ON s.id=n.notice_id

    WHERE s.state=${scope.jurisdiction} AND (${noticeId}='' OR n.notice_id=${noticeId}) AND (${ruleNumber}='' OR EXISTS(SELECT 1 FROM rule_notice_reference x JOIN legal_reference r ON r.id=x.reference_id WHERE x.revision_id=n.id AND r.section=${ruleNumber})) ORDER BY n.observed_at DESC,n.id LIMIT 101`;

      const adopted = ruleNumber
        ? await tx.$queryRaw`SELECT v.id,v.title,v.source_url,v.content_hash,v.extraction_hash,v.sections,v.complete,v.coverage,v.observed_at FROM legal_text_revision v JOIN legal_reference r ON r.id=v.reference_id WHERE r.jurisdiction=${scope.jurisdiction} AND r.code_kind='administrative_rule' AND r.section=${ruleNumber} ORDER BY v.observed_at DESC LIMIT 10`
        : [];
      return {
        scope,
        rows,
        adopted,
        coverage: { complete: false, reason: 'SELECTED_NOTICES_AND_HISTORY_ONLY' },
      };
    });
  }

  async deadlines(ctx: WorkspaceTenantContext, input: unknown) {
    return this.run(ctx, input, async (tx, b, scope) => {
      const from = String(b.from ?? ''),
        to = String(b.to ?? ''),
        noticeId = String(b.noticeId ?? '');

      if ((from && !validDateOnly(from)) || (to && !validDateOnly(to)) || (from && to && from > to))
        throw new BadRequestException('INVALID_DATE_RANGE');

      const rows =
        await tx.$queryRaw`SELECT d.*,n.notice_id,n.source_url,n.payload->>'noticeType' AS notice_type FROM legal_published_date d JOIN rule_notice_revision n ON n.id=d.notice_revision_id JOIN state_rule s ON s.id=n.notice_id

    WHERE s.state=${scope.jurisdiction} AND n.content_hash=s.source_revision AND (${from}='' OR d.date_only>=NULLIF(${from},'')::date) AND (${to}='' OR d.date_only<=NULLIF(${to},'')::date) AND (${noticeId}='' OR n.notice_id=${noticeId}) ORDER BY d.date_only,d.id LIMIT 201`;

      return {
        scope,
        rows,
        kind: 'legal_deadline_overlay',
        captureAllowed: false,
        coverage: { complete: false, reason: 'SOURCE_STATED_DATES_ONLY' },
      };
    });
  }

  async memberships(ctx: WorkspaceTenantContext, input: unknown) {
    return this.run(ctx, input, async (tx, b, scope) => {
      if (!scope.folderId) throw new BadRequestException('FOLDER_REQUIRED');

      return tx.$queryRaw`SELECT m.*,r.identity FROM intel_legiwatch_legal_membership m JOIN legal_reference r ON r.id=m.reference_id WHERE m.tenant_id=${ctx.tenantId} AND m.folder_id=${scope.folderId} AND (${b.includeRemoved === 'true'} OR NOT m.removed) ORDER BY m.reference_id`;
    });
  }

  async saveMembership(ctx: WorkspaceTenantContext, input: unknown) {
    return this.run(ctx, input, async (tx, b, scope) => {
      if (!scope.folderId) throw new BadRequestException('FOLDER_REQUIRED');
      await this.context(tx, ctx, scope, true);

      const key = requestKey(b.requestKey),
        expected = checkedVersion(b.expectedVersion),
        referenceId = String(b.referenceId ?? '');

      if (typeof b.remove !== 'boolean')
        throw new BadRequestException('EXPLICIT_MEMBERSHIP_ACTION_REQUIRED');

      const edition = b.edition == null ? null : String(b.edition);
      if (edition !== null && !/^20\d{2}$/.test(edition))
        throw new BadRequestException('INVALID_LEGAL_EDITION');
      const inputHash = hash([scope, referenceId, expected, b.remove, edition]);

      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${ctx.tenantId + ':' + ctx.clerkUserId + ':membership:' + key},0))`;

      const prior = await tx.$queryRaw<
        Array<{ request_hash: string; payload: unknown }>
      >`SELECT request_hash,payload FROM intel_legiwatch_legal_decision WHERE tenant_id=${ctx.tenantId} AND actor_id=${ctx.clerkUserId} AND request_key=${key}`;

      if (prior[0]) {
        if (prior[0].request_hash !== inputHash)
          throw new ConflictException('IDEMPOTENCY_KEY_REUSED');
        return prior[0].payload;
      }

      const ref = await tx.$queryRaw<
        Array<{ id: string }>
      >`SELECT id FROM legal_reference WHERE id=${referenceId} AND jurisdiction=${scope.jurisdiction}`;
      if (!ref.length) throw new NotFoundException('LEGAL_REFERENCE_NOT_FOUND');

      await tx.$queryRaw`SELECT id FROM intel_legiwatch_folder WHERE tenant_id=${ctx.tenantId} AND id=${scope.folderId} FOR UPDATE`;

      const old = await tx.$queryRaw<
        Array<{ version: number }>
      >`SELECT version FROM intel_legiwatch_legal_membership WHERE tenant_id=${ctx.tenantId} AND folder_id=${scope.folderId} AND reference_id=${referenceId} FOR UPDATE`;

      if ((old[0]?.version ?? 0) !== expected)
        throw new ConflictException('MEMBERSHIP_CHANGED_RELOAD');

      await tx.$executeRaw`INSERT INTO intel_legiwatch_legal_membership(tenant_id,folder_id,reference_id,version,removed,edition) VALUES(${ctx.tenantId},${scope.folderId},${referenceId},1,${b.remove},${edition}) ON CONFLICT(tenant_id,folder_id,reference_id) DO UPDATE SET removed=EXCLUDED.removed,edition=coalesce(EXCLUDED.edition,intel_legiwatch_legal_membership.edition),version=intel_legiwatch_legal_membership.version+1`;

      const result = {
        referenceId,
        folderId: scope.folderId,
        version: expected + 1,
        removed: b.remove,
      };

      await tx.$executeRaw`INSERT INTO intel_legiwatch_legal_decision(id,tenant_id,folder_id,actor_id,request_key,request_hash,payload) VALUES(${randomUUID()},${ctx.tenantId},${scope.folderId},${ctx.clerkUserId},${key},${inputHash},${JSON.stringify(result)}::jsonb)`;

      return result;
    });
  }

  async staged(ctx: WorkspaceTenantContext, input: unknown) {
    return this.run(ctx, input, async (tx, b) => {
      if (!isFolderAdmin(ctx)) throw new ForbiddenException('IMPORT_REVIEW_REQUIRES_ADMIN');

      const decisions =
        await tx.$queryRaw`SELECT DISTINCT ON(staged_id) staged_id,outcome,created_at FROM intel_legiwatch_legal_import_decision WHERE tenant_id=${ctx.tenantId} ORDER BY staged_id,created_at DESC,id DESC`;

      const rows = await tx.legiWatchStagedConfiguration.findMany({
        where: {
          tenantId: ctx.tenantId,
          sourceAccount: String(b.sourceAccount ?? 'lobbytools:rubin-turnbull'),
          kind: { in: ['statute', 'alert'] },
        },
        orderBy: { sourceId: 'asc' },
      });

      const mappings = await tx.legiWatchSourceMapping.findMany({
        where: {
          tenantId: ctx.tenantId,
          sourceAccount: String(b.sourceAccount ?? 'lobbytools:rubin-turnbull'),
          kind: 'folder',
        },
        select: { sourceId: true, targetId: true },
      });

      return {
        decisions,
        memberships: rows
          .filter((r) => r.kind === 'statute')
          .map((r) => ({
            ...r,
            sourceHash: hash(r.payload),
            targetFolderId:
              mappings.find((m) => m.sourceId === String(object(r.payload).folder_id))?.targetId ??
              null,
          })),
        rules: rows
          .filter((r) => r.kind === 'alert' && object(r.payload).family === 'Statute Alert')
          .map((r) => ({
            ...r,
            sourceHash: hash(r.payload),
            interpretedName:
              object(r.payload).audit_key === 'alert-23' ? null : object(r.payload).name,
            cadence: null,
            matchActive: false,
            deliveryActive: false,
          })),
        message:
          'Review source targets, current owner and recipients. Captured settings do not activate delivery.',
      };
    });
  }

  async promote(ctx: WorkspaceTenantContext, input: unknown) {
    return this.run(ctx, input, async (tx, b) => {
      if (!isFolderAdmin(ctx)) throw new ForbiddenException('IMPORT_PROMOTION_REQUIRES_ADMIN');

      const staged = await tx.legiWatchStagedConfiguration.findFirst({
        where: { tenantId: ctx.tenantId, id: String(b.stagedId), kind: 'alert' },
      });

      if (!staged || object(staged.payload).family !== 'Statute Alert')
        throw new NotFoundException('STATUTE_RULE_NOT_FOUND');

      if (
        staged.version !== checkedVersion(b.expectedVersion) ||
        hash(staged.payload) !== b.sourceHash
      )
        throw new ConflictException('STAGED_SOURCE_CHANGED');

      const raw = object(staged.payload),
        auditKey = String(raw.audit_key);
      if (!/^alert-2[3-8]$/.test(auditKey))
        throw new BadRequestException('SOURCE_RULE_ID_REQUIRES_REVIEW');

      const groups = Array.isArray(raw.selected_targets) ? raw.selected_targets.map(object) : [];

      const sourceFolderIds = groups
        .filter((g) => g.type === 'folder')
        .flatMap((g) =>
          Array.isArray(g.selected) ? g.selected.map((s) => String(object(s).id)) : [],
        );

      const config = {
        kind: 'statute_reference',
        sourceFolderIds,
        raw: staged.payload,
        cadence: null,
        folderIds: [],
        recipients: [],
        matchActive: false,
        deliveryActive: false,
        internalFollowupActive: false,
      };

      const id = randomUUID();

      await tx.$executeRaw`INSERT INTO intel_legiwatch_statute_rule(id,tenant_id,owner_clerk_id,staged_id,name,source_id,source_hash,config) VALUES(${id},${ctx.tenantId},${ctx.clerkUserId},${staged.id},${auditKey === 'alert-23' ? null : String(raw.name ?? '')},${staged.sourceId},${hash(staged.payload)},${JSON.stringify(config)}::jsonb) ON CONFLICT(tenant_id,staged_id) DO NOTHING`;

      const stored = await tx.$queryRaw<
        Array<{ id: string }>
      >`SELECT id FROM intel_legiwatch_statute_rule WHERE tenant_id=${ctx.tenantId} AND staged_id=${staged.id} AND owner_clerk_id=${ctx.clerkUserId}`;

      if (!stored[0]) throw new ConflictException('STATUTE_RULE_OWNERSHIP_REVIEW_REQUIRED');

      await tx.legiWatchPromotion.upsert({
        where: { tenantId_stagedId: { tenantId: ctx.tenantId, stagedId: staged.id } },
        create: {
          tenantId: ctx.tenantId,
          stagedId: staged.id,
          sourceAccount: staged.sourceAccount,
          sourceId: staged.sourceId,
          sourceVersion: staged.version,
          sourceHash: hash(staged.payload),
          kind: 'statute_reference',
          targetId: stored[0].id,
          reviewedBy: ctx.clerkUserId,
        },
        update: {},
      });

      return tx.$queryRaw`SELECT id,name,config,version,state FROM intel_legiwatch_statute_rule WHERE tenant_id=${ctx.tenantId} AND staged_id=${staged.id} AND owner_clerk_id=${ctx.clerkUserId}`;
    });
  }

  async saveResearch(ctx: WorkspaceTenantContext, input: unknown) {
    const selection = await this.run(ctx, input, async (tx, b, scope) => {
      const key = requestKey(b.requestKey),
        title = String(b.title ?? 'Legislative research'),
        analysis = String(b.analysis ?? '');

      if (
        title.length > 200 ||
        analysis.length > 30000 ||
        !Array.isArray(b.documents) ||
        !b.documents.length ||
        b.documents.length > 10 ||
        !Array.isArray(b.citations) ||
        !b.citations.length ||
        b.citations.length > 100
      )
        throw new BadRequestException('BOUNDED_CITED_RESEARCH_REQUIRED');

      const inputHash = hash(b);

      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${ctx.tenantId + ':' + ctx.clerkUserId + ':research:' + key},0))`;

      const prior = await tx.$queryRaw<
        Array<{ id: string; input_hash: string }>
      >`SELECT id,input_hash FROM intel_legiwatch_research_selection WHERE tenant_id=${ctx.tenantId} AND owner_clerk_id=${ctx.clerkUserId} AND request_key=${key}`;

      if (prior[0]) {
        if (prior[0].input_hash !== inputHash)
          throw new ConflictException('RESEARCH_REQUEST_CHANGED');
        return prior[0].id;
      }

      const documents: ResearchVersion[] = [];

      for (const item of b.documents) {
        const selected = object(item);
        const selectedSession = selected.sessionKey ?? scope.sessionKey;
        if (
          selectedSession !== scope.sessionKey &&
          (b.allowCrossBill !== true || selectedSession !== b.rightSessionKey)
        )
          throw new BadRequestException('EXPLICIT_CROSS_SESSION_SELECTION_REQUIRED');
        const selectedScope = scopeOf({ ...scope, sessionKey: selectedSession });
        const version = await this.exact(tx, selected.id, selectedScope);
        if (version.revision !== selected.revision)
          throw new ConflictException('RESEARCH_DOCUMENT_CHANGED');
        documents.push(version);
      }

      const citations = b.citations.map((item) => {
        const c = object(item),
          version = documents.find((d) => d.id === c.documentId && d.revision === c.revision),
          section = version?.sections.find((s) => s.locator === c.locator);

        if (
          !section ||
          !Number.isInteger(c.start) ||
          !Number.isInteger(c.end) ||
          Number(c.start) < 0 ||
          Number(c.end) <= Number(c.start) ||
          Number(c.end) > section.text.length ||
          section.text.slice(Number(c.start), Number(c.end)) !== c.quote
        )
          throw new BadRequestException('CITATION_DOES_NOT_MATCH_SELECTED_SOURCE');

        return { ...c, sourceUrl: version!.sourceUrl };
      });

      const contextVersion = await this.contextVersion(tx, ctx, scope);

      const id = randomUUID(),
        payload = {
          scope,
          title,
          analysis,
          citations,
          contextVersion,
          authorId: ctx.clerkUserId,
          documents: documents.map(({ sections, ...d }) => d),
          generatedAt: new Date().toISOString(),
          authority: 'Capiro analysis for review',
          sourceCutoff: documents.map((d) => ({ id: d.id, observedAt: d.observedAt })),
        };

      await tx.$executeRaw`INSERT INTO intel_legiwatch_research_selection(id,tenant_id,owner_clerk_id,folder_id,client_id,request_key,input_hash,payload) VALUES(${id},${ctx.tenantId},${ctx.clerkUserId},${scope.folderId},${scope.clientId},${key},${inputHash},${JSON.stringify(payload)}::jsonb)`;

      return id;
    });

    return this.createWorkspace(ctx, selection);
  }

  async createWorkspace(ctx: WorkspaceTenantContext, selection: string) {
    await this.researchSource(ctx, selection);

    const base = process.env.WORKSPACE_BASE_URL,
      secret = process.env.INTERNAL_SERVICE_SECRET;

    if (!base || !secret)
      return { selectionId: selection, state: 'saved', draftState: 'workspace_not_configured' };

    const response = await fetch(
      base.replace(/\/+$/, '') + '/workspace-api/internal/legiwatch/research',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-internal-service-secret': secret },
        body: JSON.stringify({
          tenantId: ctx.tenantId,
          ownerId: ctx.clerkUserId,
          actionId: selection,
        }),
        signal: AbortSignal.timeout(25000),
        redirect: 'error',
      },
    );

    if (!response.ok)
      throw new ServiceUnavailableException({
        code: 'RESEARCH_DRAFT_HELD_RETRY_SAME_REQUEST',
        selectionId: selection,
      });

    return { selectionId: selection, draft: await response.json() };
  }

  async researchSource(ctx: WorkspaceTenantContext, id: string) {
    await this.authorize(ctx);

    return this.keywords.reports.folders.withActor(ctx, async (tx) => {
      const rows = await tx.$queryRaw<
        Array<{ id: string; input_hash: string; payload: Record<string, unknown> }>
      >`SELECT id,input_hash,payload FROM intel_legiwatch_research_selection WHERE tenant_id=${ctx.tenantId} AND owner_clerk_id=${ctx.clerkUserId} AND id=${id}`;

      if (!rows[0]) throw new NotFoundException('RESEARCH_SELECTION_NOT_FOUND');
      const row = rows[0],
        scope = scopeOf(object(row.payload.scope));
      await this.context(tx, ctx, scope);

      const selected = Array.isArray(row.payload.documents)
        ? row.payload.documents.map(object)
        : [];

      const staleReasons: string[] = [];
      const deadline = object(row.payload.deadline);
      if (deadline.id) {
        const current = await tx.$queryRaw<
          Array<{ id: string }>
        >`SELECT d.id FROM legal_published_date d JOIN rule_notice_revision n ON n.id=d.notice_revision_id JOIN state_rule s ON s.id=n.notice_id WHERE d.id=${String(deadline.id)} AND d.notice_revision_id=${String(deadline.notice_revision_id)} AND n.content_hash=s.source_revision AND s.rule_type<>'withdrawal' AND NOT d.canceled`;
        if (!current.length) staleReasons.push('PUBLISHED_DATE_REVISED_OR_WITHDRAWN');
        const linked = await tx.$queryRaw<
          Array<{ id: string }>
        >`SELECT n.id FROM rule_notice_revision n JOIN state_rule s ON s.id=n.notice_id AND s.source_revision=n.content_hash WHERE s.rule_type IN ('withdrawal','correction','change') AND n.notice_id<>${String(deadline.notice_id)} AND EXISTS(SELECT 1 FROM jsonb_array_elements_text(coalesce(n.payload->'linkedNotices','[]'::jsonb)) AS links(url) WHERE substring(url from '(?i)[?&]id=([0-9]+)')=${String(deadline.notice_id).replace(/^FL-/, '')}) LIMIT 1`;
        if (linked.length) staleReasons.push('RELATED_NOTICE_CHANGED_REVIEW_REQUIRED');
      }

      if (row.payload.contextVersion !== (await this.contextVersion(tx, ctx, scope)))
        staleReasons.push('CLIENT_OR_FOLDER_CONTEXT_CHANGED');

      for (const selectedDocument of selected) {
        const current = await tx.$queryRaw<
          Array<{ is_current: boolean }>
        >`SELECT is_current FROM legiwatch_research_document_source WHERE document_id=${String(selectedDocument.id)} AND revision_hash=${String(selectedDocument.revision)}`;
        if (!current[0]?.is_current)
          staleReasons.push('SELECTED_DOCUMENT_HAS_NEWER_EVIDENCE:' + String(selectedDocument.id));
      }

      return {
        actionId: id,
        stale: staleReasons.length > 0,
        staleReasons,
        prefill: {
          draft: { docTitle: String(row.payload.title) },
          context: { ...row.payload, snapshotId: id, contentHash: row.input_hash },
          sources: row.payload.documents,
        },
      };
    });
  }

  async researchAccess(ctx: WorkspaceTenantContext, id: string) {
    return this.keywords.reports.folders.withActor(ctx, async (tx) => {
      const rows = await tx.$queryRaw<
        Array<{ payload: Record<string, unknown> }>
      >`SELECT payload FROM intel_legiwatch_research_selection WHERE tenant_id=${ctx.tenantId} AND owner_clerk_id=${ctx.clerkUserId} AND id=${id}`;

      if (!rows[0]) throw new NotFoundException('RESEARCH_SELECTION_NOT_FOUND');

      await this.context(tx, ctx, scopeOf(object(rows[0].payload.scope)));

      return { selectionId: id, allowed: true };
    });
  }
}
