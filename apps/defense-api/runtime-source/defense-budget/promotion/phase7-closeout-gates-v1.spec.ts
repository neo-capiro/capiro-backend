import {
  PHASE7_NEGATIVE_CONTROL_COUNT,
  PHASE7_NEGATIVE_CONTROL_IDS,
  assertPhase7PromoterTaskV1,
  phase7GateRuleCodesV1,
  scanPhase7ArchitectureSourceV1,
  validatePhase7PromoterTaskV1,
  type Phase7GateScopeV1,
  type Phase7PromoterTaskDescriptorV1,
} from './phase7-closeout-gates-v1.js';

function codes(scope: Phase7GateScopeV1, source: string, relativePath = 'src/x.ts'): string[] {
  return scanPhase7ArchitectureSourceV1({ scope, relativePath, source }).map((v) => v.code);
}

describe('Phase 7 negative-control registry', () => {
  it('holds exactly the 32 mandatory controls', () => {
    expect(PHASE7_NEGATIVE_CONTROL_IDS).toHaveLength(PHASE7_NEGATIVE_CONTROL_COUNT);
  });

  it('has no duplicate IDs', () => {
    expect(new Set(PHASE7_NEGATIVE_CONTROL_IDS).size).toBe(PHASE7_NEGATIVE_CONTROL_COUNT);
  });

  it('keeps IDs in snake_case so the runner can key on them', () => {
    for (const id of PHASE7_NEGATIVE_CONTROL_IDS) {
      expect(id).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });
});

describe('architecture gates — each rule fires on a real violation', () => {
  it('catches the parser or verifier importing promotion', () => {
    expect(
      codes('parser_verifier', "import { promote } from '../defense-budget/promotion/x.js';"),
    ).toContain('parser_verifier_imports_promotion');
  });

  it('catches the serve path reaching for the promoter credential', () => {
    expect(codes('serve_read', 'const url = process.env.PROMOTER_DATABASE_URL;')).toContain(
      'serve_instantiates_promoter_repository',
    );
  });

  it('catches a legacy loader writing a canonical snapshot table', () => {
    expect(
      codes('legacy_loader', 'await prisma.defenseBudgetCanonicalRow.createMany({ data });'),
    ).toContain('legacy_loader_writes_canonical_snapshot');
    expect(
      codes('legacy_loader', 'await client.query(`INSERT INTO defense_budget_canonical_row ...`);'),
    ).toContain('legacy_loader_writes_canonical_snapshot');
  });

  it('catches promotion calling a paid parser or an LLM', () => {
    expect(codes('promotion', 'const c = new LlamaParseClient();')).toContain(
      'promotion_calls_paid_parser_or_llm',
    );
    expect(codes('promotion', "import Anthropic from '@anthropic-ai/sdk';")).toContain(
      'promotion_calls_paid_parser_or_llm',
    );
  });

  it('catches money passing through a JavaScript float', () => {
    expect(codes('promotion', 'const amount = row.amountMillions.toNumber();')).toContain(
      'promotion_float_money',
    );
    expect(codes('promotion', 'const amount = parseFloat(row.amount);')).toContain(
      'promotion_float_money',
    );
  });

  it('catches an inline alert emission', () => {
    expect(codes('promotion', 'await prisma.intelligenceChange.create({ data });')).toContain(
      'promotion_inline_alert_emission',
    );
    expect(codes('promotion', 'await sendEmail(recipient, body);')).toContain(
      'promotion_inline_alert_emission',
    );
  });

  it('catches a destructive rollback', () => {
    expect(
      codes('promotion', 'await client.query(`DELETE FROM defense_budget_canonical_row ...`);'),
    ).toContain('promotion_destructive_rollback');
    expect(codes('promotion', 'await prisma.defenseBudgetCanonicalSnapshot.delete({ where });')).toContain(
      'promotion_destructive_rollback',
    );
  });

  it('catches an active-snapshot mutation outside the activation repository', () => {
    expect(
      codes(
        'promotion',
        'await client.query(`UPDATE defense_budget_active_snapshot SET id = $1`);',
        'src/defense-budget/promotion/some-other-file.ts',
      ),
    ).toContain('active_snapshot_mutation_outside_activation');
  });
});

describe('architecture gates — scope is directional, not flat', () => {
  it('lets the parser call a paid parser, and stops promotion doing it', () => {
    const source = 'const c = new LlamaParseClient();';
    expect(codes('parser_verifier', source)).not.toContain('promotion_calls_paid_parser_or_llm');
    expect(codes('promotion', source)).toContain('promotion_calls_paid_parser_or_llm');
  });

  it('lets promotion import the parser vocabulary it promotes', () => {
    expect(codes('promotion', "import type { PageResult } from '../parser-router/x.js';")).toEqual(
      [],
    );
  });
});

describe('architecture gates — the exemptions that keep the rules honest', () => {
  it('exempts the one repository allowed to move the pointer', () => {
    expect(
      codes(
        'promotion',
        'await client.query(`UPDATE defense_budget_active_snapshot SET id = $1`);',
        'src/defense-budget/promotion/canonical-promotion-repository-prisma-v1.ts',
      ),
    ).toEqual([]);
  });

  it('does not fire on a SELECT against the pointer', () => {
    expect(
      codes('promotion', 'const r = await client.query(`SELECT id FROM defense_budget_active_snapshot`);'),
    ).toEqual([]);
  });

  it('ignores a banned pattern that appears only in a comment', () => {
    // This is the real shape in manual-override-repository-prisma-v1.ts: the
    // module documents the ban and would otherwise trip its own rule.
    expect(codes('promotion', '// Decimal -> string -> canonical. Never `.toNumber()`.\n')).toEqual(
      [],
    );
    expect(
      codes('promotion', '/**\n * stringified, never `.toNumber()`d, and written exactly.\n */\n'),
    ).toEqual([]);
  });

  it('does not fire on Number() over a fiscal year or a row count', () => {
    expect(
      codes(
        'promotion',
        'const fy = Number(row.fiscal_year); const n = Number(row.stagedRowCount ?? 0);',
      ),
    ).toEqual([]);
  });

  it('does not fire on a paid-parser method name used as a data value', () => {
    // `promotion-eligibility-v1.ts` lists `llamaparse` as a high-risk extraction
    // method. Naming it is not calling it.
    expect(codes('promotion', "const HIGH_RISK = ['manual', 'ocr', 'llamaparse'] as const;")).toEqual(
      [],
    );
  });
});

describe('gate registry integrity', () => {
  it('exposes a code for every rule and no duplicates', () => {
    const ruleCodes = phase7GateRuleCodesV1();
    expect(ruleCodes.length).toBeGreaterThan(0);
    expect(new Set(ruleCodes).size).toBe(ruleCodes.length);
  });

  it('returns nothing for empty source in every scope', () => {
    for (const scope of ['promotion', 'parser_verifier', 'legacy_loader', 'serve_read'] as const) {
      expect(codes(scope, '')).toEqual([]);
    }
  });
});

describe('promoter task descriptor', () => {
  const good: Phase7PromoterTaskDescriptorV1 = {
    taskDefinitionName: 'api-promoter',
    databaseSecretName: 'capiro/aurora/pe-promoter',
    scheduled: false,
    attachedSecretNames: [],
    hasPublicListener: false,
    logGroupName: '/capiro/api-promoter',
  };

  it('accepts a correctly wired promoter task', () => {
    expect(validatePhase7PromoterTaskV1(good)).toEqual([]);
    expect(() => assertPhase7PromoterTaskV1(good)).not.toThrow();
  });

  it('rejects master or serve credentials (negative control 24)', () => {
    for (const secret of ['capiro/aurora/master', 'capiro/aurora/postgres', 'capiro_app']) {
      expect(
        validatePhase7PromoterTaskV1({ ...good, databaseSecretName: secret }).map((v) => v.code),
      ).toContain('promoter_uses_master_credentials');
    }
  });

  it('rejects a scheduled promoter', () => {
    expect(validatePhase7PromoterTaskV1({ ...good, scheduled: true }).map((v) => v.code)).toContain(
      'promoter_is_scheduled',
    );
  });

  it('rejects vendor or parser secrets on the promoter', () => {
    expect(
      validatePhase7PromoterTaskV1({
        ...good,
        attachedSecretNames: ['capiro/llamaparse/api-key'],
      }).map((v) => v.code),
    ).toContain('promoter_carries_vendor_secrets');
  });

  it('rejects a public listener and a missing log group', () => {
    expect(
      validatePhase7PromoterTaskV1({ ...good, hasPublicListener: true }).map((v) => v.code),
    ).toContain('promoter_has_public_listener');
    expect(
      validatePhase7PromoterTaskV1({ ...good, logGroupName: null }).map((v) => v.code),
    ).toContain('promoter_missing_log_group');
  });

  it('reports every violation at once rather than the first', () => {
    const violations = validatePhase7PromoterTaskV1({
      taskDefinitionName: 'api-promoter',
      databaseSecretName: 'capiro/aurora/master',
      scheduled: true,
      attachedSecretNames: ['capiro/anthropic/key'],
      hasPublicListener: true,
      logGroupName: null,
    });
    expect(violations.map((v) => v.code).sort()).toEqual([
      'promoter_carries_vendor_secrets',
      'promoter_has_public_listener',
      'promoter_is_scheduled',
      'promoter_missing_log_group',
      'promoter_uses_master_credentials',
    ]);
  });
});
