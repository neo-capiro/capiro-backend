import * as fs from 'node:fs';
import * as path from 'node:path';

const NON_RDTE_ROOT = __dirname;
const API_ROOT = path.resolve(NON_RDTE_ROOT, '..', '..', '..');
const SCRIPTS_ROOT = path.join(API_ROOT, 'scripts');
const INTERNAL_PLANNER_FILE = 'non-rdte-projection-planner-v1.ts';
const PROOF_BOUND_WRAPPER_FILE = 'non-rdte-proof-bound-projection-planner-v1.ts';

function productionTsFiles(root: string): string[] {
  const files: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts')) {
        files.push(fullPath);
      }
    }
  };
  walk(root);
  return files.sort();
}

function stripStringLiterals(source: string): string {
  return source.replace(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g, "''");
}

describe('Phase 5 projection import boundary', () => {
  it('only the proof-bound wrapper imports the internal pure planner', () => {
    const violations = productionTsFiles(NON_RDTE_ROOT)
      .filter((file) => !file.endsWith(INTERNAL_PLANNER_FILE))
      .filter((file) => !file.endsWith(PROOF_BOUND_WRAPPER_FILE))
      .filter((file) => fs.readFileSync(file, 'utf8').includes('non-rdte-projection-planner-v1'))
      .map((file) => path.relative(API_ROOT, file));
    expect(violations).toEqual([]);
  });

  it('operator scripts never import or invoke the internal planner directly', () => {
    const violations = productionTsFiles(SCRIPTS_ROOT)
      .filter((file) => {
        const raw = fs.readFileSync(file, 'utf8');
        /* A value import can reach the planner at runtime. `import type` is
         * erased by the compiler and cannot invoke anything, so re-using a type
         * from that module is not a boundary breach. */
        const valueImportsInternalPlanner =
          /\bimport\s+(?!type\b)[\w$*{},\s]*?\s+from\s+['"][^'"]*non-rdte-projection-planner-v1[^'"]*['"]/.test(
            raw,
          );
        /* Negative-control scripts legitimately carry the banned identifiers as
         * mutation payload inside string literals; only real code counts. */
        const code = stripStringLiterals(raw);
        return (
          valueImportsInternalPlanner ||
          /\bplanNonRdteCanonicalProjection\s*\(/.test(code) ||
          /\ballowedReviewedAcceptances\b/.test(code)
        );
      })
      .map((file) => path.relative(API_ROOT, file));
    expect(violations).toEqual([]);
  });
});
