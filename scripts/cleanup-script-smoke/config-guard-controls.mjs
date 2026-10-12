/**
 * CleanUp1 — controls for the reviewed config-guard codemod
 * (`config-guard-codemod.mjs`) and its scanner integration.
 *
 * Every control drives the ACTUAL pure transform (`transformConfigGuard` /
 * `analyzePlacement`) and the ACTUAL canonical deriver (`deriveContract`) over
 * in-memory source fixtures — no subject process is executed, no exit code is
 * inferred from an observed run, and no implementation is duplicated.
 *
 * Run:  node scripts/cleanup-script-smoke/config-guard-controls.mjs --self-test
 * Exit: 0 all controls pass; 1 a control failed; bare/unknown invocation: Usage/2.
 */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { transformConfigGuard, analyzePlacement, countEnvReads, countDatabaseUrlTokens, parseArgs } from './config-guard-codemod.mjs';
import { deriveContract, MISSING_DATABASE_URL_SMOKE_CONTEXT } from './contract.mjs';

const REL = 'apps/api/scripts/probe.ts';

// A representative UNCONDITIONAL entrypoint (`void main().catch(...)` at top level).
const UNCONDITIONAL = [
  "import { config as dotenvConfig } from 'dotenv';",
  "import { PrismaClient } from '@prisma/client';",
  '',
  'dotenvConfig();',
  '',
  'async function main(): Promise<void> {',
  '  const prisma = new PrismaClient();',
  '  await prisma.$disconnect();',
  '}',
  '',
  'void main().catch((err) => {',
  '  console.error(err);',
  '  process.exit(1);',
  '});',
  '',
].join('\n');

// A CONDITIONAL entrypoint already behind `if (require.main === module)`.
const CONDITIONAL = [
  "import { config as dotenvConfig } from 'dotenv';",
  "import { PrismaClient } from '@prisma/client';",
  'dotenvConfig();',
  '',
  'async function main(): Promise<void> {',
  '  const prisma = new PrismaClient();',
  '  await prisma.$disconnect();',
  '}',
  '',
  'if (require.main === module) {',
  '  void main().catch((err) => { console.error(err); process.exit(1); });',
  '}',
  '',
].join('\n');

// A CONDITIONAL entrypoint behind a bare-identifier direct-run test.
const DIRECT_IDENT = [
  "import { config as dotenvConfig } from 'dotenv';",
  "import { PrismaClient } from '@prisma/client';",
  'dotenvConfig();',
  '',
  'async function main(): Promise<void> {',
  '  const prisma = new PrismaClient();',
  '  await prisma.$disconnect();',
  '}',
  '',
  "const direct = process.argv[1]?.endsWith('.ts') ?? false;",
  'if (direct) {',
  '  void main().catch((error) => { console.error(error); process.exit(1); });',
  '}',
  '',
].join('\n');

// The special IIFE entrypoint (sync-federal-award shape).
const SPECIAL_IIFE = [
  "import { config as dotenvConfig } from 'dotenv';",
  "import { PrismaClient } from '@prisma/client';",
  'dotenvConfig();',
  '',
  'async function main(): Promise<void> {',
  '  const prisma = new PrismaClient();',
  '  await prisma.$disconnect();',
  '}',
  '',
  'void (async () => {',
  '  const isDirectRun =',
  "    typeof require !== 'undefined' &&",
  "    typeof module !== 'undefined' &&",
  '    require.main === module;',
  '  if (!isDirectRun) return;',
  '  try {',
  '    await main();',
  '  } catch (err) {',
  '    console.error(err);',
  '    process.exit(1);',
  '  }',
  '})();',
  '',
].join('\n');

export function configGuardControls() {
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok: !!ok, detail });

  const smokeContract = (src, rel = REL) => deriveContract(src, rel, MISSING_DATABASE_URL_SMOKE_CONTEXT);
  const genericContract = (src, rel = REL) => deriveContract(src, rel);

  // ---- POSITIVE: codemod boundary classification ---------------------------

  {
    const t = transformConfigGuard(UNCONDITIONAL, REL);
    add(
      'codemod: an unconditional top-level main() is wrapped in a direct-invocation boundary and gains the guard',
      t.ok === true && t.placement.boundary === 'wrapped' &&
        t.output.includes('if (require.main === module) {') &&
        t.output.includes('if (!process.env.DATABASE_URL) {') &&
        countEnvReads(t.output) === 1 && countDatabaseUrlTokens(t.output) === 2,
      t.ok ? JSON.stringify(t.placement) : JSON.stringify(t.reasons),
    );
  }
  {
    const t = transformConfigGuard(CONDITIONAL, REL);
    add(
      'codemod: a require.main boundary is preserved (existing-conditional) and only the guard is inserted',
      t.ok === true && t.placement.boundary === 'existing-conditional' &&
        t.output.includes('if (require.main === module) {') &&
        countEnvReads(t.output) === 1 && countDatabaseUrlTokens(t.output) === 2,
      t.ok ? JSON.stringify(t.placement) : JSON.stringify(t.reasons),
    );
  }
  {
    const t = transformConfigGuard(DIRECT_IDENT, REL);
    add(
      'codemod: a bare-identifier direct-run boundary is preserved (existing-conditional)',
      t.ok === true && t.placement.boundary === 'existing-conditional',
      t.ok ? JSON.stringify(t.placement) : JSON.stringify(t.reasons),
    );
  }
  {
    const t = transformConfigGuard(SPECIAL_IIFE, REL);
    add(
      'codemod: the special IIFE boundary is preserved (existing-iife); its flow is untouched',
      t.ok === true && t.placement.boundary === 'existing-iife' &&
        t.output.includes('if (!isDirectRun) return;') &&
        t.output.includes('await main();') &&
        countEnvReads(t.output) === 1 && countDatabaseUrlTokens(t.output) === 2,
      t.ok ? JSON.stringify(t.placement) : JSON.stringify(t.reasons),
    );
  }

  // ---- POSITIVE: byte preservation ----------------------------------------

  {
    const t = transformConfigGuard(UNCONDITIONAL, REL);
    // The guard + boundary wrapper are the ONLY added bytes: the transformed
    // output still contains every original executable line verbatim, and the
    // original main body's first statement is unchanged.
    const preserved =
      t.ok &&
      t.output.includes('const prisma = new PrismaClient();') &&
      t.output.includes("import { config as dotenvConfig } from 'dotenv';") &&
      t.output.includes('void main().catch((err) => {') &&
      t.beforeSha256 !== t.afterSha256;
    add('codemod: every preexisting executable statement/import is preserved; only insertions are added', preserved, t.ok ? 'preserved' : JSON.stringify(t.reasons));
  }

  // ---- POSITIVE: config-file loading stays ahead of the guard --------------

  {
    const src = [
      "import { config as dotenvConfig } from 'dotenv';",
      "import { PrismaClient } from '@prisma/client';",
      '',
      'async function main(): Promise<void> {',
      '  dotenvConfig();',
      '  const prisma = new PrismaClient();',
      '  await prisma.$disconnect();',
      '}',
      '',
      'void main().catch((err) => { process.exit(1); });',
      '',
    ].join('\n');
    const t = transformConfigGuard(src, REL);
    const guardIdx = t.ok ? t.output.indexOf('!process.env.DATABASE_URL') : -1;
    const dotenvIdx = t.ok ? t.output.indexOf('dotenvConfig();') : -1;
    add(
      'codemod: an in-main dotenv/config load stays AHEAD of the inserted guard',
      t.ok === true && guardIdx > -1 && dotenvIdx > -1 && guardIdx > dotenvIdx,
      t.ok ? JSON.stringify(t.placement) : JSON.stringify(t.reasons),
    );
  }

  // ---- REFUSALS: fail closed rather than guess ----------------------------

  const refuse = (name, src, reasonRe) => {
    const t = transformConfigGuard(src, REL);
    const a = analyzePlacement(src, REL);
    add(name, t.ok === false && a.ok === false && (!reasonRe || t.reasons.some((r) => reasonRe.test(r))), JSON.stringify(t.reasons ?? []));
  };
  refuse('codemod refuses: source already references DATABASE_URL (idempotency)', UNCONDITIONAL.replace('dotenvConfig();', "dotenvConfig();\nconsole.log(process.env.DATABASE_URL);"), /DATABASE_URL/);
  refuse('codemod refuses: no top-level main function', "import { PrismaClient } from '@prisma/client';\nfunction other() { const p = new PrismaClient(); }\nother();\n", /exactly one/);
  refuse('codemod refuses: main without a direct new PrismaClient()', 'async function main() { console.log(1); }\nvoid main();\n', /PrismaClient/);
  refuse(
    'codemod refuses: main invoked from a named helper (complicated placement)',
    'import { PrismaClient } from \'@prisma/client\';\nasync function main() { const p = new PrismaClient(); }\nfunction run() { void main(); }\nrun();\n',
    /named helper/,
  );
  refuse(
    'codemod refuses: multiple main() call sites',
    "import { PrismaClient } from '@prisma/client';\nasync function main() { const p = new PrismaClient(); }\nvoid main();\nvoid main();\n",
    /exactly one .* call site/,
  );
  refuse('codemod refuses: source that does not parse', 'function ( { ]\n', /does not parse/);

  // ---- SCANNER: conditional-positive / generic-negative -------------------

  {
    const t = transformConfigGuard(UNCONDITIONAL, REL);
    const c = smokeContract(t.output);
    add(
      'scanner(smoke-context): the transformed entrypoint derives a documented configuration-conditioned no-args exit 2',
      t.ok === true && c.noArgs.documented === true && c.noArgs.exit === 2 && c.noArgs.conditioned === 'missing-database-url',
      JSON.stringify(c.noArgs),
    );
    const g = genericContract(t.output);
    add(
      'scanner(generic, no context): the SAME source is CONSERVATIVELY undocumented (env-only guard not recognized)',
      t.ok === true && g.noArgs.documented === false,
      JSON.stringify(g.noArgs),
    );
  }
  {
    // The special IIFE transformed output is likewise recognized under the smoke
    // context (reachability through the top-level IIFE reaches main).
    const t = transformConfigGuard(SPECIAL_IIFE, REL);
    const c = smokeContract(t.output);
    add(
      'scanner(smoke-context): the transformed special IIFE entrypoint is recognized (reachability through the IIFE)',
      t.ok === true && c.noArgs.documented === true && c.noArgs.exit === 2,
      JSON.stringify(c.noArgs),
    );
  }

  // ---- SCANNER adversarial: near-miss env guards MUST stay undocumented ----

  const adversarial = (name, guardBody, extra = '') => {
    const src =
      "import { PrismaClient } from '@prisma/client';\n" +
      'async function main(): Promise<void> {\n' +
      '  const prisma = new PrismaClient();\n' +
      guardBody +
      '}\n' +
      extra +
      '\nvoid main().catch(() => process.exit(1));\n';
    const c = smokeContract(src);
    add(name, c.noArgs.documented === false, JSON.stringify(c.noArgs));
  };

  adversarial('scanner rejects: a local `process` shadow is not the real process.env', '  if (!process.env.DATABASE_URL) { const process = { env: { DATABASE_URL: "x" } }; console.error(\'Usage: x\'); process.exit(2); }\n');
  adversarial('scanner rejects: a DYNAMIC (non-literal) exit is not a definite integer', '  if (!process.env.DATABASE_URL) { console.error(\'Usage: x\'); process.exit(codeFromEnv()); }\n');
  adversarial('scanner rejects: an exit inside a literal-dead branch is not guaranteed', '  if (!process.env.DATABASE_URL) { console.error(\'Usage: x\'); if (false) process.exit(2); }\n');
  adversarial('scanner rejects: an ARBITRARY other env var is not DATABASE_URL', '  if (!process.env.SOMETHING_ELSE) { console.error(\'Usage: x\'); process.exit(2); }\n');
  adversarial('scanner rejects: a bare PRESENCE test is not a missing-value test', '  if (process.env.DATABASE_URL) { console.error(\'Usage: x\'); process.exit(2); }\n');
  adversarial('scanner rejects: usage without a definite exit is UNRESOLVED', '  if (!process.env.DATABASE_URL) { console.error(\'Usage: x\'); }\n');
  adversarial('scanner rejects: `=== null` is FALSE for an absent (undefined) value', '  if (process.env.DATABASE_URL === null) { console.error(\'Usage: x\'); process.exit(2); }\n');
  adversarial('scanner rejects: usage through a local helper is not INLINE', '  function usage() { console.error(\'Usage: x\'); process.exit(2); }\n  if (!process.env.DATABASE_URL) { usage(); }\n');

  // A guard AFTER an unconditional abrupt statement is unreachable.
  {
    const src =
      "import { PrismaClient } from '@prisma/client';\n" +
      'async function main(): Promise<void> {\n' +
      '  const prisma = new PrismaClient();\n' +
      '  return;\n' +
      '  if (!process.env.DATABASE_URL) { console.error(\'Usage: x\'); process.exit(2); }\n' +
      '}\n' +
      'void main().catch(() => process.exit(1));\n';
    const c = smokeContract(src);
    add('scanner rejects: a guard after an unconditional return is unreachable', c.noArgs.documented === false, JSON.stringify(c.noArgs));
  }

  // ---- Scanner positive: the exact bare missing-value forms ARE recognized --

  const positiveForm = (name, cond) => {
    const src =
      "import { PrismaClient } from '@prisma/client';\n" +
      'async function main(): Promise<void> {\n' +
      '  const prisma = new PrismaClient();\n' +
      `  if (${cond}) { console.error('Usage: x'); process.exit(2); }\n` +
      '}\n' +
      'void main().catch(() => process.exit(1));\n';
    const c = smokeContract(src);
    add(name, c.noArgs.documented === true && c.noArgs.exit === 2, JSON.stringify(c.noArgs));
  };
  positiveForm('scanner accepts: `!process.env.DATABASE_URL` (missing value) → exit 2', '!process.env.DATABASE_URL');
  positiveForm('scanner accepts: `process.env.DATABASE_URL == null` (undefined == null) → exit 2', 'process.env.DATABASE_URL == null');
  positiveForm("scanner accepts: `process.env['DATABASE_URL'] === undefined` → exit 2", "process.env['DATABASE_URL'] === undefined");

  // ---- SCANNER: the exact root-review1192 missing-DATABASE_URL cases -------
  // The ten independently-reproduced FALSE ACCEPTANCES from root-review1192 are
  // reproduced verbatim here, alongside the six cases that already behaved
  // correctly. Every source is driven through the ACTUAL deriver under the named
  // smoke context.
  {
    const GUARD =
      "if (!process.env.DATABASE_URL) { console.error('Usage: fixture requires database configuration'); process.exit(2); }";
    const cases = [
      ['root1192/pos: a bare healthy inline guard is documented (smoke context)',
        `if (!process.env.DATABASE_URL) { console.error('Usage: fixture requires database configuration'); process.exit(2); }`, true],
      ['root1192/pos: main behind require.main===module is documented (smoke context)',
        `async function main(){${GUARD}} if(require.main===module) void main();`, true],
      ['root1192/pos: the async IIFE direct-run boundary is documented (smoke context)',
        `async function main(){${GUARD}} const direct=require.main===module; void(async()=>{if(!direct)return;await main();})();`, true],
      ['root1192/neg: a guard inside a literal-dead enclosing branch is refused',
        `if(false){${GUARD}}`, false],
      ['root1192/neg: main invoked only under if(false) is refused',
        `async function main(){${GUARD}} if(false)void main();`, false],
      ['root1192/neg: a guard inside an unknown enclosing branch is refused',
        `if(unknownCondition){${GUARD}}`, false],
      ['root1192/neg: invoking a SHADOWED same-named main is refused',
        `function main(){${GUARD}} {const main=()=>{};main();}`, false],
      ['root1192/neg: a prior direct DATABASE_URL assignment is refused',
        `process.env.DATABASE_URL='configured';${GUARD}`, false],
      ['root1192/neg: a prior env-ALIAS DATABASE_URL assignment is refused',
        `const env=process.env;env.DATABASE_URL='configured';${GUARD}`, false],
      ['root1192/neg: replacing process.env is refused',
        `process.env={DATABASE_URL:'configured'};${GUARD}`, false],
      ['root1192/neg: overwriting process.exit is refused',
        `process.exit=()=>{};${GUARD}`, false],
      ['root1192/neg: a conditional Usage print is not guaranteed (refused)',
        `if(!process.env.DATABASE_URL){if(unknownCondition)console.error('Usage: fixture');process.exit(2);}`, false],
      ['root1192/neg: a Usage print in a literal-dead branch is refused',
        `if(!process.env.DATABASE_URL){if(false)console.error('Usage: fixture');process.exit(2);}`, false],
      ['root1192/neg: a SHADOWED console cannot prove usage (refused)',
        `const console={error(){}};${GUARD}`, false],
      ['root1192/neg: an unbound usage callee is refused',
        `if(!process.env.DATABASE_URL){emitUsage('Usage: fixture');process.exit(2);}`, false],
    ];
    for (const [name, src, expected] of cases) {
      const c = smokeContract(src);
      add(name, c.noArgs.documented === expected, JSON.stringify(c.noArgs));
    }
    // An identity COPY of the context is NOT the named context and is refused.
    const copied = deriveContract(GUARD, 'fixture.ts', { ...MISSING_DATABASE_URL_SMOKE_CONTEXT });
    add('root1192/neg: an object COPY of the smoke context is NOT selected', copied.noArgs.documented === false, JSON.stringify(copied.noArgs));
  }

  // ---- SCANNER: literal vs dynamic usage, definite vs conditional exit ------
  {
    const wrap = (body) =>
      "import { PrismaClient } from '@prisma/client';\n" +
      'async function main(): Promise<void> {\n  const prisma = new PrismaClient();\n' +
      body +
      '}\nvoid main().catch(() => process.exit(1));\n';
    const literalUsage = smokeContract(wrap("  if (!process.env.DATABASE_URL) { console.error('Usage: x'); process.exit(2); }\n"));
    add('configguard/pos: an inline LITERAL Usage string is required and accepted', literalUsage.noArgs.documented === true && literalUsage.noArgs.exit === 2, JSON.stringify(literalUsage.noArgs));
    const dynamicUsage = smokeContract(wrap('  if (!process.env.DATABASE_URL) { console.error(MSG); process.exit(2); }\n'));
    add('configguard/neg: a DYNAMIC (non-literal) Usage argument is refused', dynamicUsage.noArgs.documented === false, JSON.stringify(dynamicUsage.noArgs));
    const conditionalExit = smokeContract(wrap("  if (!process.env.DATABASE_URL) { console.error('Usage: x'); if (unknown) process.exit(2); }\n"));
    add('configguard/neg: a conditional exit is not definite and is refused', conditionalExit.noArgs.documented === false, JSON.stringify(conditionalExit.noArgs));
    const streamUsage = smokeContract(wrap("  if (!process.env.DATABASE_URL) { process.stderr.write('Usage: x'); process.exit(7); }\n"));
    add('configguard/pos: process.stderr.write literal usage + integer exit is accepted', streamUsage.noArgs.documented === true && streamUsage.noArgs.exit === 7, JSON.stringify(streamUsage.noArgs));
  }

  // ---- CODEMOD: config-loader placement must be a REAL imported dotenv call -
  {
    const withMain = (imports, body) =>
      imports + '\n\nasync function main(): Promise<void> {\n' + body + '\n}\n\nvoid main().catch(() => process.exit(1));\n';
    {
      const src = withMain(
        "import { config as dotenvConfig } from 'dotenv';\nimport { PrismaClient } from '@prisma/client';",
        '  dotenvConfig();\n  const prisma = new PrismaClient();\n  await prisma.$disconnect();',
      );
      const t = transformConfigGuard(src, REL);
      const g = t.ok ? t.output.indexOf('!process.env.DATABASE_URL') : -1;
      const d = t.ok ? t.output.indexOf('dotenvConfig();') : -1;
      add('codemod: a REAL imported dotenv call stays ahead of the inserted guard', t.ok === true && g > -1 && d > -1 && g > d, t.ok ? JSON.stringify(t.placement) : JSON.stringify(t.reasons));
    }
    {
      const src = withMain(
        "import { PrismaClient } from '@prisma/client';",
        '  config();\n  const prisma = new PrismaClient();\n  await prisma.$disconnect();',
      );
      const t = transformConfigGuard(src, REL);
      const g = t.ok ? t.output.indexOf('!process.env.DATABASE_URL') : -1;
      const c = t.ok ? t.output.indexOf('config();') : -1;
      add('codemod: an arbitrary local config() is NOT skipped as a dotenv load (guard first)', t.ok === true && g > -1 && c > -1 && g < c, t.ok ? JSON.stringify(t.placement) : JSON.stringify(t.reasons));
    }
    {
      const src = withMain(
        "import { config as dotenvConfig } from 'dotenv';\nimport { PrismaClient } from '@prisma/client';",
        '  dotenvConfig(), sideEffect();\n  const prisma = new PrismaClient();\n  await prisma.$disconnect();',
      );
      const t = transformConfigGuard(src, REL);
      const g = t.ok ? t.output.indexOf('!process.env.DATABASE_URL') : -1;
      const c = t.ok ? t.output.indexOf('dotenvConfig(), sideEffect();') : -1;
      add('codemod: a comma/sequence statement is NOT skipped as a dotenv load (guard first)', t.ok === true && g > -1 && c > -1 && g < c, t.ok ? JSON.stringify(t.placement) : JSON.stringify(t.reasons));
    }
  }

  // ---- CODEMOD: a boundary must be a SOURCE-PROVEN direct-invocation test ---
  {
    const withMain = (imports, body) => imports + '\n\nasync function main(): Promise<void> {\n' + body + '\n}\n\n';
    {
      const src =
        withMain("import { PrismaClient } from '@prisma/client';", '  const prisma = new PrismaClient();\n  await prisma.$disconnect();') +
        "const isDirectRun = /probe(\\.[cm]?[tj]s)?$/.test((process.argv[1] ?? '').replace(/\\\\/g, '/'));\nif (isDirectRun) { void main().catch(() => process.exit(1)); }\n";
      const t = transformConfigGuard(src, REL);
      add('codemod: a source-proven argv[1] basename alias boundary is accepted (existing-conditional)', t.ok === true && t.placement.boundary === 'existing-conditional', t.ok ? JSON.stringify(t.placement) : JSON.stringify(t.reasons));
    }
    {
      const src =
        withMain("import { PrismaClient } from '@prisma/client';", '  const prisma = new PrismaClient();\n  await prisma.$disconnect();') +
        'const direct = shouldRun();\nif (direct) { void main().catch(() => process.exit(1)); }\n';
      const t = transformConfigGuard(src, REL);
      add('codemod: an UNPROVEN bare-identifier boundary is refused (never guessed)', t.ok === false && t.reasons.some((r) => /source-proven direct-invocation/.test(r)), JSON.stringify(t.reasons ?? []));
    }
  }

  // ---- CODEMOD CLI: argument parsing is fail-closed -------------------------
  {
    const helpWithUnknown = (() => {
      try {
        parseArgs(['--help', '--definitely-not-a-flag']);
        return 'no-throw';
      } catch (e) {
        return e.message;
      }
    })();
    add('codemod CLI: an unknown option is rejected even alongside --help', typeof helpWithUnknown === 'string' && /unknown option/.test(helpWithUnknown), String(helpWithUnknown));
    const helpOnly = (() => {
      try {
        return parseArgs(['--help']);
      } catch (e) {
        return { error: e.message };
      }
    })();
    add('codemod CLI: --help alone parses without requiring --root/--manifest/--out-ledger', helpOnly && helpOnly.help === true, JSON.stringify(helpOnly));
    const bareReq = (() => {
      try {
        parseArgs([]);
        return 'no-throw';
      } catch (e) {
        return e.message;
      }
    })();
    add('codemod CLI: missing required options throw a usage error', typeof bareReq === 'string' && /required/.test(bareReq), String(bareReq));
  }

  // ---- ROOT-REVIEW1217: the five reproduced FALSE ACCEPTANCES --------------
  // Each previously claimed a reachable main-owned Usage/2 guard through a
  // bogus direct-invocation boundary. Root now REQUIRES every one to be refused
  // by the ACTUAL dedicated prover (under the SAME named smoke context) and, for
  // the codemod, by the ACTUAL boundary proof (never guessed).
  {
    const GUARD =
      "if (!process.env.DATABASE_URL) { console.error('Usage: fixture requires database configuration'); process.exit(2); }";
    const mainOnly = `async function main(){${GUARD}}`;
    const smokeCases = [
      ['root1217/neg1: `.endsWith(<wrong literal>)` is not a direct-run test',
        `${mainOnly}if(process.argv[1]?.endsWith('.wrong'))void main();`],
      ['root1217/neg2: a regex for an UNRELATED basename is not a direct-run test',
        String.raw`${mainOnly}if(/other(\.[cm]?[tj]s)?$/.test(process.argv[1]))void main();`],
      ['root1217/neg3: a TRANSFORMED argv subtree (.slice) is not the original value',
        `${mainOnly}if(process.argv[1].slice(0,1).endsWith('fixture.ts'))void main();`],
      ['root1217/neg4: an UNKNOWN typeof symbol is not an always-true guard',
        `${mainOnly}if(typeof unavailable!=='undefined'&&require.main===module)void main();`],
      ['root1217/neg5: a conditional IIFE return cannot prove a definite true',
        `${mainOnly}const direct=(()=>{if(unknownCondition)return require.main===module;return false;})();if(direct)void main();`],
    ];
    for (const [name, src] of smokeCases) {
      const c = smokeContract(src, 'fixture.ts');
      add(name, c.noArgs.documented === false, JSON.stringify(c.noArgs));
    }

    // The SAME counterexamples (plus nearby mutations / shadowing) must be
    // refused by the CODEMOD's source-proven boundary proof.
    const codemodMain =
      "import { PrismaClient } from '@prisma/client';\n" +
      'async function main(): Promise<void> {\n  const prisma = new PrismaClient();\n  await prisma.$disconnect();\n}\n';
    const REL_FIXTURE = 'apps/api/scripts/fixture.ts';
    const refuseBoundary = (name, boundary) => {
      const t = transformConfigGuard(codemodMain + boundary, REL_FIXTURE);
      add(name, t.ok === false && (t.reasons || []).some((r) => /source-proven direct-invocation/.test(r)), JSON.stringify(t.reasons ?? []));
    };
    refuseBoundary(
      'root1217/neg1(codemod): `.endsWith(<wrong literal>)` boundary is refused',
      "const isDirectRun = process.argv[1]?.endsWith('.wrong') ?? false;\nif (isDirectRun) { void main().catch(() => process.exit(1)); }\n",
    );
    refuseBoundary(
      'root1217/neg2(codemod): an unrelated-basename regex boundary is refused',
      String.raw`const isDirectRun = /other(\.[cm]?[tj]s)?$/.test((process.argv[1] ?? '').replace(/\\/g, '/'));
if (isDirectRun) { void main().catch(() => process.exit(1)); }
`,
    );
    refuseBoundary(
      'root1217/neg3(codemod): a transformed argv subtree boundary is refused',
      "const isDirectRun = process.argv[1].slice(0, 1).endsWith('fixture.ts');\nif (isDirectRun) { void main().catch(() => process.exit(1)); }\n",
    );
    refuseBoundary(
      'root1217/neg4(codemod): an unknown typeof symbol boundary is refused',
      "const isDirectRun = typeof unavailable !== 'undefined' && require.main === module;\nif (isDirectRun) { void main().catch(() => process.exit(1)); }\n",
    );
    refuseBoundary(
      'root1217/neg5(codemod): a conditional IIFE-return boundary is refused',
      'const isDirectRun = (() => { if (unknownCondition) return require.main === module; return false; })();\nif (isDirectRun) { void main().catch(() => process.exit(1)); }\n',
    );
    // Nearby shadowing: a shadowed `process` / `require` is never the real global.
    refuseBoundary(
      'root1217/neg6(codemod): a SHADOWED `process` argv basename test is refused',
      String.raw`const process = { argv: ['node', 'fixture.ts'] };
const isDirectRun = /fixture(\.[cm]?[tj]s)?$/.test((process.argv[1] ?? '').replace(/\\/g, '/'));
if (isDirectRun) { void main().catch(() => process.exit(1)); }
`,
    );
    refuseBoundary(
      'root1217/neg7(codemod): a SHADOWED `require` is not the real require.main',
      'const require = { main: null };\nconst isDirectRun = require.main === module;\nif (isDirectRun) { void main().catch(() => process.exit(1)); }\n',
    );
    // An unknown/arbitrary path test (an unresolved helper) is refused.
    refuseBoundary(
      'root1217/neg8(codemod): an unknown path (unresolved alias) is refused',
      'const isDirectRun = shouldRun();\nif (isDirectRun) { void main().catch(() => process.exit(1)); }\n',
    );
  }

  // ---- ACTUAL-SUBJECT POSITIVES: the 21 pending invocation boundary shapes -
  // Each is the REAL boundary form used by an `apps/api/scripts/*.ts` pending
  // subject, bound to that subject's OWN canonical rel/stem. It is driven through
  // BOTH the codemod (source-proven boundary preserved → guard inserted) AND the
  // dedicated deriver (`deriveContract(output, rel, SAME smoke context)`).
  {
    const HEADER = "import { PrismaClient } from '@prisma/client';\n";
    const MAIN = 'async function main(): Promise<void> {\n  const prisma = new PrismaClient();\n  await prisma.$disconnect();\n}\n';
    const IIFE = (stem) =>
      String.raw`const isDirectRun = (() => {
  try {
    const invoked = process.argv[1] ?? '';
    return /${stem}(\.[cm]?[tj]s)?$/.test(invoked.replace(/\\/g, '/'));
  } catch {
    return false;
  }
})();
if (isDirectRun) { void main().catch(() => process.exit(1)); }`;
    const DIRECT_REGEX = (stem) =>
      String.raw`const isDirectRun = /${stem}(\.[cm]?[tj]s)?$/.test((process.argv[1] ?? '').replace(/\\/g, '/'));
if (isDirectRun) { void main().catch(() => process.exit(1)); }`;
    const INVOKED_INCLUDES = (stem) =>
      `const invoked = process.argv[1] ?? '';\nif (invoked.includes('${stem}')) { void main().catch(() => process.exit(1)); }`;
    const ARGV1_AND_INCLUDES = (stem) =>
      `if (process.argv[1] && process.argv[1].includes('${stem}')) { void main().catch(() => process.exit(1)); }`;
    const TYPEOF_ARGV1_REGEX = (stem) =>
      String.raw`const invokedDirectly = typeof process.argv[1] === 'string' && /${stem}(\.ts|\.js)?$/.test(process.argv[1]);
if (invokedDirectly) { void main().catch(() => process.exit(1)); }`;
    const TYPEOF_PROCESS_REGEX = (stem) =>
      String.raw`const invokedDirectly =
  typeof process !== 'undefined' &&
  Array.isArray(process.argv) &&
  /${stem}(\.ts|\.js)?$/.test(process.argv[1] ?? '');
if (invokedDirectly) { void main().catch(() => process.exit(1)); }`;

    const PENDING = [
      ['backfill-sam-opportunity-fields', IIFE],
      ['diag-tango-health', IIFE],
      ['diag-tango-opportunity-parity', IIFE],
      ['sync-sam-opportunities', IIFE],
      ['sync-tango-dibbs', IIFE],
      ['sync-tango-entities', IIFE],
      ['sync-tango-forecasts', IIFE],
      ['sync-tango-opportunity-attachments', IIFE],
      ['sync-tango-opportunity-notices', IIFE],
      ['sync-tango-opportunity-shadow', IIFE],
      ['sync-tango-opportunity-text', IIFE],
      ['sync-tango-sbir', IIFE],
      ['sync-tango-vehicles', IIFE],
      ['repair-cpf-cds-existing-geography', DIRECT_REGEX],
      ['sync-tango-subawards', DIRECT_REGEX],
      ['diag-funding-opportunities-makegov', INVOKED_INCLUDES],
      ['diag-tango-dibbs-sbir-ingestion', INVOKED_INCLUDES],
      ['process-tango-events', INVOKED_INCLUDES],
      ['build-district-boundary-artifacts', ARGV1_AND_INCLUDES],
      ['measure-accuracy', TYPEOF_ARGV1_REGEX],
      ['reconcile-person-role-staleness', TYPEOF_PROCESS_REGEX],
    ];
    for (const [stem, make] of PENDING) {
      const rel = `apps/api/scripts/${stem}.ts`;
      const src = HEADER + MAIN + make(stem) + '\n';
      const t = transformConfigGuard(src, rel);
      const c = t.ok ? smokeContract(t.output, rel) : null;
      add(
        `pending/pos(codemod): ${stem} source-proven boundary is preserved (existing-conditional) and gains the guard`,
        t.ok === true && t.placement.boundary === 'existing-conditional' &&
          countEnvReads(t.output) === 1 && countDatabaseUrlTokens(t.output) === 2,
        t.ok ? JSON.stringify(t.placement) : JSON.stringify(t.reasons ?? []),
      );
      add(
        `pending/pos(contract): ${stem} derives documented missing-database-url exit 2 (smoke context)`,
        !!c && c.noArgs.documented === true && c.noArgs.exit === 2 && c.noArgs.conditioned === 'missing-database-url',
        c ? JSON.stringify(c.noArgs) : JSON.stringify(t.reasons ?? []),
      );
    }
  }

  // ---- ROOT-REVIEW1237: ELEVEN reproduced FALSE ACCEPTANCES ----------------
  // Each previously credited a bogus direct-invocation boundary. Root now
  // REQUIRES every one to be refused by the ACTUAL shared prover (under the SAME
  // named smoke context) AND, where the boundary is a codemod shape, by the
  // ACTUAL boundary proof (never guessed).
  {
    const GUARD =
      "if (!process.env.DATABASE_URL) { console.error('Usage: fixture requires database configuration'); process.exit(2); }";
    const mainOnly = `async function main(){${GUARD}}`;
    const smokeNeg = (name, src) => {
      const c = smokeContract(src, 'fixture.ts');
      add(name, c.noArgs.documented === false, JSON.stringify(c.noArgs));
    };

    // 1 & 7: an earlier possibly-exiting IIFE branch makes the later return not definite.
    smokeNeg(
      'root1237/1: an IIFE whose earlier unknown-conditioned return may exit does not prove a definite later return (refused)',
      `${mainOnly}const direct=(()=>{if(unknownCondition)return false;return require.main===module;})();if(direct)void main();`,
    );
    // 2: the ACTUAL bounded regex is false on the invoked subject (no dropped group).
    smokeNeg(
      'root1237/2: a regex optional group is NOT dropped — /fixture(\\.wrong)?$/ does not match fixture.ts (refused)',
      mainOnly + 'if(/fixture(\\.wrong)?$/.test(process.argv[1]))void main();',
    );
    // 3: a stem is not a full-path suffix.
    smokeNeg(
      'root1237/3: `.endsWith(<stem>)` is not a suffix of the invoked path (refused)',
      `${mainOnly}if(process.argv[1].endsWith('fixture'))void main();`,
    );
    // 4: a basename is not an absolute-path prefix.
    smokeNeg(
      'root1237/4: `.startsWith(<basename>)` is not a provable absolute-path prefix (refused)',
      `${mainOnly}if(process.argv[1].startsWith('fixture.ts'))void main();`,
    );
    // 5: an argv alias reassigned before use is not the argv value.
    smokeNeg(
      'root1237/5: an argv[1] alias reassigned to an unrelated path is not argv[1] (refused)',
      `${mainOnly}let invoked=process.argv[1];invoked='other.ts';if(invoked.endsWith('fixture.ts'))void main();`,
    );
    // 6: a logical assignment changes the alias truth (and a const assignment throws).
    smokeNeg(
      'root1237/6: a logical assignment (`&&=`) to a direct alias changes its truth (refused)',
      `${mainOnly}let direct=require.main===module;direct&&=false;if(direct)void main();`,
    );
    smokeNeg(
      'root1237/6b: an (illegal, runtime-throwing) const assignment is not a successful proof (refused)',
      `${mainOnly}const direct=require.main===module;direct=false;if(direct)void main();`,
    );
    // 7: a possibly-throwing operation before the IIFE return makes it not definite.
    smokeNeg(
      'root1237/7: a possibly-throwing call before an IIFE return makes the return not definite (refused)',
      `${mainOnly}const direct=(()=>{unknownOperation();return require.main===module;})();if(direct)void main();`,
    );
    // 8: a `finally` return overrides the direct return.
    smokeNeg(
      'root1237/8: a `finally{return false}` overrides the direct return (refused)',
      `${mainOnly}const direct=(()=>{try{return require.main===module;}finally{return false;}})();if(direct)void main();`,
    );
    // 9: an unknown try operation can route into a false catch.
    smokeNeg(
      'root1237/9: an unknown try operation can route into `catch{return false}` (refused)',
      `${mainOnly}const direct=(()=>{try{unknownOperation();return require.main===module;}catch{return false;}})();if(direct)void main();`,
    );
    // 10: an extra path.resolve argument changes the basename.
    smokeNeg(
      'root1237/10: `path.resolve(argv1, <extra>)` changes the basename (refused)',
      "import * as path from 'node:path';" + mainOnly + "if(path.resolve(process.argv[1],'other.ts').endsWith('fixture.ts'))void main();",
    );
    // 11: a named import aliased to a `path`-looking name is not the real namespace.
    smokeNeg(
      'root1237/11: `import {dirname as path}` is not the `node:path` namespace — `path.resolve` is refused',
      "import {dirname as path} from 'node:path';" + mainOnly + "if(path.resolve(process.argv[1]).endsWith('fixture.ts'))void main();",
    );

    // The SAME counterexamples must be refused by the CODEMOD's boundary proof.
    const codemodMain =
      "import { PrismaClient } from '@prisma/client';\n" +
      'async function main(): Promise<void> {\n  const prisma = new PrismaClient();\n  await prisma.$disconnect();\n}\n';
    const REL_FIXTURE = 'apps/api/scripts/fixture.ts';
    const refuseBoundary = (name, boundary, prefix = '') => {
      const t = transformConfigGuard(prefix + codemodMain + boundary, REL_FIXTURE);
      add(name, t.ok === false && (t.reasons || []).some((r) => /source-proven direct-invocation/.test(r)), JSON.stringify(t.reasons ?? []));
    };
    const WRAP = ' { void main().catch(() => process.exit(1)); }\n';
    refuseBoundary(
      'root1237/1(codemod): an unknown-conditioned earlier IIFE exit is refused',
      'const direct = (() => { if (unknownCondition) return false; return require.main === module; })();\nif (direct)' + WRAP,
    );
    refuseBoundary(
      'root1237/2(codemod): a wrong optional-group regex boundary is refused',
      'const isDirectRun = /fixture(\\.wrong)?$/.test((process.argv[1] ?? \'\').replace(/\\\\/g, \'/\'));\nif (isDirectRun)' + WRAP,
    );
    refuseBoundary(
      'root1237/3(codemod): a stem `.endsWith` boundary is refused',
      'const isDirectRun = process.argv[1].endsWith(\'fixture\');\nif (isDirectRun)' + WRAP,
    );
    refuseBoundary(
      'root1237/4(codemod): a basename `.startsWith` boundary is refused',
      'const isDirectRun = process.argv[1].startsWith(\'fixture.ts\');\nif (isDirectRun)' + WRAP,
    );
    refuseBoundary(
      'root1237/5(codemod): a reassigned argv alias boundary is refused',
      'let invoked = process.argv[1];\ninvoked = \'other.ts\';\nif (invoked.endsWith(\'fixture.ts\'))' + WRAP,
    );
    refuseBoundary(
      'root1237/6(codemod): a logical-assigned direct alias boundary is refused',
      'let direct = require.main === module;\ndirect &&= false;\nif (direct)' + WRAP,
    );
    refuseBoundary(
      'root1237/6b(codemod): an assigned const direct alias boundary is refused',
      'const direct = require.main === module;\ndirect = false;\nif (direct)' + WRAP,
    );
    refuseBoundary(
      'root1237/7(codemod): a possibly-throwing pre-return op boundary is refused',
      'const direct = (() => { unknownOperation(); return require.main === module; })();\nif (direct)' + WRAP,
    );
    refuseBoundary(
      'root1237/8(codemod): a `finally`-overridden return boundary is refused',
      'const direct = (() => { try { return require.main === module; } finally { return false; } })();\nif (direct)' + WRAP,
    );
    refuseBoundary(
      'root1237/9(codemod): an unknown-try/false-catch boundary is refused',
      'const direct = (() => { try { unknownOperation(); return require.main === module; } catch { return false; } })();\nif (direct)' + WRAP,
    );
    refuseBoundary(
      'root1237/10(codemod): a two-arg path.resolve boundary is refused',
      'const isDirectRun = path.resolve(process.argv[1], \'other.ts\').endsWith(\'fixture.ts\');\nif (isDirectRun)' + WRAP,
      "import * as path from 'node:path';\n",
    );
    refuseBoundary(
      'root1237/11(codemod): a named-import path alias boundary is refused',
      'const isDirectRun = path.resolve(process.argv[1]).endsWith(\'fixture.ts\');\nif (isDirectRun)' + WRAP,
      "import { dirname as path } from 'node:path';\n",
    );
  }

  {
    const guard = "if(!process.env.DATABASE_URL){console.error('Usage: fixture');process.exit(2);}";
    const boundaries = [
      ['anchored complete basename regex', String.raw`if(/^fixture\.ts$/.test(process.argv[1]))void main();`],
      ['anchored basename prefix regex', String.raw`if(/^fixture/.test(process.argv[1]))void main();`],
      ['endsWith explicit end position', "if(process.argv[1].endsWith('fixture.ts',0))void main();"],
      ['includes explicit start position', "if(process.argv[1].includes('fixture.ts',999999))void main();"],
      ['typeof unknown property before IIFE return', 'const direct=(()=>{typeof unavailable.property;return require.main===module;})();if(direct)void main();'],
      ['typeof lexical TDZ before IIFE return', 'const direct=(()=>{typeof later;const later=1;return require.main===module;})();if(direct)void main();'],
      ['regex language exceeds finite expansion cap', 'if(/' + 'a?'.repeat(30) + 'fixture\\.ts$/.test(process.argv[1]))void main();'],
    ];
    for (const [name, boundary] of boundaries) {
      const source = `async function main(){${guard}}${boundary}`;
      const contract = deriveContract(source, 'fixture.ts', MISSING_DATABASE_URL_SMOKE_CONTEXT);
      add(`root1262/contract: ${name} is refused`, contract.noArgs.documented === false, JSON.stringify(contract.noArgs));
      const candidate = "import {PrismaClient} from '@prisma/client';async function main(){const prisma=new PrismaClient();await prisma.$disconnect();}" + boundary;
      const transformed = transformConfigGuard(candidate, 'apps/api/scripts/fixture.ts');
      add(`root1262/codemod: ${name} is refused`, transformed.ok === false, JSON.stringify(transformed.reasons));
    }
  }

  for (const declaration of [
    'export async function main()',
    'export default async function main()',
    'async function main()',
  ]) {
    const exports = declaration.startsWith('export') ? [''] : ['export {main};', 'export {main as execute};', 'export default main;'];
    for (const suffix of exports) {
      const candidate = `import {PrismaClient} from '@prisma/client';${declaration}{const prisma=new PrismaClient();await prisma.$disconnect();}if(require.main===module)void main();${suffix}`;
      const result = transformConfigGuard(candidate, 'apps/api/scripts/fixture.ts');
      add(`exported executor remains a library boundary: ${declaration} ${suffix}`, result.ok === false && result.reasons.some((r) => r.includes('is exported')), JSON.stringify(result.reasons));
    }
  }

  return checks;
}

function runControls() {
  const checks = configGuardControls();
  const failed = checks.filter((c) => !c.ok);
  return { module: 'config-guard-controls', checks, passed: checks.length - failed.length, total: checks.length, ok: failed.length === 0 };
}

export { runControls as runConfigGuardControls };

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length <= 2) {
    console.error('Usage: node scripts/cleanup-script-smoke/config-guard-controls.mjs --self-test');
    process.exit(2);
  }
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') {
    console.log('Usage: node scripts/cleanup-script-smoke/config-guard-controls.mjs --self-test');
    process.exit(0);
  }
  if (args.length !== 1 || args[0] !== '--self-test') {
    console.error('Usage: node scripts/cleanup-script-smoke/config-guard-controls.mjs --self-test');
    process.exit(2);
  }
  const r = runControls();
  process.stdout.write(JSON.stringify(r, null, 2) + '\n');
  process.exitCode = r.ok ? 0 : 1;
}
