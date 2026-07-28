import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const write = (p, value) => {
  const target = path.join(root, p);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, value.endsWith('\n') ? value : `${value}\n`);
};
function replaceOnce(file, search, replacement) {
  const current = read(file);
  if (!current.includes(search)) throw new Error(`Missing expected text in ${file}: ${search.slice(0, 120)}`);
  write(file, current.replace(search, replacement));
}
function appendBefore(file, marker, addition) {
  const current = read(file);
  if (current.includes(addition.trim())) return;
  const index = current.lastIndexOf(marker);
  if (index < 0) throw new Error(`Missing marker in ${file}: ${marker}`);
  write(file, `${current.slice(0, index)}${addition}${current.slice(index)}`);
}

// Fingerprint v2 keeps legacy hashing readable while binding approvals to policy version.
replaceOnce(
  'packages/meriv2-core/src/compliance/action-approval.ts',
  `export function computeActionFingerprint(\n  toolName: string,\n  input: unknown,\n  ctx: Pick<MeriContext, 'tenantId' | 'userId'>,\n): string {\n  const payload = canonicalize({\n    tenantId: ctx.tenantId,\n    userId: ctx.userId,\n    tool: toolName,\n    input: input ?? null,\n  });\n  return createHash('sha256').update(payload).digest('hex');\n}\n`,
  `export function computeActionFingerprint(\n  toolName: string,\n  input: unknown,\n  ctx: Pick<MeriContext, 'tenantId' | 'userId'>,\n): string {\n  const payload = canonicalize({\n    tenantId: ctx.tenantId,\n    userId: ctx.userId,\n    tool: toolName,\n    input: input ?? null,\n  });\n  return createHash('sha256').update(payload).digest('hex');\n}\n\nexport interface ActionFingerprintV2Input {\n  effectiveTenantId: string;\n  userId: string;\n  tool: string;\n  input: unknown;\n  policyVersion: string;\n}\n\n/**\n * Phase 0 approval fingerprint. Only canonical values validated and supplied by\n * the server belong in this hash. The policy version is part of the authority:\n * an approval created under an incompatible policy can never be replayed.\n */\nexport function computeActionFingerprintV2(args: ActionFingerprintV2Input): string {\n  const payload = canonicalize({\n    version: 2,\n    effectiveTenantId: args.effectiveTenantId,\n    userId: args.userId,\n    tool: args.tool,\n    input: args.input ?? null,\n    policyVersion: args.policyVersion,\n  });\n  return createHash('sha256').update(payload).digest('hex');\n}\n`,
);

replaceOnce(
  'packages/meriv2-core/src/compliance/action-approval.spec.ts',
  `  computeActionFingerprint,\n`,
  `  computeActionFingerprint,\n  computeActionFingerprintV2,\n`,
);
appendBefore(
  'packages/meriv2-core/src/compliance/action-approval.spec.ts',
  `\ndescribe('RepoBackedApprovalStore'`,
  `\ndescribe('computeActionFingerprintV2', () => {\n  const base = {\n    effectiveTenantId: '11111111-1111-4111-8111-111111111111',\n    userId: '22222222-2222-4222-8222-222222222222',\n    tool: 'send_email',\n    input: {\n      to: ['a@example.com'],\n      subject: 'Subject',\n      body: 'Body',\n      clientId: '33333333-3333-4333-8333-333333333333',\n    },\n    policyVersion: 'p0.v1',\n  };\n\n  it('is stable across object-key order but keeps array order meaningful', () => {\n    const a = computeActionFingerprintV2(base);\n    const b = computeActionFingerprintV2({\n      ...base,\n      input: { clientId: base.input.clientId, body: 'Body', subject: 'Subject', to: ['a@example.com'] },\n    });\n    expect(a).toBe(b);\n    expect(\n      computeActionFingerprintV2({ ...base, input: { ...base.input, to: ['b@example.com', 'a@example.com'] } }),\n    ).not.toBe(\n      computeActionFingerprintV2({ ...base, input: { ...base.input, to: ['a@example.com', 'b@example.com'] } }),\n    );\n  });\n\n  it.each([\n    ['effective tenant', { effectiveTenantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }],\n    ['user', { userId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }],\n    ['tool', { tool: 'reply_email' }],\n    ['policy version', { policyVersion: 'p0.v2' }],\n  ])('changes when %s changes', (_label, patch) => {\n    expect(computeActionFingerprintV2({ ...base, ...patch })).not.toBe(\n      computeActionFingerprintV2(base),\n    );\n  });\n\n  it('changes when body, recipient, or client changes by one value', () => {\n    const fingerprint = computeActionFingerprintV2(base);\n    expect(\n      computeActionFingerprintV2({ ...base, input: { ...base.input, body: 'Bodz' } }),\n    ).not.toBe(fingerprint);\n    expect(\n      computeActionFingerprintV2({ ...base, input: { ...base.input, to: ['b@example.com'] } }),\n    ).not.toBe(fingerprint);\n    expect(\n      computeActionFingerprintV2({\n        ...base,\n        input: { ...base.input, clientId: '44444444-4444-4444-8444-444444444444' },\n      }),\n    ).not.toBe(fingerprint);\n  });\n});\n`,
);

replaceOnce(
  'packages/meriv2-core/src/compliance/compliance-rules.ts',
  `import type { CompliancePolicy, ComplianceDecision, ComplianceOutcome } from './approval-gate';\n`,
  `import type { CompliancePolicy, ComplianceDecision, ComplianceOutcome } from './approval-gate';\n\n/** Immutable identifier for the policy semantics used by Phase 0 proposals. */\nexport const CAPIRO_COMPLIANCE_POLICY_VERSION = '2026-07-27.meriv2-p0.v1';\n`,
);
replaceOnce(
  'packages/meriv2-core/src/compliance/compliance-rules.ts',
  `        // Memory verbs (Phase 1, 1D) — internal, reversible (forget is a soft\n        // delete; correct preserves history via supersession), user-initiated.\n        // Parity with legacy chat, where they execute with no gate.\n        'confirm_memory',\n        'correct_memory',\n        'forget_memory',\n`,
  `        // Shared-memory mutation is scope/role sensitive. Phase 0 deliberately\n        // leaves confirm/correct/forget out of this unconditional PASS rule, so\n        // an unknown or shared-scope mutation fails to WARN and requires approval.\n`,
);

// Add the proposal relation and additive lifecycle model. Old audit tables remain untouched.
replaceOnce(
  'apps/api/prisma/schema.prisma',
  `  meriActionApprovals          MeriActionApproval[]\n  meriPendingActions           MeriPendingAction[]\n`,
  `  meriActionApprovals          MeriActionApproval[]\n  meriPendingActions           MeriPendingAction[]\n  meriActionProposals          MeriActionProposal[]\n`,
);
appendBefore(
  'apps/api/prisma/schema.prisma',
  `\n/// Clio self-scheduled recurring task`,
  `\n/// Immutable, server-created MeriV2 action proposal. Browser approval is by the\n/// opaque id only; tool/input/fingerprint/policy/tenant/user are server authority.\nmodel MeriActionProposal {\n  id                     String   @id @default(uuid()) @db.Uuid\n  tenantId               String   @map("tenant_id") @db.Uuid\n  userId                 String   @map("user_id") @db.Uuid\n  actorUserId            String?  @map("actor_user_id") @db.Uuid\n  impersonationSessionId String?  @map("impersonation_session_id") @db.VarChar(160)\n  conversationId         String?  @map("conversation_id") @db.Uuid\n  surface                String   @db.VarChar(40)\n  tool                   String   @db.VarChar(120)\n  input                  Json     @map("input_jsonb")\n  fingerprint            String   @db.VarChar(64)\n  policyVersion          String   @map("policy_version") @db.VarChar(80)\n  policyRuleId           String?  @map("policy_rule_id") @db.VarChar(160)\n  policyDecision         String   @map("policy_decision") @db.VarChar(20)\n  policyCode             String?  @map("policy_code") @db.VarChar(120)\n  riskTier               String?  @map("risk_tier") @db.VarChar(40)\n  preview                Json     @map("preview_jsonb")\n  status                 String   @db.VarChar(32)\n  expiresAt              DateTime @map("expires_at") @db.Timestamptz(6)\n  approvedAt             DateTime? @map("approved_at") @db.Timestamptz(6)\n  approvedBy             String?  @map("approved_by") @db.Uuid\n  executionStartedAt     DateTime? @map("execution_started_at") @db.Timestamptz(6)\n  executedAt             DateTime? @map("executed_at") @db.Timestamptz(6)\n  attemptCount           Int      @default(0) @map("attempt_count")\n  lastErrorCode          String?  @map("last_error_code") @db.VarChar(120)\n  lastErrorMessage       String?  @map("last_error_message") @db.VarChar(1000)\n  resultSummary          Json?    @map("result_summary_jsonb")\n  createdAt              DateTime @default(now()) @map("created_at") @db.Timestamptz(6)\n  updatedAt              DateTime @updatedAt @map("updated_at") @db.Timestamptz(6)\n\n  tenant Tenant @relation(fields: [tenantId], references: [id], onDelete: Cascade)\n\n  @@index([tenantId, userId, status, createdAt(sort: Desc)], map: "meri_action_proposal_user_status_created_idx")\n  @@index([conversationId, status], map: "meri_action_proposal_conversation_status_idx")\n  @@index([expiresAt, status], map: "meri_action_proposal_expiry_status_idx")\n  @@index([tenantId, fingerprint], map: "meri_action_proposal_tenant_fingerprint_idx")\n  @@map("meri_action_proposals")\n}\n`,
);

write(
  'apps/api/prisma/migrations/20260728010000_meriv2_action_proposals/migration.sql',
  `-- Phase 0: immutable server-created MeriV2 action proposal lifecycle.\n-- Additive only: historical meri_action_approval / meri_pending_action rows remain readable.\n\nCREATE TABLE "meri_action_proposals" (\n  "id" UUID NOT NULL DEFAULT gen_random_uuid(),\n  "tenant_id" UUID NOT NULL,\n  "user_id" UUID NOT NULL,\n  "actor_user_id" UUID,\n  "impersonation_session_id" VARCHAR(160),\n  "conversation_id" UUID,\n  "surface" VARCHAR(40) NOT NULL,\n  "tool" VARCHAR(120) NOT NULL,\n  "input_jsonb" JSONB NOT NULL,\n  "fingerprint" VARCHAR(64) NOT NULL,\n  "policy_version" VARCHAR(80) NOT NULL,\n  "policy_rule_id" VARCHAR(160),\n  "policy_decision" VARCHAR(20) NOT NULL,\n  "policy_code" VARCHAR(120),\n  "risk_tier" VARCHAR(40),\n  "preview_jsonb" JSONB NOT NULL,\n  "status" VARCHAR(32) NOT NULL,\n  "expires_at" TIMESTAMPTZ(6) NOT NULL,\n  "approved_at" TIMESTAMPTZ(6),\n  "approved_by" UUID,\n  "execution_started_at" TIMESTAMPTZ(6),\n  "executed_at" TIMESTAMPTZ(6),\n  "attempt_count" INTEGER NOT NULL DEFAULT 0,\n  "last_error_code" VARCHAR(120),\n  "last_error_message" VARCHAR(1000),\n  "result_summary_jsonb" JSONB,\n  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,\n  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,\n  CONSTRAINT "meri_action_proposals_pkey" PRIMARY KEY ("id"),\n  CONSTRAINT "meri_action_proposals_status_check" CHECK ("status" IN (\n    'proposed','approved','executing','succeeded','failed_retryable',\n    'failed_terminal','outcome_unknown','blocked','dismissed','expired'\n  )),\n  CONSTRAINT "meri_action_proposals_policy_decision_check" CHECK ("policy_decision" IN ('PASS','WARN','BLOCK')),\n  CONSTRAINT "meri_action_proposals_fingerprint_check" CHECK ("fingerprint" ~ '^[0-9a-f]{64}$'),\n  CONSTRAINT "meri_action_proposals_tenant_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE\n);\n\nCREATE INDEX "meri_action_proposal_user_status_created_idx"\n  ON "meri_action_proposals"("tenant_id", "user_id", "status", "created_at" DESC);\nCREATE INDEX "meri_action_proposal_conversation_status_idx"\n  ON "meri_action_proposals"("conversation_id", "status");\nCREATE INDEX "meri_action_proposal_expiry_status_idx"\n  ON "meri_action_proposals"("expires_at", "status");\nCREATE INDEX "meri_action_proposal_tenant_fingerprint_idx"\n  ON "meri_action_proposals"("tenant_id", "fingerprint");\n\nALTER TABLE "meri_action_proposals" ENABLE ROW LEVEL SECURITY;\nCREATE POLICY "meri_action_proposals_tenant_isolation" ON "meri_action_proposals"\n  USING ("tenant_id" = NULLIF(current_setting('app.current_tenant', true), '')::uuid)\n  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.current_tenant', true), '')::uuid);\n\nCOMMENT ON TABLE "meri_action_proposals" IS\n  'Immutable MeriV2 action proposals. Application-level tenant/user predicates remain mandatory because the application role may bypass owner RLS.';\nCOMMENT ON COLUMN "meri_action_proposals"."preview_jsonb" IS\n  'Display-only informed-consent summary; never an execution authority.';\n`,
);

replaceOnce(
  'apps/api/src/config/config.schema.ts',
  `  // RESERVED (consumer NOT yet built — flipping is currently a NO-OP; do not rely\n  // on it). MEMORY_AUTOLEARN_GOVERNED will route auto-learn through the candidate\n  // flow; today auto-learn still writes clio_memory directly regardless of this.\n`,
  `  // Governed conversation learning. False (default) means post-turn processing\n  // performs no persistent memory write. True permits source-anchored USER-text\n  // extraction into memory_candidate only; it never auto-promotes active memory.\n`,
);
replaceOnce(
  'apps/api/src/config/config.schema.ts',
  `  // Gate-bypass hardening for POST /api/clio/tools/:name: when 'true', that\n  // endpoint (which executes WRITE tools with no compliance gate — the gate\n  // lives in the MeriV2 orchestrator) requires the INTERNAL_SERVICE_SECRET\n  // header IN ADDITION to the user JWT, so only the orchestrator (post-gate),\n  // never a rogue user bearer, can reach it. Default false = OBSERVE (log a\n  // secret-less call, allow it) so the orchestrator can be confirmed sending the\n  // secret before enforcement. See ToolServiceSecretGuard.\n`,
  `  // Gate-bypass hardening for POST /api/clio/tools/:name and internal proposal\n  // creation. Staging/production ALWAYS enforce the shared secret; this switch\n  // controls explicit observe-only behavior in development/test only.\n`,
);
replaceOnce(
  'apps/api/src/config/config.schema.ts',
  `  MERI_TOOLS_REQUIRE_SERVICE_SECRET: z\n    .string()\n    .default('false')\n    .transform((v) => ['true', '1', 'yes', 'on'].includes(v.trim().toLowerCase())),\n`,
  `  MERI_TOOLS_REQUIRE_SERVICE_SECRET: z\n    .string()\n    .default('false')\n    .transform((v) => ['true', '1', 'yes', 'on'].includes(v.trim().toLowerCase())),\n  // Dark rollout gate for the new API/orchestrator/web proposal contract. The\n  // insecure legacy browser routes are disabled regardless of this value.\n  MERIV2_ACTION_PROPOSALS_ENABLED: z\n    .string()\n    .default('false')\n    .transform((v) => ['true', '1', 'yes', 'on'].includes(v.trim().toLowerCase())),\n  MERIV2_ACTION_PROPOSAL_TTL_MINUTES: z.coerce.number().int().min(1).max(1440).default(15),\n`,
);

console.log('Phase 0 core/schema patch applied.');
