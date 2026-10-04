import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Prisma } from '@prisma/client';
import type { TenantContext } from '@capiro/shared';
import type { MeriServerReadonlyCapturePolicy } from '@capiro/meriv2-core';
import type { PrismaService } from '../prisma/prisma.service.js';
import { captureBudgetHash } from './meri-capture-provider-budget.js';
import {
  assertMeriServerReadonlyCaptureCurrentAuthority,
  issueMeriServerReadonlyCapturePolicy,
} from './meri-server-readonly-capture.js';
import {
  currentMeriToolCapturePolicy,
  assertMeriToolRequestActive,
} from './meri-tool-request-control.js';
import { currentMeriServerReadonlyCapturePolicy } from './meri-context-plane-runtime.js';
import { parseDocumentReadInput } from './meri-document-read.helpers.js';
import { createControlledBudgetToolResult } from './meri-controlled-budget-result.js';
import {
  fundingClaimsForModel,
  modelBudgetLineMetadata,
} from './meri-defense-budget-tool.helpers.js';

type Read = {
  logicalId: string;
  physicalId: string;
  kind: string;
  version: string;
  content: string;
  contentSha256: string;
  facts: Record<string, any>;
};
export interface ControlledReadFixtureProof {
  fixtureReady: true;
  missing: string[];
  liveAcceptance: 'NOT_RUN';
  fixtureNamespace: string;
  fixtureVersion: string;
  tenantId: string;
  actorUserId: string;
  clientId: string;
  caseId: ControlledReadCase;
  captureRunId: string;
  sourceMap: Record<string, Record<string, unknown>>;
  physicalMapSha256: string;
  currentVerify: Record<string, unknown>;
  currentVerifySha256: string;
  seedReceiptId: string;
  resetReceiptId: string;
  definition: {
    reads: Read[];
    physicalMapSha256: string;
    coverage?: Record<string, unknown> | null;
  };
}
interface OwnerModule {
  qualifyControlledReadInTx(
    tx: Prisma.TransactionClient,
    ctx: TenantContext,
    scope: { caseId: string; clientId: string; captureRunId: string },
  ): Promise<ControlledReadFixtureProof>;
}
let ownerModule: Promise<OwnerModule> | undefined;
type ControlledReadCase = '20' | '21' | '22' | '23' | '24' | '26' | '27' | '72';
export function isMeriControlledReadCase(caseId: unknown): caseId is ControlledReadCase {
  return (
    typeof caseId === 'string' && ['20', '21', '22', '23', '24', '26', '27', '72'].includes(caseId)
  );
}
function denied(reason: string): never {
  throw new Error(`meri_controlled_read_${reason}`);
}
async function fixedOwner() {
  if (process.env.MERI_SYNTHETIC_FIXTURE_NAMESPACE !== 'meri-foundation-20260928')
    denied('namespace_required');
  ownerModule ??= import(
    pathToFileURL(
      resolve(
        __dirname,
        '../../../../evals/meri/live-v1/fixture-provisioning/controlled-read-owner.mjs',
      ),
    ).href
  ) as Promise<OwnerModule>;
  return ownerModule;
}

/** Hydration is fixed source code, with no request-supplied callback/module/text. */
export async function qualifyMeriControlledReadInTx(
  tx: Prisma.TransactionClient,
  ctx: TenantContext,
  scope: { caseId: string; clientId: string; captureRunId: string },
) {
  if (!isMeriControlledReadCase(scope.caseId)) denied('case_not_qualified');
  return (await fixedOwner()).qualifyControlledReadInTx(tx, ctx, scope);
}
export async function assertMeriControlledReadBindingInTx(
  tx: Prisma.TransactionClient,
  ctx: TenantContext,
  policy: MeriServerReadonlyCapturePolicy,
) {
  if (!isMeriControlledReadCase(policy.caseId) || !policy.clientId || !policy.captureRunId)
    denied('binding_missing');
  const proof = await qualifyMeriControlledReadInTx(tx, ctx, {
    caseId: policy.caseId,
    clientId: policy.clientId,
    captureRunId: policy.captureRunId,
  });
  const tenant = await tx.tenant.findUnique({
    where: { id: ctx.tenantId },
    select: { settings: true },
  });
  const binding = (tenant?.settings as any)?.meriFoundationFixture?.captureEvidence;
  if (
    !binding ||
    proof.fixtureReady !== true ||
    proof.missing.length ||
    binding.actorUserId !== ctx.userId ||
    binding.clientId !== policy.clientId ||
    proof.tenantId !== ctx.tenantId ||
    proof.actorUserId !== ctx.userId ||
    proof.clientId !== policy.clientId ||
    proof.caseId !== policy.caseId ||
    proof.captureRunId !== policy.captureRunId ||
    proof.fixtureNamespace !== policy.fixtureNamespace ||
    proof.fixtureVersion !== policy.fixtureVersion ||
    proof.seedReceiptId !== policy.seedReceiptId ||
    proof.resetReceiptId !== policy.resetReceiptId ||
    proof.physicalMapSha256 !== policy.physicalMapSha256 ||
    captureBudgetHash(proof.sourceMap) !== proof.physicalMapSha256 ||
    captureBudgetHash(proof.currentVerify) !== proof.currentVerifySha256 ||
    binding.currentVerifySha256 !== proof.currentVerifySha256
  )
    denied('current_proof_mismatch');
  return proof;
}
export async function readMeriControlledFixture(args: {
  prisma: PrismaService;
  ctx: TenantContext;
  policy: MeriServerReadonlyCapturePolicy;
}) {
  if (args.policy.expectedCaptureWrites[3] !== 'provider_budget_ledger')
    denied('provider_qualification_required');
  await assertMeriServerReadonlyCaptureCurrentAuthority(args);
  return args.prisma.withTenantUser(args.ctx.tenantId, args.ctx.userId, (tx) =>
    assertMeriControlledReadBindingInTx(tx, args.ctx, args.policy),
  );
}

const http200Results = new WeakSet<object>();
/** Only actual objects returned by this source-owned dispatcher change status. */
export function meriControlledReadHttpStatus(value: unknown): 200 | undefined {
  return value !== null && typeof value === 'object' && http200Results.has(value) ? 200 : undefined;
}
export function controlledReadToolAllowed(caseId: string | null, tool: string): boolean {
  return isMeriControlledReadCase(caseId) && caseId !== '72'
    ? ['search_program_elements', 'get_program_element', 'get_pe_budget_timeline'].includes(tool)
    : caseId === '72' && tool === 'read_client_documents';
}

/** Real tool result boundary. No final-answer substitution or global corpus I/O.
 * Tool call IDs come from the ordinary invoker; this owner never invents them.
 */
export async function tryExecuteMeriControlledRead(
  prisma: PrismaService,
  ctx: TenantContext,
  tool: string,
  input: Record<string, unknown>,
): Promise<Record<string, unknown> | undefined> {
  const policy = currentMeriToolCapturePolicy() ?? currentMeriServerReadonlyCapturePolicy();
  if (!policy || !isMeriControlledReadCase(policy.caseId)) return undefined;
  if (!controlledReadToolAllowed(policy.caseId, tool)) denied('tool_outside_case');
  assertMeriToolRequestActive();
  if (!policy.turnId) denied('actual_turn_required');
  const proof = await readMeriControlledFixture({ prisma, ctx, policy });
  const read = proof.definition.reads[0];
  if (!read) denied('source_missing');
  const provenance = {
    owner: 'meri_controlled_read_v1',
    synthetic: true,
    sourceStorage: 'immutable_source_owned_controlled_adapter',
    caseId: policy.caseId,
    captureRunId: policy.captureRunId,
    requestId: policy.requestId,
    traceId: policy.traceId,
    turnId: policy.turnId,
    conversationId: policy.conversationId,
    tenantId: ctx.tenantId,
    actorUserId: ctx.userId,
    clientId: policy.clientId,
    sourceTenantId: ctx.tenantId,
    sourceClientId: policy.caseId === '72' ? policy.clientId : null,
    physicalMapSha256: proof.physicalMapSha256,
    currentVerifySha256: proof.currentVerifySha256,
    sourceId: read.physicalId,
    logicalSourceId: read.logicalId,
    sourceVersion: read.version,
    contentSha256: read.contentSha256,
  };
  let result: Record<string, unknown>;
  if (policy.caseId !== '20' && policy.caseId !== '72') {
    result = createControlledBudgetToolResult(proof, tool, input, provenance);
  } else if (policy.caseId === '72') {
    if (
      input.clientId !== policy.clientId ||
      Object.keys(input).some(
        (key) =>
          ![
            'clientId',
            'documentId',
            'query',
            'limit',
            'section',
            'characterOffset',
            'cursor',
          ].includes(key),
      )
    )
      denied('document_scope_invalid');
    const selection = parseDocumentReadInput(input, policy.clientId!);
    if (selection.documentId && selection.documentId !== read.physicalId)
      denied('document_scope_invalid');
    if (
      selection.cursor ||
      selection.listAfter ||
      selection.section !== 1 ||
      selection.offset !== 0 ||
      selection.query
    )
      denied('document_selector_unsupported');
    result = selection.documentId
      ? {
          error: read.facts.adapterResponse.body.error,
          controlledRead: { ...provenance, fault: 'http200_logical_error' },
        }
      : {
          tool,
          clientId: policy.clientId,
          coverage: {
            total: 1,
            returned: 1,
            truncated: false,
            nextCursor: null,
            complete: true,
            paginationComplete: true,
          },
          documents: [
            {
              id: read.physicalId,
              fileName: 'Aster latest memo',
              contentType: 'text/plain',
              usable: true,
              disclosure:
                'Controlled synthetic memo adapter; read by documentId to observe its owner response.',
            },
          ],
          controlledRead: provenance,
        };
  } else {
    const code = read.facts.peCode;
    const search = tool === 'search_program_elements';
    const allowed = search ? ['query', 'q', 'limit', 'page'] : ['peCode'];
    if (
      Object.keys(input).some((key) => !allowed.includes(key)) ||
      (search
        ? (input.query ?? input.q) !== code ||
          (input.page !== undefined && input.page !== 1) ||
          (input.limit !== undefined &&
            (!Number.isSafeInteger(input.limit) ||
              Number(input.limit) < 1 ||
              Number(input.limit) > 50))
        : input.peCode !== code)
    )
      denied('budget_selector_unsupported');
    const record = {
      id: read.physicalId,
      sourceId: read.physicalId,
      sourceVersion: read.version,
      title: read.logicalId,
      page: read.facts.page,
      text: read.content,
      contentSha256: read.contentSha256,
      source: { recordId: read.physicalId, version: read.version, kind: read.kind },
      controlled: true,
    };
    const claims = fundingClaimsForModel(
      [{ fy: read.facts.fiscalYear, request: read.facts.amountUsd / 1_000_000 }],
      read.facts.fiscalYear,
    );
    const identity = modelBudgetLineMetadata({
      peCode: code,
      appropriationType: 'RDT&E',
      budgetActivity: null,
      lineType: null,
    });
    const programElement = {
      peCode: code,
      title: `Controlled synthetic ${read.logicalId}`,
      ...identity,
      years: claims.years,
    };
    result = {
      tool,
      ...identity,
      peCode: code,
      currentCycleFy: claims.currentCycleFy,
      currentFundingClaim: claims.currentFundingClaim,
      records: [record],
      // Completeness is for this exact source-owned response, not the public
      // corpus. The current fixture/binding is rechecked before release below.
      coverage: {
        total: 1,
        returned: 1,
        complete: true,
        paginationComplete: true,
        truncated: false,
        nextCursor: null,
      },
      controlledRead: provenance,
      ...(search
        ? { data: [programElement], total: 1, page: 1, limit: input.limit ?? 20 }
        : tool === 'get_program_element'
          ? { programElement }
          : { years: claims.years }),
    };
  }
  // Recheck current permissions/binding after source resolution, before release.
  await readMeriControlledFixture({ prisma, ctx, policy });
  assertMeriToolRequestActive();
  http200Results.add(result);
  return result;
}

/** Open the actual current controlled source via the existing source viewer. */
export async function readMeriControlledSource(
  prisma: PrismaService,
  ctx: TenantContext,
  input: {
    recordId: string;
    clientId?: string;
    conversationId?: string;
    version?: string;
    section?: string;
    cursor?: string;
  },
) {
  if (!input.conversationId || !input.clientId || input.cursor) denied('source_locator_invalid');
  const policy = await issueMeriServerReadonlyCapturePolicy({
    prisma,
    ctx,
    conversationId: input.conversationId,
  });
  if (
    !policy ||
    !isMeriControlledReadCase(policy.caseId) ||
    policy.caseId === '72' ||
    policy.clientId !== input.clientId
  )
    denied('source_scope_invalid');
  const proof = await readMeriControlledFixture({ prisma, ctx, policy });
  const read = proof.definition.reads.find((row) => row.physicalId === input.recordId);
  const section = read?.facts.page ? `page ${read.facts.page}` : read?.logicalId;
  if (!read || input.version !== read.version || input.section !== section)
    denied('source_locator_invalid');
  return {
    kind: 'controlled_read',
    status: 'available',
    recordId: read.physicalId,
    sourceVersion: read.version,
    currentVersion: read.version,
    versionStatus: 'matches_cited_version',
    tenantId: ctx.tenantId,
    clientId: input.clientId,
    conversationId: input.conversationId,
    title: read.logicalId,
    section,
    text: read.content,
    offset: 0,
    nextCursor: null,
    contentSha256: read.contentSha256,
    controlled: true,
    disclosure:
      'Controlled synthetic budget source. No shared budget corpus row or PDF extraction is asserted.',
  };
}
