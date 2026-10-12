/**
 * Minimal strict argument parser for the test-proof adapters.
 *
 * Mirrors scripts/cleanup-gates/lib/cli.mjs so the adapters fail fast on an
 * unknown option or a missing value (the review found the old adapters silently
 * ignored unknown flags). Kept local so scripts/test-proof stays self-contained
 * and dependency-free.
 */

export class UsageError extends Error {}

export const REF_RE = /^[A-Za-z0-9._/@^~-]+$/;

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
      if (val === undefined || val === '' || val.startsWith('--')) throw new UsageError(`option ${name} requires a value`);
      i += 1;
    }
    if (s.type === 'csv') out[key] = val.split(',').map((x) => x.trim()).filter(Boolean);
    else out[key] = val;
  }
  for (const [key, s] of Object.entries(spec)) {
    if (s.required && (out[key] === undefined || out[key] === null)) throw new UsageError(`missing required option --${s.flag || key}`);
    if (s.choices && out[key] !== undefined && !s.choices.includes(out[key])) {
      throw new UsageError(`--${s.flag || key} must be one of ${s.choices.join('|')} (got ${JSON.stringify(out[key])})`);
    }
  }
  return out;
}

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
