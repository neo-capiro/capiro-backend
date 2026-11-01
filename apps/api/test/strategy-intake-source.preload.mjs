// Resolve the real browser-safe shared source for existing source-only Node suites.
// This does not build a package or substitute a validator.
import { registerHooks } from 'node:module';
const entry = new URL('../../../packages/shared/src/strategy-intake.ts', import.meta.url).href;
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === '@capiro/shared/strategy-intake') return nextResolve(entry, context);
  return nextResolve(specifier, context);
} });
