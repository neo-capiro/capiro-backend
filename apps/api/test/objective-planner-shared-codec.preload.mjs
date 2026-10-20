// Existing native source/data-URL suites must resolve the real newly extracted
// shared subpath while reusing the read-only installed dependency tree. This
// maps only that subpath and its two emitted .js siblings to actual source.
import { registerHooks } from 'node:module';
const base = new URL('../../../packages/shared/src/', import.meta.url);
const entry = new URL('objective-planner-owner-codec.ts', base).href;
const siblings = new Set(['objective-planner-materialization.js', 'objective-planner-application.js']);
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === '@capiro/shared/objective-planner-owner-codec') return nextResolve(entry, context);
  if (context.parentURL === entry && siblings.has(specifier.replace(/^\.\//, '')))
    return nextResolve(new URL(specifier.replace(/\.js$/, '.ts'), base).href, context);
  return nextResolve(specifier, context);
} });
