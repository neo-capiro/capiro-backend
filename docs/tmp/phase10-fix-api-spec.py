from pathlib import Path

path = Path('apps/api/src/meri/meri-action-proposal.service.spec.ts')
text = path.read_text()

text = text.replace(
    "import type { MeriToolsService } from './meri-tools.service.js';\n",
    "import type { MeriToolsService } from './meri-tools.service.js';\nimport type {\n  AuthoritativePolicyDecision,\n  MeriPolicyPackService,\n} from './meri-policy-pack.service.js';\n",
    1,
)

ctx_anchor = "} satisfies TenantContext;\n\nfunction makeRow"
ctx_insert = """} satisfies TenantContext;

function authoritativeDecision(
  tool: string,
  decision: {
    outcome: 'PASS' | 'WARN' | 'BLOCK';
    reasons: string[];
    code?: string;
    tier?: 'low' | 'moderate' | 'high' | 'restricted';
    ruleId?: string;
  },
): AuthoritativePolicyDecision {
  const at = new Date('2026-07-27T00:00:00.000Z');
  const channel = /^(?:send_email|reply_email)$/.test(tool) ? 'email' : 'crm';
  return {
    outcome: decision.outcome,
    packId: 'capiro-generic-action-approval',
    packVersion: CAPIRO_COMPLIANCE_POLICY_VERSION,
    ruleId: decision.ruleId ?? null,
    reason: decision.reasons.join(' ') || 'Policy decision',
    ...(decision.code ? { code: decision.code } : {}),
    ...(decision.tier ? { tier: decision.tier } : {}),
    simulated: false,
    mode: 'off',
    source: 'static',
    verified: true,
    bindable: true,
    policyPackRowId: null,
    binding: 'policy-binding',
    contextHash: 'policy-context-hash',
    decisionHash: 'policy-decision-hash',
    context: {
      tenantId: TENANT,
      actorUserId: USER,
      effectiveUserId: USER,
      actorRole: 'standard_user',
      jurisdiction: 'federal',
      tool,
      channel,
      recipientType: 'unknown',
      at,
      effectiveAt: at,
      contextFlags: { impersonating: false },
    },
  };
}

function makeRow"""
if ctx_anchor not in text:
    raise SystemExit('ctx insertion anchor missing')
text = text.replace(ctx_anchor, ctx_insert, 1)

fingerprint_old = """      policyVersion: CAPIRO_COMPLIANCE_POLICY_VERSION,
    }),
    policyVersion: CAPIRO_COMPLIANCE_POLICY_VERSION,
    policyRuleId:"""
fingerprint_new = """      policyVersion: CAPIRO_COMPLIANCE_POLICY_VERSION,
      policyBinding: 'policy-binding',
      policyDecisionHash: 'policy-decision-hash',
      policyContextHash: 'policy-context-hash',
    }),
    policyVersion: CAPIRO_COMPLIANCE_POLICY_VERSION,
    policyPackId: null,
    policyPackKey: 'capiro-generic-action-approval',
    policyPackVersion: CAPIRO_COMPLIANCE_POLICY_VERSION,
    policyBinding: 'policy-binding',
    policyDecisionHash: 'policy-decision-hash',
    policyContextHash: 'policy-context-hash',
    policySource: 'static',
    policyMode: 'off',
    policyJurisdiction: 'federal',
    policyChannel: /^(?:send_email|reply_email)$/.test(tool) ? 'email' : 'crm',
    policyRecipientType: 'unknown',
    policyClientId: null,
    policyEffectiveUserId: USER,
    policyEffectiveAt: new Date('2026-07-27T00:00:00.000Z'),
    policyRuleId:"""
if fingerprint_old not in text:
    raise SystemExit('fingerprint anchor missing')
text = text.replace(fingerprint_old, fingerprint_new, 1)

service_old = """  const service = new MeriActionProposalService(prisma, tools, config);
  const setPolicy = (decision: {
    outcome: 'PASS' | 'WARN' | 'BLOCK';
    reasons: string[];
    code?: string;
    tier?: 'low' | 'moderate' | 'high' | 'restricted';
    ruleId?: string;
  }) => {
    (service as unknown as { policy: { evaluate: jest.Mock } }).policy = {
      evaluate: jest.fn().mockResolvedValue(decision),
    };
  };
  return { service, tx, tools: { execute, validate }, getRow: () => row, setPolicy };
"""
service_new = """  const defaultPolicy = {
    outcome: 'WARN' as const,
    reasons: ['Requires approval'],
    code: 'external_send',
    tier: 'restricted' as const,
    ruleId: 'external_send.requires_approval',
  };
  const policyPacks = {
    decideForAction: jest.fn(async (_ctx: TenantContext, tool: string) =>
      authoritativeDecision(tool, defaultPolicy),
    ),
    recordDecisionInTx: jest.fn().mockResolvedValue(undefined),
  } as unknown as MeriPolicyPackService;
  const service = new MeriActionProposalService(prisma, tools, config, policyPacks);
  const setPolicy = (decision: {
    outcome: 'PASS' | 'WARN' | 'BLOCK';
    reasons: string[];
    code?: string;
    tier?: 'low' | 'moderate' | 'high' | 'restricted';
    ruleId?: string;
  }) => {
    (policyPacks.decideForAction as jest.Mock).mockImplementation(
      async (_ctx: TenantContext, tool: string) => authoritativeDecision(tool, decision),
    );
  };
  return {
    service,
    tx,
    tools: { execute, validate },
    policyPacks,
    getRow: () => row,
    setPolicy,
  };
"""
if service_old not in text:
    raise SystemExit('service harness anchor missing')
text = text.replace(service_old, service_new, 1)

result_old = """    const stored = h.getRow()!;
    expect(result.proposalId).toBe(PROPOSAL);
"""
result_new = """    const stored = h.getRow()!;
    expect(result.disposition).toBe('pending_approval');
    if (result.disposition !== 'pending_approval') throw new Error('expected pending approval');
    expect(result.proposal.proposalId).toBe(PROPOSAL);
"""
if result_old not in text:
    raise SystemExit('create result anchor missing')
text = text.replace(result_old, result_new, 1)

text = text.replace(
    "expect(result.error?.code).toBe('new_block');",
    "expect(result.error?.code).toBe('policy_binding_changed');",
    1,
)

list_old = "const service = new MeriActionProposalService(prisma, tools, config);"
list_new = """const service = new MeriActionProposalService(
      prisma,
      tools,
      config,
      {} as unknown as MeriPolicyPackService,
    );"""
if list_old not in text:
    raise SystemExit('list service anchor missing')
text = text.replace(list_old, list_new, 1)

path.write_text(text)
