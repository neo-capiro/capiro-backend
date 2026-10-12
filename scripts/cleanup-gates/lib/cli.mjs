/**
 * Strict CLI argument parsing for the CleanUp1 gate drivers.
 *
 * The review found that the scanners/gate silently ignored unknown options
 * (`--help` even started a real scan) and would run an expensive full gate on a
 * typo. This module makes every driver fail fast (exit 2) on an unknown option
 * or a missing value, and guards `--base` against shell interpolation by
 * validating it against a ref-safe character class before it is ever used.
 */

export class UsageError extends Error {}

/** A git ref/rev is only ever [A-Za-z0-9._/@^~-]; anything else is rejected. */
export const REF_RE = /^[A-Za-z0-9._/@^~-]+$/;

export function guardRef(value, { name = '--base' } = {}) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new UsageError(`${name} requires a value`);
  }
  // A leading '-' would be parsed by git as an option (e.g. `--output=…`) even
  // though we always spawn via argv; reject it outright.
  if (value.startsWith('-')) {
    throw new UsageError(`${name} must not begin with '-': ${JSON.stringify(value)}`);
  }
  if (!REF_RE.test(value)) {
    throw new UsageError(`${name} is not a safe git ref: ${JSON.stringify(value)} (allowed: A-Za-z0-9._/@^~-)`);
  }
  return value;
}

/**
 * Parse argv against a declarative spec.
 *
 * spec = {
 *   phase:  { flag: 'phase',  type: 'string' | 'csv' | 'flag', default?: any, required?: bool, choices?: string[] },
 *   ...
 * }
 *
 * Supports both `--flag value` and `--flag=value`. A `flag` type takes no value.
 * Unknown options, stray positionals, missing values, and invalid choices all
 * throw UsageError.
 */
export function parseArgs(argv, spec) {
  const out = {};
  const byFlag = new Map();
  for (const [key, s] of Object.entries(spec)) {
    byFlag.set(`--${s.flag || key}`, key);
    if (Object.prototype.hasOwnProperty.call(s, 'default')) out[key] = s.default;
  }

  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--help' || a === '-h') return { help: true };
    if (!a.startsWith('--')) throw new UsageError(`unexpected positional argument: ${JSON.stringify(a)}`);
    let name = a;
    let inline = null;
    const eq = a.indexOf('=');
    if (eq >= 0) {
      name = a.slice(0, eq);
      inline = a.slice(eq + 1);
    }
    const key = byFlag.get(name);
    if (!key) throw new UsageError(`unknown option: ${name}`);
    const s = spec[key];
    if (s.type === 'flag') {
      if (inline !== null) throw new UsageError(`${name} does not take a value`);
      out[key] = true;
      continue;
    }
    let val = inline;
    if (val === null) {
      val = argv[i + 1];
      if (val === undefined || val === '' || val.startsWith('--')) {
        throw new UsageError(`option ${name} requires a value`);
      }
      i += 1;
    }
    if (s.type === 'csv') out[key] = val.split(',').map((x) => x.trim()).filter(Boolean);
    else out[key] = val;
  }

  for (const [key, s] of Object.entries(spec)) {
    if (s.required && (out[key] === undefined || out[key] === null)) {
      throw new UsageError(`missing required option --${s.flag || key}`);
    }
    if (s.choices && out[key] !== undefined && !s.choices.includes(out[key])) {
      throw new UsageError(`--${s.flag || key} must be one of ${s.choices.join('|')} (got ${JSON.stringify(out[key])})`);
    }
  }
  return out;
}

/**
 * Wrap a driver's main so any UsageError prints the usage line and exits 2 —
 * never falling through to an expensive run.
 */
export function withUsage(fn, usageLine) {
  return () => {
    try {
      fn();
    } catch (err) {
      if (err instanceof UsageError) {
        process.stderr.write(`error: ${err.message}\n`);
        if (usageLine) process.stderr.write(`${usageLine}\n`);
        process.exit(2);
      }
      throw err;
    }
  };
}

function verificationBase(usage, parse, argv) {
  let base;
  withUsage(() => {
    const options = parse(argv);
    if (options.help) {
      process.stdout.write(`${usage}\n`);
      process.exit(0);
    }
    base = options.base;
    if (argv.length === 0) process.stderr.write(`${usage}\n`);
  }, usage)();
  return base;
}

/** Keep the guards' no-argument verification, with explicit help/ref parsing. */
export function architectureGuardBase(scriptName, argv = process.argv.slice(2)) {
  const usage = `Usage: node scripts/${scriptName}.mjs [base-ref] (default: origin/main)`;
  return verificationBase(usage, (args) => {
    if (args.length > 1) throw new UsageError('expected at most one base-ref');
    if (args[0] === '--help' || args[0] === '-h') return { help: true };
    return { base: guardRef(args[0] ?? 'origin/main', { name: 'base-ref' }) };
  }, argv);
}

/** Migration guards use a named base and retain Git's revision syntax. */
export function namedGuardBase(scriptName, argv = process.argv.slice(2)) {
  const usage = `Usage: node scripts/${scriptName}.mjs [--base <ref>] (default: origin/main)`;
  return verificationBase(usage, (args) => {
    const options = parseArgs(args, { base: { type: 'string', default: 'origin/main' } });
    if (!options.help && (!options.base || options.base.startsWith('-') || /[\0\r\n]/.test(options.base))) {
      throw new UsageError('invalid base ref');
    }
    return options;
  }, argv);
}
