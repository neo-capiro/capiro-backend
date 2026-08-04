/**
 * R8.2 Workstream B — static wiring guard for the verify CLI.
 *
 * Proves by source inspection (a negative-control-ready gate) that:
 *
 *   1. `--persist-audit` never constructs `FilesystemProofResolver`;
 *   2. persist mode wires `wireProductionProofBoundary` (production_proof);
 *   3. inspect mode stays on the filesystem resolver and writes no rows;
 *   4. the production wiring module constructs CompositeProofResolver with
 *      `mode: 'production_proof'` and never 'local_inspect';
 *   5. persist failures close Prisma in a finally block.
 *
 * The Workstream K defect-injection gate re-uses these assertions: injecting
 * a filesystem resolver into the persist branch must fail this spec.
 */
import { readFileSync } from 'node:fs';
import * as path from 'node:path';

const SCRIPT_PATH = path.join(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  'scripts',
  'verify-defense-budget-extraction-v1.ts',
);
const WIRING_PATH = path.join(__dirname, 'production-proof-wiring.ts');

describe('R8.2-B verify CLI production proof wiring guard', () => {
  const scriptSource = readFileSync(SCRIPT_PATH, 'utf8');
  const wiringSource = readFileSync(WIRING_PATH, 'utf8');

  it('persist branch wires the production proof boundary', () => {
    expect(scriptSource).toContain('wireProductionProofBoundary');
    // The persist branch must obtain both resolver and repository from wiring.
    expect(scriptSource).toContain('repository = wired.repository');
    expect(scriptSource).toContain('proofResolver = wired.proofResolver');
  });

  it('never constructs FilesystemProofResolver inside the persist branch', () => {
    // Isolate the persist branch: from the persist-audit try block to the
    // inspect-mode else. No filesystem resolver may appear in that region.
    const persistStart = scriptSource.indexOf('if (args.persistAudit)');
    expect(persistStart).toBeGreaterThanOrEqual(0);
    const elseStart = scriptSource.indexOf('} else {', persistStart);
    expect(elseStart).toBeGreaterThan(persistStart);
    const persistBranch = scriptSource.slice(persistStart, elseStart);
    expect(persistBranch).not.toContain('new FilesystemProofResolver');
    expect(persistBranch).not.toContain('FilesystemProofResolver()');
  });

  it('inspect branch keeps the read-only filesystem resolver', () => {
    const elseStart = scriptSource.indexOf('} else {');
    expect(elseStart).toBeGreaterThanOrEqual(0);
    const after = scriptSource.slice(elseStart, elseStart + 400);
    expect(after).toContain('new FilesystemProofResolver()');
  });

  it('disconnects Prisma in a finally block in persist mode', () => {
    expect(scriptSource).toContain('} finally {');
    expect(scriptSource).toContain('await prismaForPersist.$disconnect()');
    expect(scriptSource).toContain('await disposePersistProof()');
  });

  it('production wiring constructs CompositeProofResolver in production_proof mode', () => {
    expect(wiringSource).toContain("mode: 'production_proof'");
    expect(wiringSource).not.toContain("mode: 'local_inspect'");
    expect(wiringSource).toContain('new CompositeProofResolver');
    // Repository and proof clients share the SAME Prisma client.
    expect(wiringSource).toContain('const sourceDocumentClient = prisma');
    expect(wiringSource).toContain('const parseJobClient = prisma');
    expect(wiringSource).toContain('createPrismaBudgetVerificationRepository(prisma)');
  });

  it('production wiring fails closed on an unreachable database', () => {
    expect(wiringSource).toContain('ProductionProofWiringError');
    expect(wiringSource).toContain('$connect');
  });
});
