/**
 * CleanUp1 §6.2 — CONTRACT-DERIVATION controls for the per-entrypoint DOCUMENTED
 * CLI contract (contract.mjs).
 *
 * These are executable controls (root runs them; NO Docker, NO subject process).
 * They drive the ACTUAL `deriveContract` over in-memory source strings, so the
 * deriver's SOURCE-DERIVED recognition is exercised POSITIVELY (the real
 * reachable argValue/usage helper shape the parser previously missed) and
 * ADVERSELY (unused/foreign helpers, incorrect argv binding, help negation,
 * ambiguous/dynamic exit, helper side effects, nested reachability, arbitrary
 * console output, unbound arrays). Every fixture is source-only: no process is
 * executed, no exit is inferred from an observed run, and no conventional value
 * is assumed.
 *
 * Obligations retained: the five round-7 anti-false-positive rules (ordinary
 * console output is not usage; an unrelated `items.length` is not argv; an
 * unused function's branch is not help; a stray `'--help'` constant is not an
 * argument test; `!argv.includes('--help')` is not help).
 *
 * Contract1076 adds SIX regression controls (root-contract1074-order-probes-
 * result.json) for the repaired proof model: cross-scope captured-local TDZ (1),
 * guards after an unconditional return/throw (2, 6), the bounded helper-body
 * grammar vs a whitelisted method name on an undefined receiver (3), the actual
 * call argument bound to an index-guarded helper (4), and Object.assign over
 * String.prototype disabling empty-preservation (5). The 59 prior controls are
 * kept verbatim; expected total 65.
 *
 * Run:  `node scripts/cleanup-script-smoke/contract-controls.mjs`
 * Exit: 0 all controls pass; 1 a control failed.
 */
import { deriveContract, MISSING_DATABASE_URL_SMOKE_CONTEXT } from './contract.mjs';

/** The real diagnosed helper shape (accept-defense-budget-ingestion-review-v1.ts). */
const VALUE_HELPER =
  'function argValue(flag: string): string | undefined {\n' +
  '  const i = process.argv.indexOf(flag);\n' +
  '  return i >= 0 ? process.argv[i + 1] : undefined;\n' +
  '}\n';
const USAGE_HELPER =
  'function usage(message: string): never {\n' +
  '  console.error(`tool: ${message}`);\n' +
  "  console.error('usage: tool --environment <env>');\n" +
  '  process.exit(2);\n' +
  '}\n';

/**
 * Build the control list. Each entry is `{ name, ok, detail }`; the deriver is
 * driven over a pure in-memory source string.
 */
export function contractControls() {
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok: !!ok, detail });
  const derive = (src, rel = 'subject.ts') => deriveContract(src, rel);
  const deriveSmoke = (src, rel = 'subject.ts') => deriveContract(src, rel, MISSING_DATABASE_URL_SMOKE_CONTEXT);

  // ---- POSITIVE ------------------------------------------------------------

  // The exact diagnosed shape: argValue('--environment') bound through a pure
  // local helper; `if (!environment) usage(...)`; the usage helper prints a usage
  // line and names process.exit(2); main is reached via `void main()`.
  {
    const src =
      VALUE_HELPER +
      USAGE_HELPER +
      'async function main(): Promise<void> {\n' +
      "  const environment = argValue('--environment');\n" +
      "  if (!environment) usage('--environment is required');\n" +
      '}\n' +
      'void main().catch((e) => { console.error(e); process.exit(1); });\n';
    const c = derive(src);
    add(
      'reachable pure argv helper + required-value guard derives documented no-args exit 2',
      c.noArgs.documented === true && c.noArgs.exit === 2 && c.noArgs.usagePrinted === true,
      JSON.stringify(c.noArgs),
    );
  }

  // Direct argv-length usage branch (regression: must keep working).
  {
    const src = "if (process.argv.length < 3) {\n  console.error('usage: tool x');\n  process.exit(2);\n}\n";
    const c = derive(src);
    add(
      'direct argv-length usage branch still derives documented exit 2',
      c.noArgs.documented === true && c.noArgs.exit === 2,
      JSON.stringify(c.noArgs),
    );
  }

  // One argument is present when argv.length is 3; a help-only conjunction
  // cannot be counted as a no-argument usage branch.
  {
    const src =
      "if (process.argv.length === 3 && process.argv[2] === '--help') { console.error('Usage: tool'); process.exit(0); }\n" +
      "if (!process.env.DATABASE_URL) { console.error('Usage: tool'); process.exit(2); }\n";
    const generic = derive(src);
    add(
      'argv-length/help conjunction is not a generic no-args branch',
      generic.noArgs.documented === false && generic.help.supported === true && generic.help.exit === 0,
      JSON.stringify({ noArgs: generic.noArgs, help: generic.help }),
    );
  }

  // Nested reachability: the usage helper calls a local printer helper.
  {
    const src =
      "function emit(): void { console.error('usage: nested tool'); }\n" +
      'function usage(message: string): never { emit(); process.exit(2); }\n' +
      VALUE_HELPER +
      "const env = argValue('--environment');\n" +
      "if (!env) usage('need env');\n";
    const c = derive(src);
    add(
      'usage resolved through a nested local helper derives documented exit 2',
      c.noArgs.documented === true && c.noArgs.exit === 2,
      JSON.stringify(c.noArgs),
    );
  }

  // Positive --help bound to argv with a documented exit.
  {
    const src =
      "function usage(message: string): never { console.error('usage: tool'); process.exit(0); }\n" +
      "if (process.argv.includes('--help')) usage('help');\n";
    const c = derive(src);
    add(
      'positive argv-bound --help derives a documented handler (exit 0)',
      c.help.supported === true && c.help.exit === 0,
      JSON.stringify(c.help),
    );
  }

  // ---- ADVERSE -------------------------------------------------------------

  // A guard inside a function that is never invoked is not reachable.
  {
    const src =
      VALUE_HELPER +
      USAGE_HELPER +
      "function never() { const e = argValue('--environment'); if (!e) usage('unused'); }\n";
    const c = derive(src);
    add(
      'guard inside an un-invoked function is not reachable (undocumented)',
      c.noArgs.documented === false,
      JSON.stringify(c.noArgs),
    );
  }

  // A foreign (imported) usage helper cannot be resolved ⇒ stays undocumented.
  {
    const src =
      "import { usage } from './lib/usage.js';\n" +
      VALUE_HELPER +
      "const environment = argValue('--environment');\n" +
      "if (!environment) usage('need env');\n";
    const c = derive(src);
    add(
      'foreign imported usage helper is unresolved (undocumented)',
      c.noArgs.documented === false,
      JSON.stringify(c.noArgs),
    );
  }

  // A helper that does not actually read process.argv does not bind its result.
  {
    const src =
      'function argValue(flag: string): string | undefined { return undefined; }\n' +
      USAGE_HELPER +
      "const environment = argValue('--environment');\n" +
      "if (!environment) usage('need env');\n";
    const c = derive(src);
    add(
      'non-argv helper does not bind its result to argv (undocumented)',
      c.noArgs.documented === false,
      JSON.stringify(c.noArgs),
    );
  }

  // A negated --help test is the inverse of help support.
  {
    const src =
      "function usage(message: string): never { console.error('usage: tool'); process.exit(0); }\n" +
      "if (!process.argv.includes('--help')) usage('no help');\n";
    const c = derive(src);
    add(
      'negated --help test is not help support',
      c.help.supported === false,
      JSON.stringify(c.help),
    );
  }

  // An ambiguous helper exit resolves to null (never an arbitrary integer).
  {
    const src =
      VALUE_HELPER +
      "function usage(message: string): never { console.error('usage: tool'); if (message) process.exit(2); else process.exit(3); }\n" +
      "const environment = argValue('--environment');\n" +
      "if (!environment) usage('need env');\n";
    const c = derive(src);
    add(
      'ambiguous helper exit stays unresolved (documented but exit null)',
      c.noArgs.documented === true && c.noArgs.exit === null,
      JSON.stringify(c.noArgs),
    );
  }

  // A dynamic (non-literal) exit resolves to null.
  {
    const src =
      VALUE_HELPER +
      "function usage(message: string): never { console.error('usage: tool'); process.exit(code); }\n" +
      "const environment = argValue('--environment');\n" +
      "if (!environment) usage('need env');\n";
    const c = derive(src);
    add(
      'dynamic helper exit stays unresolved (documented but exit null)',
      c.noArgs.documented === true && c.noArgs.exit === null,
      JSON.stringify(c.noArgs),
    );
  }

  // A side-effecting argv helper is not a pure binding.
  {
    const src =
      "function argValue(flag: string): string | undefined { process.argv.push('x'); const i = process.argv.indexOf(flag); return i >= 0 ? process.argv[i + 1] : undefined; }\n" +
      USAGE_HELPER +
      "const environment = argValue('--environment');\n" +
      "if (!environment) usage('need env');\n";
    const c = derive(src);
    add(
      'side-effecting argv helper is not treated as a pure binding (undocumented)',
      c.noArgs.documented === false,
      JSON.stringify(c.noArgs),
    );
  }

  // Arbitrary console output is not usage text.
  {
    const src = "if (process.argv.length < 3) {\n  console.log('starting up');\n  process.exit(2);\n}\n";
    const c = derive(src);
    add(
      'arbitrary console output is not usage text (undocumented)',
      c.noArgs.documented === false,
      JSON.stringify(c.noArgs),
    );
  }

  // An unrelated array's length is not an argv no-args test.
  {
    const src = "if (items.length < 2) {\n  console.error('usage: tool x');\n  process.exit(2);\n}\n";
    const c = derive(src);
    add(
      'unrelated array length is not an argv no-args test (undocumented)',
      c.noArgs.documented === false,
      JSON.stringify(c.noArgs),
    );
  }

  // A '--help' constant not tested against argv is not an argument test.
  {
    const src =
      "const x = '--help';\n" +
      "function usage(message: string): never { console.error('usage: tool'); process.exit(0); }\n" +
      "if (x === '--help') usage('help');\n";
    const c = derive(src);
    add(
      "a '--help' constant not bound to argv is not help support",
      c.help.supported === false,
      JSON.stringify(c.help),
    );
  }

  // ---- EXECUTION-78 ADVERSE PROBES ----------------------------------------
  // Four independently-reproduced false acceptances (root-script78-derivation-
  // probe-result.json). Each MUST fail closed without weakening the positive or
  // any older control above.

  // Probe 1: the helper READS argv but RETURNS an unrelated constant, so the
  // returned value is never absent — the `!environment` guard cannot fire.
  // A mere argv reference is NOT return-dataflow proof.
  {
    const src =
      "function argValue(flag: string): string { const i = process.argv.indexOf(flag); return 'always'; }\n" +
      USAGE_HELPER +
      "const environment = argValue('--environment');\n" +
      "if (!environment) usage('need env');\n";
    const c = derive(src);
    add(
      'exec78/1: helper reads argv but returns an unrelated constant is not a value binding (undocumented)',
      c.noArgs.documented === false,
      JSON.stringify(c.noArgs),
    );
  }

  // Probe 2: the helper returns process.argv[0] — the executable path, which is
  // ALWAYS present under no-args — so the required-value guard cannot fire. The
  // returned argv slot must be provably absent under no-args, not merely argv.
  {
    const src =
      'function argValue(flag: string): string { return process.argv[0]; }\n' +
      USAGE_HELPER +
      "const environment = argValue('--environment');\n" +
      "if (!environment) usage('need env');\n";
    const c = derive(src);
    add(
      'exec78/2: helper returning a guaranteed-present argv slot (argv[0]) is not a missing-value proof (undocumented)',
      c.noArgs.documented === false,
      JSON.stringify(c.noArgs),
    );
  }

  // Probe 3: a nested, UNREACHABLE helper named `usage` must NOT shadow the real
  // module `usage` binding (which prints unrelated output, not usage). Resolution
  // is lexical — never a global last-name match.
  {
    const src =
      "function usage(): void { console.error('unrelated output'); }\n" +
      "function unused(): void { function usage(): never { console.error('usage: tool'); process.exit(2); } }\n" +
      'const argv = process.argv.slice(2);\n' +
      'if (!argv.length) usage();\n';
    const c = derive(src);
    add(
      'exec78/3: nested unreachable helper does not shadow the real module binding (undocumented)',
      c.noArgs.documented === false,
      JSON.stringify(c.noArgs),
    );
  }

  // Probe 4: the usage branch prints usage but its only exit sits in a
  // literal-dead `if (false)` — not a guaranteed exit. It stays documented but
  // the exit is unresolved (null); the unreachable exit 2 must NOT be picked up.
  {
    const src =
      "function usage(): void { console.error('usage: tool'); if (false) process.exit(2); }\n" +
      'if (process.argv.length < 3) usage();\n';
    const c = derive(src);
    add(
      'exec78/4: exit inside a literal-dead branch is not a guaranteed exit (documented, exit null)',
      c.noArgs.documented === true && c.noArgs.exit === null,
      JSON.stringify(c.noArgs),
    );
  }

  // Probe 3 companion: a LEGITIMATE nested-reachable local call must still
  // resolve (the repair must not blanket-refuse lexical nesting).
  {
    const src =
      "function emit(): void { console.error('usage: nested tool'); }\n" +
      "function outer(): never { function usage(): never { emit(); process.exit(2); } usage(); return undefined as never; }\n" +
      VALUE_HELPER +
      "const env = argValue('--environment');\n" +
      "if (!env) outer();\n";
    const c = derive(src);
    add(
      'exec78/3b: a reachable nested local helper call still resolves (documented exit 2)',
      c.noArgs.documented === true && c.noArgs.exit === 2,
      JSON.stringify(c.noArgs),
    );
  }

  // ---- EXECUTION-83 ADVERSE PROBES ----------------------------------------
  // TWO independently-reproduced FALSE ACCEPTANCES that survived execution-78
  // (C:/dev/main/.orchestration/cleanup-20261007/root-review80-script-probe-result.json).
  // Both are value-helper returns that merely READ argv somewhere but do NOT
  // prove the returned value is ABSENT under no-args. Each MUST now fail closed
  // (undocumented) without weakening any positive or older control above.

  // Probe execution-83/1: the helper returns a bare COMPUTED index. Under
  // no-args process.argv.length - 1 === 1 (the script path) — a slot that is
  // ALWAYS present — so the returned value is defined and the required-value
  // guard cannot fire. A computed index is NOT an absence proof.
  {
    const src =
      'function argValue(flag) { return process.argv[process.argv.length - 1]; }\n' +
      USAGE_HELPER +
      "const environment = argValue('--environment');\n" +
      "if (!environment) usage('need env');\n";
    const c = derive(src);
    add(
      'exec83/1: helper returning a bare computed index (argv[argv.length-1]) is not a missing-value proof (undocumented)',
      c.noArgs.documented === false,
      JSON.stringify(c.noArgs),
    );
  }

  // Probe execution-83/2: the helper returns `process.argv[2] || 'always'` —
  // `||` supplies a DEFINED fallback, so the value is never absent and the
  // required-value guard cannot fire. A defined fallback is NOT an absence proof.
  {
    const src =
      "function argValue(flag) { return process.argv[2] || 'always'; }\n" +
      USAGE_HELPER +
      "const environment = argValue('--environment');\n" +
      "if (!environment) usage('need env');\n";
    const c = derive(src);
    add(
      'exec83/2: helper returning a defined fallback (argv[2] || constant) is not a missing-value proof (undocumented)',
      c.noArgs.documented === false,
      JSON.stringify(c.noArgs),
    );
  }

  // ---- CONTRACT1048 SOURCE-DERIVED PROBES ----------------------------------
  // Newly recognized, source-backed forms (argv destructuring; sound compound
  // required-value guards; empty-string dataflow). Each has near-miss negatives.

  // The real scripts/assert-test-summary.mjs shape: argv destructuring binds
  // slots 2/3 (absent under no-args) and `!file || !label` is definitely true.
  {
    const src =
      'const [, , file, label] = process.argv;\n' +
      'if (!file || !label) {\n' +
      "  console.error('usage: assert-test-summary.mjs <summary.json> <label>');\n" +
      '  process.exit(2);\n' +
      '}\n';
    const c = derive(src, 'assert-test-summary.mjs');
    add(
      'contract1048/pos: argv destructuring + `!a || !b` derives documented exit 2',
      c.noArgs.documented === true && c.noArgs.exit === 2 && c.noArgs.usagePrinted === true,
      JSON.stringify(c.noArgs),
    );
  }

  // AND form: both destructured slots are absent, so `!a && !b` is true.
  {
    const src =
      'const [, , file, label] = process.argv;\n' +
      'if (!file && !label) {\n' +
      "  console.error('usage: tool <a> <b>');\n" +
      '  process.exit(2);\n' +
      '}\n';
    const c = derive(src);
    add(
      'contract1048/pos: `!a && !b` (both destructured slots absent) derives documented exit 2',
      c.noArgs.documented === true && c.noArgs.exit === 2,
      JSON.stringify(c.noArgs),
    );
  }

  // Sound OR with an unknown second disjunct: the definitely-true `!file` alone
  // makes the disjunction true regardless of the other side.
  {
    const src =
      'const [, , file] = process.argv;\n' +
      'if (!file || file.length > 3) {\n' +
      "  console.error('usage: tool <a>');\n" +
      '  process.exit(3);\n' +
      '}\n';
    const c = derive(src);
    add(
      'contract1048/pos: sound OR (one definitely-true leaf) derives documented exit 3',
      c.noArgs.documented === true && c.noArgs.exit === 3,
      JSON.stringify(c.noArgs),
    );
  }

  // The real apps/api/scripts/diag-leg-readpaths.ts shape: a value argv helper,
  // an exact `?? ''` empty fallback propagated through pure .toUpperCase(), and
  // a `!pe` required-value guard.
  {
    const src =
      'function arg(name: string): string | undefined {\n' +
      '  const i = process.argv.indexOf(`--${name}`);\n' +
      '  return i >= 0 ? process.argv[i + 1] : undefined;\n' +
      '}\n' +
      'async function main(): Promise<void> {\n' +
      "  const pe = (arg('pe') ?? '').toUpperCase();\n" +
      '  if (!pe) {\n' +
      "    console.error('Usage: diag-leg-readpaths --pe <peCode>');\n" +
      '    process.exit(1);\n' +
      '  }\n' +
      '}\n' +
      'void main().catch((e) => { console.error(e); process.exit(1); });\n';
    const c = derive(src, 'diag-leg-readpaths.ts');
    add(
      "contract1048/pos: empty `?? ''` fallback through pure .toUpperCase() derives documented exit 1",
      c.noArgs.documented === true && c.noArgs.exit === 1,
      JSON.stringify(c.noArgs),
    );
  }

  // NEGATIVE: destructuring a SLICE of argv is not an exact argv slot proof.
  {
    const src =
      'const [, , a] = process.argv.slice(2);\n' +
      "if (!a) { console.error('usage: tool'); process.exit(2); }\n";
    const c = derive(src);
    add(
      'contract1048/neg: destructuring argv.slice(2) is not an exact argv slot proof (undocumented)',
      c.noArgs.documented === false,
      JSON.stringify(c.noArgs),
    );
  }

  // NEGATIVE: slot 0 is the executable — always present under no-args.
  {
    const src =
      'const [a] = process.argv;\n' +
      "if (!a) { console.error('usage: tool'); process.exit(2); }\n";
    const c = derive(src);
    add(
      'contract1048/neg: destructured slot 0 (always present) is not an absence proof (undocumented)',
      c.noArgs.documented === false,
      JSON.stringify(c.noArgs),
    );
  }

  // NEGATIVE: a rest element is an ARRAY (possibly empty) — never absent.
  {
    const src =
      'const [, , ...rest] = process.argv;\n' +
      "if (!rest) { console.error('usage: tool'); process.exit(2); }\n";
    const c = derive(src);
    add(
      'contract1048/neg: destructured rest element is an array, never absent (undocumented)',
      c.noArgs.documented === false,
      JSON.stringify(c.noArgs),
    );
  }

  // NEGATIVE: a defaulted element is DEFINED even when the slot is absent.
  {
    const src =
      "const [, , a = 'x'] = process.argv;\n" +
      "if (!a) { console.error('usage: tool'); process.exit(2); }\n";
    const c = derive(src);
    add(
      'contract1048/neg: defaulted destructured element is defined, not absent (undocumented)',
      c.noArgs.documented === false,
      JSON.stringify(c.noArgs),
    );
  }

  // NEGATIVE: sound AND — an unknown conjunct leaves the whole guard undecided.
  {
    const src =
      'const [, , file] = process.argv;\n' +
      "if (!file && file.length > 3) { console.error('usage: tool'); process.exit(2); }\n";
    const c = derive(src);
    add(
      'contract1048/neg: `!a && unknown` is undecided and not a no-args proof (undocumented)',
      c.noArgs.documented === false,
      JSON.stringify(c.noArgs),
    );
  }

  // NEGATIVE: a bare (non-negated) absent local is not a no-args guard.
  {
    const src =
      'const [, , file] = process.argv;\n' +
      "if (file) { console.error('usage: tool'); process.exit(2); }\n";
    const c = derive(src);
    add(
      'contract1048/neg: a bare absent local (no negation) is not a no-args guard (undocumented)',
      c.noArgs.documented === false,
      JSON.stringify(c.noArgs),
    );
  }

  // NEGATIVE: no `?? ''` fallback — .toUpperCase() on an absent value throws,
  // it does not yield an empty string.
  {
    const src =
      'function arg(name: string): string | undefined {\n' +
      '  const i = process.argv.indexOf(`--${name}`);\n' +
      '  return i >= 0 ? process.argv[i + 1] : undefined;\n' +
      '}\n' +
      "const pe = arg('pe').toUpperCase();\n" +
      "if (!pe) { console.error('usage: tool'); process.exit(1); }\n";
    const c = derive(src);
    add(
      "contract1048/neg: without `?? ''`, .toUpperCase() on an absent value proves nothing (undocumented)",
      c.noArgs.documented === false,
      JSON.stringify(c.noArgs),
    );
  }

  // NEGATIVE: a non-empty-preserving method breaks the empty-string propagation.
  {
    const src =
      'function arg(name: string): string | undefined {\n' +
      '  const i = process.argv.indexOf(`--${name}`);\n' +
      '  return i >= 0 ? process.argv[i + 1] : undefined;\n' +
      '}\n' +
      "const pe = (arg('pe') ?? '').concat('x');\n" +
      "if (!pe) { console.error('usage: tool'); process.exit(1); }\n";
    const c = derive(src);
    add(
      'contract1048/neg: a non-empty-preserving method breaks the empty-string chain (undocumented)',
      c.noArgs.documented === false,
      JSON.stringify(c.noArgs),
    );
  }

  // ---- CONTRACT1051 REPAIRED FALSE ACCEPTANCES + NEW ADVERSE/POSITIVE PROBES -
  // Root independently reproduced SIX false acceptances in real tiny-Node
  // execution (root-contract1051-probes-result.json). Each MUST now fail closed
  // without weakening any positive or older control above.

  const ARG =
    'function arg(name: string): string | undefined {\n' +
    '  const i = process.argv.indexOf(`--${name}`);\n' +
    '  return i >= 0 ? process.argv[i + 1] : undefined;\n' +
    '}\n';

  // Probe 1: a destructured absent slot is `undefined`, and `a === null` is
  // FALSE for undefined — the branch is NOT taken at runtime.
  {
    const src =
      'const [,,a]=process.argv;\n' +
      "if(a===null) { console.error('Usage: tool'); process.exit(2); }\n";
    const c = derive(src);
    add(
      'contract1051/neg1: `a===null` on an absent slot is false (undefined!==null) — undocumented',
      c.noArgs.documented === false,
      JSON.stringify(c.noArgs),
    );
  }

  // Probe 2: neither `a===''` nor `a===null` holds for undefined.
  {
    const src =
      'const [,,a]=process.argv;\n' +
      "if(a==='' || a===null) { console.error('Usage: tool'); process.exit(2); }\n";
    const c = derive(src);
    add(
      "contract1051/neg2: `a==='' || a===null` is false for undefined — undocumented",
      c.noArgs.documented === false,
      JSON.stringify(c.noArgs),
    );
  }

  // Probe 3: a local `process` object shadows the real global; its argv is not
  // the real process.argv.
  {
    const src =
      "function main(){const process={argv:['node','script','present'],exit(){throw Error('wrong')}};const [,,a]=process.argv;if(!a||false) { console.error('Usage: tool'); process.exit(2); }} main();\n";
    const c = derive(src);
    add(
      'contract1051/neg3: a local `process` shadow is not real process.argv — undocumented',
      c.noArgs.documented === false,
      JSON.stringify(c.noArgs),
    );
  }

  // Probe 4: a function PARAMETER `a` shadows the outer destructured absent `a`;
  // the actual guard sees the argument, not the missing slot.
  {
    const src =
      "const [,,a]=process.argv;function main(a){if(!a||false) { console.error('Usage: tool'); process.exit(2); }}main('present');\n";
    const c = derive(src);
    add(
      'contract1051/neg4: a function parameter shadows the destructured absent slot — undocumented',
      c.noArgs.documented === false,
      JSON.stringify(c.noArgs),
    );
  }

  // Probe 5: a reassigned (let) destructured slot is not provably absent.
  {
    const src =
      "let[,,a]=process.argv;a='present';if(!a||false) { console.error('Usage: tool'); process.exit(2); }\n";
    const c = derive(src);
    add(
      'contract1051/neg5: a reassigned (let) destructured slot is not provably absent — undocumented',
      c.noArgs.documented === false,
      JSON.stringify(c.noArgs),
    );
  }

  // Probe 6: `boom() || !a` — the unknown left is evaluated FIRST and throws
  // before the true disjunct, so usage is never emitted.
  {
    const src =
      "const [,,a]=process.argv;function boom(){throw Error('stop')}if(boom()||!a) { console.error('Usage: tool'); process.exit(2); }\n";
    const c = derive(src);
    add(
      'contract1051/neg6: `boom()||!a` throws before the true disjunct — undocumented',
      c.noArgs.documented === false,
      JSON.stringify(c.noArgs),
    );
  }

  // Positive: nested parenthesised guard is still recognized.
  {
    const src =
      'const [,,file,label]=process.argv;\n' +
      "if((!file)||(!label)) { console.error('Usage: tool'); process.exit(2); }\n";
    const c = derive(src);
    add(
      'contract1051/pos: nested parenthesised guard `(!file)||(!label)` derives exit 2',
      c.noArgs.documented === true && c.noArgs.exit === 2,
      JSON.stringify(c.noArgs),
    );
  }

  // Positive: exact absent equality `a == null` (loose) is TRUE for undefined.
  {
    const src =
      'const [,,a]=process.argv;\n' +
      "if(a==null) { console.error('Usage: tool'); process.exit(2); }\n";
    const c = derive(src);
    add(
      'contract1051/pos: `a == null` on an absent slot is true (loose) — exit 2',
      c.noArgs.documented === true && c.noArgs.exit === 2,
      JSON.stringify(c.noArgs),
    );
  }

  // Positive: exact absent equality `a === undefined` is TRUE.
  {
    const src =
      'const [,,a]=process.argv;\n' +
      "if(a===undefined) { console.error('Usage: tool'); process.exit(2); }\n";
    const c = derive(src);
    add(
      'contract1051/pos: `a === undefined` on an absent slot is true — exit 2',
      c.noArgs.documented === true && c.noArgs.exit === 2,
      JSON.stringify(c.noArgs),
    );
  }

  // Negative: strict empty equality on an absent slot is FALSE.
  {
    const src =
      'const [,,a]=process.argv;\n' +
      "if(a==='') { console.error('Usage: tool'); process.exit(2); }\n";
    const c = derive(src);
    add(
      "contract1051/neg: `a===''` on an absent slot is false — undocumented",
      c.noArgs.documented === false,
      JSON.stringify(c.noArgs),
    );
  }

  // Positive: another empty-preserving intrinsic (`.trim()`) keeps `?? ''`.
  {
    const src =
      ARG +
      "const pe = (arg('pe') ?? '').trim();\n" +
      "if (!pe) { console.error('Usage: tool'); process.exit(1); }\n";
    const c = derive(src);
    add(
      "contract1051/pos: empty-preserving `.trim()` on `?? ''` derives exit 1",
      c.noArgs.documented === true && c.noArgs.exit === 1,
      JSON.stringify(c.noArgs),
    );
  }

  // Negative: a side-effecting ARGUMENT to an empty-preserving method would run
  // (and may throw) before usage — refused.
  {
    const src =
      ARG +
      "function boom(){throw Error('x')}\n" +
      "const pe = (arg('pe') ?? '').toUpperCase(boom());\n" +
      "if (!pe) { console.error('Usage: tool'); process.exit(1); }\n";
    const c = derive(src);
    add(
      'contract1051/neg: `.toUpperCase(boom())` (side-effecting argument) is refused — undocumented',
      c.noArgs.documented === false,
      JSON.stringify(c.noArgs),
    );
  }

  // Negative: a defined non-empty fallback means the value is never empty.
  {
    const src =
      ARG +
      "const pe = arg('pe') ?? 'X';\n" +
      "if (!pe) { console.error('Usage: tool'); process.exit(1); }\n";
    const c = derive(src);
    add(
      "contract1051/neg: a defined non-empty `?? 'X'` fallback is not provably empty — undocumented",
      c.noArgs.documented === false,
      JSON.stringify(c.noArgs),
    );
  }

  // Negative: an unknown LEFT disjunct is evaluated first and may throw.
  {
    const src =
      'const [,,file]=process.argv;\n' +
      "function load(){throw Error('x')}\n" +
      "if (load() || !file) { console.error('Usage: tool'); process.exit(2); }\n";
    const c = derive(src);
    add(
      'contract1051/neg: `load() || !file` (unknown left disjunct) is refused — undocumented',
      c.noArgs.documented === false,
      JSON.stringify(c.noArgs),
    );
  }

  // Positive: the mirror-image safe short-circuit `!file || unknown` IS sound.
  {
    const src =
      'const [,,file]=process.argv;\n' +
      "if (!file || file.length > 3) { console.error('Usage: tool'); process.exit(2); }\n";
    const c = derive(src);
    add(
      'contract1051/pos: safe short-circuit `!file || unknown` derives exit 2',
      c.noArgs.documented === true && c.noArgs.exit === 2,
      JSON.stringify(c.noArgs),
    );
  }

  // Negative: a const destructured slot reassigned after declaration is not
  // provably absent (conservative mutation scan).
  {
    const src =
      'const [,,a]=process.argv;\n' +
      "a='present';\n" +
      "if(!a) { console.error('Usage: tool'); process.exit(2); }\n";
    const c = derive(src);
    add(
      'contract1051/neg: a destructured slot reassigned after declaration is not provably absent — undocumented',
      c.noArgs.documented === false,
      JSON.stringify(c.noArgs),
    );
  }

  // ---- CONTRACT1062 ADVERSE PROBES ----------------------------------------
  // NINE independently-reproduced FALSE ACCEPTANCES in real tiny-Node execution
  // (root-contract1061-extra-probes-result.json). Each MUST fail closed without
  // weakening any positive or older control above.

  // Probe 1: the value helper returns `null` under no-args — `a === undefined`
  // is FALSE at runtime, so the branch is never taken.
  {
    const src =
      'function arg(flag){const i=process.argv.indexOf(flag);return i>=0?process.argv[i+1]:null;}\n' +
      "const a=arg('--x');if(a===undefined||false){ console.error('Usage: tool'); process.exit(2); }\n";
    const c = derive(src);
    add(
      'contract1062/neg1: helper returning null is not `=== undefined` — undocumented',
      c.noArgs.documented === false,
      JSON.stringify(c.noArgs),
    );
  }

  // Probe 2: the value helper returns `''` under no-args — `a === undefined` is
  // still FALSE.
  {
    const src =
      "function arg(flag){const i=process.argv.indexOf(flag);return i>=0?process.argv[i+1]:'';}\n" +
      "const a=arg('--x');if(a===undefined||false){ console.error('Usage: tool'); process.exit(2); }\n";
    const c = derive(src);
    add(
      "contract1062/neg2: helper returning '' is not `=== undefined` — undocumented",
      c.noArgs.documented === false,
      JSON.stringify(c.noArgs),
    );
  }

  // Probe 3: a function PARAMETER named `arg` shadows the value helper; the call
  // binds to the parameter, not the outer argv helper.
  {
    const src =
      'function arg(flag){const i=process.argv.indexOf(flag);return i>=0?process.argv[i+1]:undefined;}\n' +
      "function main(arg){const a=(arg('--x')??'').toUpperCase();if(!a||false){ console.error('Usage: tool'); process.exit(2); }}main(()=> 'present');\n";
    const c = derive(src);
    add(
      'contract1062/neg3: parameter shadows the argv helper — undocumented',
      c.noArgs.documented === false,
      JSON.stringify(c.noArgs),
    );
  }

  // Probe 4: the guard runs BEFORE the `const [,,a]=process.argv` initializer —
  // a TDZ ReferenceError, so there is no absence fact at the guard.
  {
    const src =
      "if(!a||false){ console.error('Usage: tool'); process.exit(2); }\n" +
      'const[,,a]=process.argv;\n';
    const c = derive(src);
    add(
      'contract1062/neg4: guard before const initialization (TDZ) — undocumented',
      c.noArgs.documented === false,
      JSON.stringify(c.noArgs),
    );
  }

  // Probe 5: nested destructuring throws on an absent argv[2]; only a FLAT slot
  // is a valid absence proof.
  {
    const src =
      'const[,,[,,a]]=process.argv;\n' +
      "if(!a||false){ console.error('Usage: tool'); process.exit(2); }\n";
    const c = derive(src);
    add(
      'contract1062/neg5: nested destructuring is not a flat argv slot — undocumented',
      c.noArgs.documented === false,
      JSON.stringify(c.noArgs),
    );
  }

  // Probe 6: the source overrides String.prototype.toUpperCase, so the empty
  // string no longer preserves through it.
  {
    const src =
      'function arg(flag){const i=process.argv.indexOf(flag);return i>=0?process.argv[i+1]:undefined;}\n' +
      "String.prototype.toUpperCase=()=> 'present';const a=(arg('--x')??'').toUpperCase();if(!a||false){ console.error('Usage: tool'); process.exit(2); }\n";
    const c = derive(src);
    add(
      'contract1062/neg6: overridden String.prototype.toUpperCase breaks empty-preservation — undocumented',
      c.noArgs.documented === false,
      JSON.stringify(c.noArgs),
    );
  }

  // Probe 7: `arg(boom())` evaluates the throwing argument BEFORE the pure
  // helper, so the call is not a sound value proof.
  {
    const src =
      'function arg(flag){const i=process.argv.indexOf(flag);return i>=0?process.argv[i+1]:undefined;}\n' +
      "function boom(){throw Error('stop')}const a=(arg(boom())??'').toUpperCase();if(!a||false){ console.error('Usage: tool'); process.exit(2); }\n";
    const c = derive(src);
    add(
      'contract1062/neg7: side-effecting call argument `arg(boom())` is refused — undocumented',
      c.noArgs.documented === false,
      JSON.stringify(c.noArgs),
    );
  }

  // Probe 8: a parameter named `undefined` shadows the global literal, so
  // `a === undefined` is NOT the global-undefined check.
  {
    const src =
      'const[,,a]=process.argv;function main(undefined){if(a===undefined||false){ console.error(' +
      "'Usage: tool'); process.exit(2); }}main('present');\n";
    const c = derive(src);
    add(
      'contract1062/neg8: shadowed `undefined` identifier is not the global literal — undocumented',
      c.noArgs.documented === false,
      JSON.stringify(c.noArgs),
    );
  }

  // Probe 9: process.argv is mutated BEFORE the destructuring, so the no-args
  // `argv.length === 2` premise no longer holds.
  {
    const src =
      "process.argv.push('present');const[,,a]=process.argv;if(!a||false){ console.error('Usage: tool'); process.exit(2); }\n";
    const c = derive(src);
    add(
      'contract1062/neg9: source argv mutation before destructuring refuses the absence proof — undocumented',
      c.noArgs.documented === false,
      JSON.stringify(c.noArgs),
    );
  }

  // Positive companion: a FLAT slot with the exact-undefined sentinel still
  // derives exit 2 (the sentinel model must not over-refuse).
  {
    const src =
      'const[,,a]=process.argv;if(a===undefined){ console.error(' +
      "'Usage: tool'); process.exit(2); }\n";
    const c = derive(src);
    add(
      'contract1062/pos: flat slot `a === undefined` still derives exit 2',
      c.noArgs.documented === true && c.noArgs.exit === 2,
      JSON.stringify(c.noArgs),
    );
  }

  // ---- CONTRACT1076 REGRESSION CONTROLS -----------------------------------
  // SIX further independently-reproduced FALSE ACCEPTANCES in real tiny-Node
  // execution (root-contract1074-order-probes-result.json). Each MUST fail closed
  // (undocumented) without weakening any positive or older control above. These
  // exercise the repaired PROOF MODEL (reachability, cross-scope capture, the
  // bounded helper grammar, argument-bound index proofs, broad prototype
  // dirtying) — NOT a full native gate (the separate actual Usage/exit/audit
  // checks remain mandatory).

  // Case 1: `main()` runs BEFORE the top-level `const [,,a]` initializer, so the
  // guard inside `main` reads `a` in its TDZ. Declaration START before reference
  // text does not prove runtime initialization across a function boundary.
  {
    const src =
      "main();const[,,a]=process.argv;function main(){if(!a||false){console.error('Usage: tool');process.exit(2);}}";
    const c = derive(src);
    add(
      'contract1076/1: guard reads a captured argv local in TDZ across a function boundary — undocumented',
      c.noArgs.documented === false,
      JSON.stringify(c.noArgs),
    );
  }

  // Case 2: the guard sits AFTER an unconditional `return`, so it is UNREACHABLE.
  {
    const src =
      "function main(){return;const[,,a]=process.argv;if(!a||false){console.error('Usage: tool');process.exit(2);}}main();";
    const c = derive(src);
    add(
      'contract1076/2: guard after an unconditional return is unreachable — undocumented',
      c.noArgs.documented === false,
      JSON.stringify(c.noArgs),
    );
  }

  // Case 3: a whitelisted method NAME does not prove a pure helper — `x.trim()`
  // throws on the `undefined` receiver before the returned argv slot is reached.
  {
    const src =
      "function arg(flag){const x=undefined;x.trim();return process.argv[2];}const a=arg('--x');if(!a||false){console.error('Usage: tool');process.exit(2);}";
    const c = derive(src);
    add(
      'contract1076/3: whitelisted method on an undefined receiver breaks helper purity — undocumented',
      c.noArgs.documented === false,
      JSON.stringify(c.noArgs),
    );
  }

  // Case 4: the helper's ACTUAL argument is the executable path (argv[0]); the
  // indexOf finds it and returns argv[1], which is PRESENT. A guarded indexOf
  // proof does not imply absence for every simple literal.
  {
    const src =
      'function arg(flag){const i=process.argv.indexOf(flag);return i>=0?process.argv[i+1]:undefined;}\n' +
      'const a=arg("C:\\\\Program Files\\\\nodejs\\\\node.exe");if(!a||false){console.error(\'Usage: tool\');process.exit(2);}\n';
    const c = derive(src);
    add(
      'contract1076/4: helper argument equal to the executable path is present, not absent — undocumented',
      c.noArgs.documented === false,
      JSON.stringify(c.noArgs),
    );
  }

  // Case 5: Object.assign(String.prototype, {...}) invalidates the modelled
  // empty-preserving intrinsic just as a direct assignment does.
  {
    const src =
      'function arg(flag){const i=process.argv.indexOf(flag);return i>=0?process.argv[i+1]:undefined;}\n' +
      "Object.assign(String.prototype,{toUpperCase(){return 'present'}});const a=(arg('--x')??'').toUpperCase();if(!a||false){console.error('Usage: tool');process.exit(2);}\n";
    const c = derive(src);
    add(
      'contract1076/5: Object.assign over String.prototype disables empty-preservation — undocumented',
      c.noArgs.documented === false,
      JSON.stringify(c.noArgs),
    );
  }

  // Case 6: the guard sits AFTER an unconditional `throw`, so it is UNREACHABLE.
  {
    const src =
      "throw Error('stop');const[,,a]=process.argv;if(!a||false){console.error('Usage: tool');process.exit(2);}";
    const c = derive(src);
    add(
      'contract1076/6: guard after an unconditional throw is unreachable — undocumented',
      c.noArgs.documented === false,
      JSON.stringify(c.noArgs),
    );
  }

  // ---- CONFIGURATION-CONDITIONED (missing-DATABASE_URL smoke context) ------
  // The ONE named, immutable smoke context adds narrowly source-derived
  // recognition of the main-owned inline `!process.env.DATABASE_URL` guard.
  // Generic `deriveContract(src, rel)` MUST stay conservative (no context), so
  // every conditional-positive below is paired with a generic-negative.

  const DB_GUARD =
    'async function main() {\n' +
    '  if (!process.env.DATABASE_URL) {\n' +
    "    console.error('Usage: tool requires DATABASE_URL');\n" +
    '    process.exit(2);\n' +
    '  }\n' +
    '}\n' +
    'void main().catch(() => process.exit(1));\n';

  // Immutability of the shared context constant.
  {
    const frozen =
      Object.isFrozen(MISSING_DATABASE_URL_SMOKE_CONTEXT) === true &&
      typeof MISSING_DATABASE_URL_SMOKE_CONTEXT.id === 'string';
    add('configguard/pos: the named smoke-context constant is a frozen, identity-stable object', frozen, JSON.stringify(MISSING_DATABASE_URL_SMOKE_CONTEXT));
  }

  // Conditional-positive: under the smoke context the inline env guard is a
  // documented no-args branch with the definite exit 2.
  {
    const c = deriveSmoke(DB_GUARD);
    add(
      'configguard/pos: inline `!process.env.DATABASE_URL` + inline Usage + exit 2 derives documented exit 2 (smoke context)',
      c.noArgs.documented === true && c.noArgs.exit === 2 && c.noArgs.conditioned === 'missing-database-url',
      JSON.stringify(c.noArgs),
    );
  }
  // Generic-negative: the SAME source has NO documented no-args branch without
  // the named context (the default stays conservative).
  {
    const c = derive(DB_GUARD);
    add(
      'configguard/neg: the env-only guard is NOT recognized by the generic deriver (conservative default)',
      c.noArgs.documented === false && c.noArgs.exit === null,
      JSON.stringify(c.noArgs),
    );
  }
  // Conditional-positive for the `== null` / `=== undefined` forms.
  {
    const eq = 'async function main() { if (process.env.DATABASE_URL == null) { console.error(\'Usage: tool\'); process.exit(3); } }\nvoid main();\n';
    const c = deriveSmoke(eq);
    add('configguard/pos: `process.env.DATABASE_URL == null` derives documented exit 3 (smoke context)', c.noArgs.documented === true && c.noArgs.exit === 3, JSON.stringify(c.noArgs));
  }
  // The smoke context does NOT override an existing argv-based documented branch.
  {
    const both =
      "const [, , file] = process.argv;\n" +
      "if (!file) { console.error('Usage: tool <file>'); process.exit(4); }\n" +
      DB_GUARD;
    const c = deriveSmoke(both);
    add('configguard/pos: a preexisting argv no-args branch is preserved (env guard does not override configured behavior)', c.noArgs.documented === true && c.noArgs.exit === 4, JSON.stringify(c.noArgs));
  }

  // ---- CONFIGURATION-CONDITIONED ADVERSARIAL (all MUST stay undocumented) ---
  const advSmoke = (name, body, tail = 'void main().catch(() => process.exit(1));\n') => {
    const src = 'async function main() {\n' + body + '}\n' + tail;
    const c = deriveSmoke(src);
    add(name, c.noArgs.documented === false, JSON.stringify(c.noArgs));
  };
  advSmoke('configguard/neg: a dynamic (non-literal) exit is refused', '  if (!process.env.DATABASE_URL) { console.error(\'Usage: tool\'); process.exit(code); }\n');
  advSmoke('configguard/neg: an exit inside a literal-dead branch is refused', '  if (!process.env.DATABASE_URL) { console.error(\'Usage: tool\'); if (false) process.exit(2); }\n');
  advSmoke('configguard/neg: an arbitrary other env var is refused', '  if (!process.env.OTHER_URL) { console.error(\'Usage: tool\'); process.exit(2); }\n');
  advSmoke('configguard/neg: a presence test (`if (process.env.DATABASE_URL)`) is refused', '  if (process.env.DATABASE_URL) { console.error(\'Usage: tool\'); process.exit(2); }\n');
  advSmoke('configguard/neg: `=== null` is false for an absent (undefined) value and is refused', '  if (process.env.DATABASE_URL === null) { console.error(\'Usage: tool\'); process.exit(2); }\n');
  advSmoke('configguard/neg: usage without a definite integer exit is refused', '  if (!process.env.DATABASE_URL) { console.error(\'Usage: tool\'); }\n');
  advSmoke('configguard/neg: usage through a local helper is refused (inline only)', '  function usage() { console.error(\'Usage: tool\'); process.exit(2); }\n  if (!process.env.DATABASE_URL) { usage(); }\n');
  // A guard after an unconditional abrupt statement is unreachable.
  advSmoke('configguard/neg: a guard after an unconditional return is unreachable', '  return;\n  if (!process.env.DATABASE_URL) { console.error(\'Usage: tool\'); process.exit(2); }\n');
  // An optional-chained env access is refused.
  advSmoke('configguard/neg: an optional-chained `process.env?.DATABASE_URL` access is refused', '  if (!process.env?.DATABASE_URL) { console.error(\'Usage: tool\'); process.exit(2); }\n');

  // ---- ROOT-REVIEW1237: ELEVEN reproduced FALSE ACCEPTANCES (smoke context) --
  // Each previously credited a bogus direct-invocation boundary; under the ONE
  // named smoke context the inline guard must NOT be recognized as reached.
  {
    const GUARD =
      "if (!process.env.DATABASE_URL) { console.error('Usage: fixture requires database configuration'); process.exit(2); }";
    const mainOnly = `async function main(){${GUARD}}`;
    const neg1237 = (name, src) => {
      const c = deriveSmoke(src, 'fixture.ts');
      add(name, c.noArgs.documented === false, JSON.stringify(c.noArgs));
    };
    neg1237(
      'root1237/1(contract): an IIFE whose earlier unknown-conditioned return may exit is not a definite later return',
      `${mainOnly}const direct=(()=>{if(unknownCondition)return false;return require.main===module;})();if(direct)void main();`,
    );
    neg1237(
      'root1237/2(contract): a regex optional group is NOT dropped — /fixture(\\.wrong)?$/ does not match fixture.ts',
      mainOnly + 'if(/fixture(\\.wrong)?$/.test(process.argv[1]))void main();',
    );
    neg1237(
      'root1237/3(contract): `.endsWith(<stem>)` is not a suffix of the invoked path',
      `${mainOnly}if(process.argv[1].endsWith('fixture'))void main();`,
    );
    neg1237(
      'root1237/4(contract): `.startsWith(<basename>)` is not a provable absolute-path prefix',
      `${mainOnly}if(process.argv[1].startsWith('fixture.ts'))void main();`,
    );
    neg1237(
      'root1237/5(contract): an argv[1] alias reassigned to an unrelated path is not argv[1]',
      `${mainOnly}let invoked=process.argv[1];invoked='other.ts';if(invoked.endsWith('fixture.ts'))void main();`,
    );
    neg1237(
      'root1237/6(contract): a logical assignment (`&&=`) to a direct alias changes its truth',
      `${mainOnly}let direct=require.main===module;direct&&=false;if(direct)void main();`,
    );
    neg1237(
      'root1237/6b(contract): an (illegal, runtime-throwing) const assignment is not a successful proof',
      `${mainOnly}const direct=require.main===module;direct=false;if(direct)void main();`,
    );
    neg1237(
      'root1237/7(contract): a possibly-throwing call before an IIFE return makes the return not definite',
      `${mainOnly}const direct=(()=>{unknownOperation();return require.main===module;})();if(direct)void main();`,
    );
    neg1237(
      'root1237/8(contract): a `finally{return false}` overrides the direct return',
      `${mainOnly}const direct=(()=>{try{return require.main===module;}finally{return false;}})();if(direct)void main();`,
    );
    neg1237(
      'root1237/9(contract): an unknown try operation can route into `catch{return false}`',
      `${mainOnly}const direct=(()=>{try{unknownOperation();return require.main===module;}catch{return false;}})();if(direct)void main();`,
    );
    neg1237(
      'root1237/10(contract): `path.resolve(argv1, <extra>)` changes the basename',
      "import * as path from 'node:path';" + mainOnly + "if(path.resolve(process.argv[1],'other.ts').endsWith('fixture.ts'))void main();",
    );
    neg1237(
      'root1237/11(contract): `import {dirname as path}` is not the `node:path` namespace — `path.resolve` is refused',
      "import {dirname as path} from 'node:path';" + mainOnly + "if(path.resolve(process.argv[1]).endsWith('fixture.ts'))void main();",
    );
  }

  return checks;
}

function runControls() {
  const checks = contractControls();
  const failed = checks.filter((c) => !c.ok);
  return {
    module: 'contract-controls',
    checks,
    passed: checks.length - failed.length,
    total: checks.length,
    ok: failed.length === 0,
  };
}

export { runControls as runContractControls };

if (process.argv[1]?.endsWith('contract-controls.mjs')) {
  const r = runControls();
  process.stdout.write(JSON.stringify(r, null, 2) + '\n');
  process.exitCode = r.ok ? 0 : 1;
}
