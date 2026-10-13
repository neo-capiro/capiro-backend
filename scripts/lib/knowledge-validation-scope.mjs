/** Pure explicit-scope parsing. Legacy invocations keep their original parser. */
export function knowledgeValidationScope(args) {
  const flags = ['--backend-only', '--frontend-only'];
  // Misspelled casing, padding or assignments of the new scope names must
  // refuse, rather than accidentally dispatching the legacy native plan.
  const requestsScope = args.some((arg) => typeof arg === 'string' &&
    /^--(?:backend|frontend|scope)/i.test(arg.trim()));
  if (!requestsScope) return null;
  let flag;
  let base = 'origin/main';
  let skipTests = false;
  let hasBase = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (flags.includes(arg)) {
      if (flag) throw new Error('Choose exactly one Knowledge Plane scope');
      flag = arg;
    } else if (arg === '--base') {
      if (hasBase || typeof args[i + 1] !== 'string' || !args[i + 1] ||
          !/^[A-Za-z0-9._/@^~-]+$/.test(args[i + 1]) || args[i + 1].startsWith('-')) {
        throw new Error('Scoped --base requires one nonempty Git ref');
      }
      base = args[++i];
      hasBase = true;
    } else if (arg === '--skip-tests') {
      if (skipTests) throw new Error('Duplicate --skip-tests');
      skipTests = true;
    } else {
      throw new Error(`Unknown scoped Knowledge Plane argument: ${arg}`);
    }
  }
  return { flag, scope: flag === '--backend-only' ? 'backend' : 'frontend', base, skipTests };
}
