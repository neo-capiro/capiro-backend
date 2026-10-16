/** Explicit code-qualification scope. Parsing performs no I/O or dispatch. */
export function outreachCodeScope(args) {
  if (!Array.isArray(args) || args.filter(arg => arg === '--run').length !== 1 ||
      args.some(arg => !['--run', '--backend-only'].includes(arg)) ||
      args.filter(arg => arg === '--backend-only').length > 1) {
    throw new Error('Use exactly one --run and at most one --backend-only');
  }
  return args.includes('--backend-only') ? 'backend-only' : 'full';
}
