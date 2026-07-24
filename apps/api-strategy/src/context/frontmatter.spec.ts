import { describe, expect, it } from '@jest/globals';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  AUTHORITIES,
  CONFIDENTIALITIES,
  CONTEXT_SCOPES,
  CONTEXT_STATES,
  DOCUMENT_TYPES,
  ID_PLACEHOLDERS,
  TEMPLATE_KEY_BY_TYPE,
  parseFrontmatter,
  validateFrontmatter,
  type Frontmatter,
} from './frontmatter.js';

/*
 * Acceptance-driven parser/validator tests against THE CONTRACT: the 14 real
 * template files vendored under src/context/templates/. Every template must
 * parse structurally, and must fail validation ONLY on its placeholders — the
 * literal 'YYYY-MM-DD' dates AND the literal shipped ids ('client_123',
 * 'strategy_456', 'user_123', 'meeting_789') — proving the parser handles the
 * full grammar the pack actually uses. The single documented exception:
 * 09_meeting_intelligence.md declares `scope: meeting`, which Stage D defers
 * (meetings association is a later phase), so it ALSO carries exactly that one
 * scope error.
 */

const TEMPLATES_DIR = join(__dirname, 'templates');

function templateFiles(): string[] {
  return readdirSync(TEMPLATES_DIR)
    .filter((f) => /^\d{2}_.*\.md$/.test(f))
    .sort();
}

/** A fully-valid synthesized frontmatter (strategy scope). */
function validFm(overrides: Partial<Frontmatter> = {}): Frontmatter {
  return {
    document_type: 'strategy_brief',
    document_id: 'ctx_strategy_brief_001',
    schema_version: '1.0',
    state: 'active',
    scope: 'strategy',
    client_id: null,
    strategy_id: 'f6b7c1de-1111-4222-8333-444455556666',
    node_id: null,
    meeting_id: null,
    as_of: '2026-07-01',
    valid_until: '2026-12-31',
    owner: 'user_2NNEqL2nrIRdJ194ndJqAHwEfxC', // real Clerk-style id, NOT the 'user_123' placeholder
    authority: 'client_approved',
    source_of_truth: true,
    supersedes: null,
    confidentiality: 'client_confidential',
    ...overrides,
  };
}

describe('the 14 vendored templates (the contract)', () => {
  it('there are exactly 14 template files and every document_type maps to one', () => {
    const files = templateFiles();
    expect(files).toHaveLength(14);
    expect(Object.values(TEMPLATE_KEY_BY_TYPE).sort()).toEqual(
      files.map((f) => f.replace(/\.md$/, '')).sort(),
    );
    expect(DOCUMENT_TYPES).toHaveLength(14);
  });

  it.each(templateFiles())('%s parses structurally with zero errors', (file) => {
    const raw = readFileSync(join(TEMPLATES_DIR, file), 'utf8');
    const parsed = parseFrontmatter(raw);
    expect(parsed.errors).toEqual([]);
    expect(parsed.frontmatter).not.toBeNull();
    // The declared document_type matches the file it lives in.
    const docType = parsed.frontmatter!.document_type as keyof typeof TEMPLATE_KEY_BY_TYPE;
    expect(TEMPLATE_KEY_BY_TYPE[docType]).toBe(file.replace(/\.md$/, ''));
    // The body survives (templates all have a top-level heading).
    expect(parsed.body).toMatch(/^#\s/m);
  });

  it.each(templateFiles())(
    '%s fails validation ONLY on its placeholder dates and ids (09 additionally on the deferred meeting scope)',
    (file) => {
      const raw = readFileSync(join(TEMPLATES_DIR, file), 'utf8');
      const { frontmatter } = parseFrontmatter(raw);
      const errors = validateFrontmatter(frontmatter!);

      // The specific as_of error: every blank template ships the literal
      // 'YYYY-MM-DD' placeholder there.
      const asOf = errors.filter((e) => e.field === 'as_of');
      expect(asOf).toHaveLength(1);
      expect(asOf[0]!.message).toMatch(/placeholder date 'YYYY-MM-DD'/);

      // valid_until is either the same placeholder or explicitly null.
      const validUntil = errors.filter((e) => e.field === 'valid_until');
      if (frontmatter!.valid_until === null) {
        expect(validUntil).toHaveLength(0);
      } else {
        expect(validUntil).toHaveLength(1);
        expect(validUntil[0]!.message).toMatch(/placeholder date/);
      }

      // Placeholder ids: EXACTLY the fields this template ships a literal
      // placeholder in must fail (every template ships at least one — most ship
      // owner: "user_123"; 07 ships owner: "system" but placeholder client_id/
      // strategy_id), symmetric with the placeholder-date rule above.
      const idErrors = errors.filter((e) => /placeholder id/.test(e.message));
      const shippedPlaceholderFields = Object.entries(frontmatter!)
        .filter(([, v]) => typeof v === 'string' && (ID_PLACEHOLDERS as readonly string[]).includes(v))
        .map(([k]) => k)
        .sort();
      expect(shippedPlaceholderFields.length).toBeGreaterThan(0);
      expect(idErrors.map((e) => e.field).sort()).toEqual(shippedPlaceholderFields);
      for (const e of idErrors) expect(e.message).toMatch(/fill in a real id/);

      // NOTHING else fails — except 09's deferred meeting scope.
      const others = errors.filter(
        (e) =>
          e.field !== 'as_of' && e.field !== 'valid_until' && !/placeholder id/.test(e.message),
      );
      if (file === '09_meeting_intelligence.md') {
        expect(others).toHaveLength(1);
        expect(others[0]).toEqual({
          field: 'scope',
          message:
            'meeting scope is deferred (meetings association is a later phase) — re-scope to strategy',
        });
      } else {
        expect(others).toEqual([]);
      }
    },
  );
});

describe('parseFrontmatter grammar', () => {
  it('parses bare scalars, quoted strings, booleans and null into typed values', () => {
    const { frontmatter, body, errors } = parseFrontmatter(
      ['---', 'a: bare_scalar', 'b: "quoted: value"', 'c: true', 'd: false', 'e: null', '---', '', '# Body'].join(
        '\n',
      ),
    );
    expect(errors).toEqual([]);
    expect(frontmatter).toEqual({
      a: 'bare_scalar',
      b: 'quoted: value',
      c: true,
      d: false,
      e: null,
    });
    expect(body).toBe('\n# Body');
  });

  it('missing opening fence is a structural error (frontmatter null, body = raw)', () => {
    const raw = 'document_type: strategy_brief\n# Body';
    const parsed = parseFrontmatter(raw);
    expect(parsed.frontmatter).toBeNull();
    expect(parsed.body).toBe(raw);
    expect(parsed.errors).toEqual([
      { field: '_structure', message: expect.stringMatching(/opening '---'/) },
    ]);
  });

  it('missing closing fence is a structural error', () => {
    const parsed = parseFrontmatter('---\ndocument_type: strategy_brief\n# Body');
    expect(parsed.frontmatter).toBeNull();
    expect(parsed.errors[0]!.message).toMatch(/closing '---'/);
  });

  it('nested/indented keys are a structural error', () => {
    const parsed = parseFrontmatter('---\nparent:\n  child: 1\n---\nbody');
    expect(parsed.frontmatter).toBeNull();
    expect(parsed.errors.some((e) => /nested\/indented/.test(e.message))).toBe(true);
  });

  it('array items are a structural error', () => {
    const parsed = parseFrontmatter('---\n- item\n---\nbody');
    expect(parsed.frontmatter).toBeNull();
    expect(parsed.errors.some((e) => /array items/.test(e.message))).toBe(true);
  });

  it('inline arrays/objects are FIELD-level errors', () => {
    const parsed = parseFrontmatter('---\ntags: [a, b]\n---\nbody');
    expect(parsed.errors).toEqual([
      { field: 'tags', message: expect.stringMatching(/arrays\/objects are not allowed/) },
    ]);
  });

  it('a duplicate key is a FIELD-level error', () => {
    const parsed = parseFrontmatter('---\nstate: active\nstate: draft\n---\nbody');
    expect(parsed.errors).toEqual([{ field: 'state', message: 'duplicate key' }]);
    expect(parsed.frontmatter!.state).toBe('active'); // first wins; dupe reported
  });
});

describe('validateFrontmatter — one test per vocabulary/consistency rule', () => {
  const errorsFor = (overrides: Partial<Frontmatter>) => validateFrontmatter(validFm(overrides));

  it('a fully-valid synthesized frontmatter passes with zero errors', () => {
    expect(validateFrontmatter(validFm())).toEqual([]);
  });

  it('unknown document_type', () => {
    const errors = errorsFor({ document_type: 'grocery_list' });
    expect(errors).toEqual([
      { field: 'document_type', message: expect.stringContaining('context_manifest') },
    ]);
  });

  it('wrong schema_version', () => {
    expect(errorsFor({ schema_version: '2.0' })).toEqual([
      { field: 'schema_version', message: "must be '1.0'" },
    ]);
  });

  it('unknown state', () => {
    expect(errorsFor({ state: 'live' })).toEqual([
      { field: 'state', message: `must be one of: ${CONTEXT_STATES.join(', ')}` },
    ]);
  });

  it('unknown scope', () => {
    expect(errorsFor({ scope: 'galaxy' })).toEqual([
      { field: 'scope', message: `must be one of: ${CONTEXT_SCOPES.join(', ')}` },
    ]);
  });

  it("scope 'meeting' gets the SPECIFIC deferral error", () => {
    expect(errorsFor({ scope: 'meeting' })).toEqual([
      {
        field: 'scope',
        message:
          'meeting scope is deferred (meetings association is a later phase) — re-scope to strategy',
      },
    ]);
  });

  it('unknown authority', () => {
    expect(errorsFor({ authority: 'vibes' })).toEqual([
      { field: 'authority', message: `must be one of: ${AUTHORITIES.join(', ')}` },
    ]);
  });

  it('unknown confidentiality', () => {
    expect(errorsFor({ confidentiality: 'public' })).toEqual([
      { field: 'confidentiality', message: `must be one of: ${CONFIDENTIALITIES.join(', ')}` },
    ]);
  });

  it('source_of_truth must be a boolean (a bare "yes" scalar fails)', () => {
    expect(errorsFor({ source_of_truth: 'yes' })).toEqual([
      { field: 'source_of_truth', message: 'must be a boolean (true or false)' },
    ]);
  });

  it("the literal 'YYYY-MM-DD' placeholder in as_of is called out as a placeholder", () => {
    expect(errorsFor({ as_of: 'YYYY-MM-DD' })).toEqual([
      { field: 'as_of', message: expect.stringMatching(/placeholder date/) },
    ]);
  });

  it('a calendar-impossible as_of (2027-02-30 — V8 rolls it over, not NaN) fails', () => {
    expect(errorsFor({ as_of: '2027-02-30' })).toEqual([
      { field: 'as_of', message: 'not a valid YYYY-MM-DD calendar date' },
    ]);
  });

  it('valid_until accepts null and a real date, rejects the placeholder', () => {
    expect(errorsFor({ valid_until: null })).toEqual([]);
    expect(errorsFor({ valid_until: '2027-09-30' })).toEqual([]);
    expect(errorsFor({ valid_until: 'YYYY-MM-DD' })).toEqual([
      { field: 'valid_until', message: expect.stringMatching(/placeholder date/) },
    ]);
  });

  it('shipped placeholder ids are rejected even though requireId sees a non-empty string', () => {
    // strategy scope: 'strategy_456' satisfies requireId, so ONLY the
    // placeholder check stands between it and the database.
    expect(errorsFor({ strategy_id: 'strategy_456' })).toEqual([
      { field: 'strategy_id', message: "placeholder id 'strategy_456' — fill in a real id" },
    ]);
    expect(
      errorsFor({
        scope: 'client',
        document_type: 'client_constraints',
        client_id: 'client_123',
        strategy_id: null,
      }),
    ).toEqual([{ field: 'client_id', message: "placeholder id 'client_123' — fill in a real id" }]);
  });

  it('placeholder ids in fields NOT required by the scope still fail (owner, meeting_id, off-scope client_id)', () => {
    expect(errorsFor({ owner: 'user_123' })).toEqual([
      { field: 'owner', message: "placeholder id 'user_123' — fill in a real id" },
    ]);
    expect(errorsFor({ meeting_id: 'meeting_789' })).toEqual([
      { field: 'meeting_id', message: "placeholder id 'meeting_789' — fill in a real id" },
    ]);
    expect(errorsFor({ client_id: 'client_123' })).toEqual([
      { field: 'client_id', message: "placeholder id 'client_123' — fill in a real id" },
    ]);
  });

  it("a real Clerk-style owner id (user_2…) is NOT mistaken for the 'user_123' placeholder — exact literals only", () => {
    expect(errorsFor({ owner: 'user_2abcDEFghiJKLmnoPQRstu' })).toEqual([]);
  });

  it('scope=client requires a non-null client_id', () => {
    expect(
      errorsFor({ scope: 'client', client_id: null, document_type: 'client_constraints' }),
    ).toEqual([{ field: 'client_id', message: "client_id is required when scope is 'client'" }]);
  });

  it('scope=strategy requires a non-null strategy_id', () => {
    expect(errorsFor({ strategy_id: null })).toEqual([
      { field: 'strategy_id', message: "strategy_id is required when scope is 'strategy'" },
    ]);
  });

  it('scope=node requires a non-null node_id', () => {
    expect(errorsFor({ scope: 'node', node_id: null })).toEqual([
      { field: 'node_id', message: "node_id is required when scope is 'node'" },
    ]);
  });

  it('scope=firm requires no ids', () => {
    expect(
      errorsFor({
        scope: 'firm',
        document_type: 'execution_playbook',
        client_id: null,
        strategy_id: null,
        confidentiality: 'firm_internal',
        authority: 'firm_approved',
      }),
    ).toEqual([]);
  });

  it('supersedes must be null or a NON-EMPTY string', () => {
    expect(errorsFor({ supersedes: '' })).toEqual([
      { field: 'supersedes', message: 'must be null or a non-empty string' },
    ]);
    expect(errorsFor({ supersedes: 'ctx_strategy_brief_000' })).toEqual([]);
  });

  it('a missing as_of is an error (required field)', () => {
    const fm = validFm();
    delete fm.as_of;
    expect(validateFrontmatter(fm)).toEqual([
      { field: 'as_of', message: expect.stringMatching(/required/) },
    ]);
  });

  it('an explicit `as_of: null` is ALSO an error (no template permits it; README rule 5 keys on as_of)', () => {
    expect(errorsFor({ as_of: null })).toEqual([
      { field: 'as_of', message: expect.stringMatching(/required/) },
    ]);
  });
});
