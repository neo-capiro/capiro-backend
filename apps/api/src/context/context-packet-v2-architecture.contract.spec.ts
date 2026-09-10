import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const API_ROOT = process.cwd();
const REPO_ROOT = join(API_ROOT, '../..');
const servicePath = join(API_ROOT, 'src/context/context-packet-v2.service.ts');
const modulePath = join(API_ROOT, 'src/context/context.module.ts');
const contractPath = join(REPO_ROOT, 'packages/meriv2-core/src/context/coverage-aware-packet.ts');
const migrationPath = join(
  API_ROOT,
  'prisma/migrations/20260817233500_context_packet_retrieval_context/migration.sql',
);

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

describe('Knowledge Plane Phase 17 architecture contract', () => {
  test('extends the existing ContextPacket V2 instead of creating a parallel packet architecture', () => {
    const contract = read(contractPath);

    expect(contract).toContain(
      'export interface CoverageAwareContextPacketV2 extends CompiledContextPacketV2',
    );
    expect(contract).toContain('resolvedEntities');
    expect(contract).toContain('subjectScope');
    expect(contract).toContain('coverageManifest');
    expect(contract).toContain('sourceHealth');
    expect(contract).toContain('sourceFreshness');
    expect(contract).toContain('retrievalCompleteness');
    expect(contract).toContain('retrievalStopReason');
    expect(contract).not.toContain('ContextPacketV3');
  });

  test('persists Phase 17 metadata on the existing context_packet row only', () => {
    const migration = read(migrationPath);
    const service = read(servicePath);

    expect(migration).toContain('ALTER TABLE "context_packet"');
    expect(migration).toContain('retrieval_context_jsonb');
    expect(migration).not.toMatch(/CREATE\s+TABLE/i);
    expect(migration).not.toMatch(/CREATE\s+EXTENSION/i);
    expect(service).toContain('UPDATE context_packet');
    expect(service).toContain('packet_hash = ${packet.traceHash}');
  });

  test('keeps evidence references/provenance but never persists raw retrieval payload bodies', () => {
    const service = read(servicePath);

    expect(service).toContain('evidence_jsonb');
    expect(service).toContain('record.provenance');
    expect(service).not.toContain('record.payload');
    expect(service).not.toContain('record.entityRef.metadata');
  });

  test('keeps requested domains auditable when retrieval was planned but returned no response', () => {
    const service = read(servicePath);

    expect(service).toContain('missingRetrievalCoverageManifest');
    expect(service).toContain("stopReason: 'retrieval_response_missing'");
    expect(service).toContain("sourceStatus: 'unavailable'");
  });

  test('keeps the shared Context Plane boundary and does not cut Meri or Workspace over in Phase 17', () => {
    const service = read(servicePath);
    const module = read(modulePath);

    expect(module).toContain('ContextPacketV2Service');
    expect(module).toContain('ContextResolverService');
    expect(module).toContain('ContextLayerService');
    expect(module).toContain('ContextCompilerService');
    expect(service).not.toContain('MeriService');
    expect(service).not.toContain('WorkspaceService');
    expect(service).not.toContain('Anthropic');
    expect(service).not.toContain('OpenAI');
    expect(service).not.toContain('NVIDIA');
  });

  test('does not use record count as completeness proof', () => {
    const contract = read(contractPath);
    const assessmentBody = contract.slice(
      contract.indexOf('export function assessContextPacketCoverage'),
      contract.indexOf('export function compileCoverageAwareContextPacket'),
    );

    expect(assessmentBody).not.toContain('recordsReturned === 0');
    expect(assessmentBody).not.toContain('recordsReturned > 0');
    expect(assessmentBody).toContain('coverage.complete');
    expect(assessmentBody).toContain('coverage.paginationComplete');
    expect(assessmentBody).toContain("source.sourceStatus !== 'healthy'");
    expect(assessmentBody).toContain('source.coverageComplete');
  });
});
