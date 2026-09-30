import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const API_ROOT = process.cwd();
const REPO_ROOT = join(API_ROOT, '../..');
const read = (path: string) => readFileSync(path, 'utf8');

describe('Knowledge Plane Phase 22 LegiWatch architecture contract', () => {
  test('LegiWatch uses the single shared Context Plane and owns no retrieval implementation', () => {
    const service = read(join(API_ROOT, 'src/intelligence/alert-memo/legiwatch-context-plane.service.ts'));

    expect(service).toContain('ContextPlaneGatewayService');
    expect(service).toContain('this.contextPlane.requestContext');
    expect(service).toContain("operationId: 'legiwatch.generate-report'");
    expect(service).toContain("surface: 'legiwatch'");
    expect(service).toContain("surface: 'memo'");
    expect(service).toContain('currentPhase: PHASE_22');
    expect(service).toContain(
      "layers: ['firm-identity', 'firm-playbook', 'client-steering', 'client-people']",
    );
    expect(service).not.toContain('RetrievalV2Service');
    expect(service).not.toContain('ContextCompilerService');
    expect(service).not.toContain('Embedding');
    expect(service).not.toContain('vectorStore');
    expect(service).not.toContain('pgvector');
  });

  test('the ethical-wall decision comes from the actor-scoped envelope, never a literal grant', () => {
    const service = read(join(API_ROOT, 'src/intelligence/alert-memo/legiwatch-context-plane.service.ts'));

    expect(service).not.toMatch(/ethicalWallAllowed\s*:\s*true\b/);
    expect(service).toContain(
      'ethicalWallAllowed: security.authorizedClientIds.includes(input.clientId)',
    );
  });

  test('Context Plane retrieval is wired private client/history context, never the legislative source of truth', () => {
    const service = read(join(API_ROOT, 'src/intelligence/alert-memo/legiwatch-context-plane.service.ts'));
    const retrievalModule = read(join(API_ROOT, 'src/retrieval/retrieval.module.ts'));

    // These are backed by the two adapters actually registered in RetrievalModule.
    for (const domain of [
      "'clients'",
      "'contacts'",
      "'meetings'",
      "'tasks'",
      "'outreach'",
      "'institutional_knowledge'",
      "'mail'",
    ]) {
      expect(service).toContain(domain);
    }
    expect(retrievalModule).toContain('CorePrismaRetrievalAdapter');
    expect(retrievalModule).toContain('InstitutionalKnowledgeRetrievalAdapter');

    // Catalog-only domains are deliberately not requested until a shared
    // Retrieval V2 source adapter is actually registered for them.
    for (const domain of [
      "'action_recommendations'",
      "'strategies_work'",
      "'district_nexus'",
      "'legiwatch_bills'",
      "'hearings'",
      "'program_elements'",
    ]) {
      expect(service).not.toContain(`${domain},`);
    }
    expect(service).toContain('FACT SHEET remains the ONLY material');
    expect(service).toContain('NOT legislative, regulatory, hearing, Program Element');
  });

  test('live memo and district-brief modules block the legacy compiler dependency', () => {
    const factory = read(join(API_ROOT, 'src/intelligence/alert-memo/governed-alert-deliverables.factory.ts'));
    const memoModule = read(join(API_ROOT, 'src/intelligence/alert-memo/alert-memo.module.ts'));
    const districtModule = read(join(API_ROOT, 'src/intelligence/alert-memo/district-brief.module.ts'));

    expect(factory).toContain('PHASE22_BLOCKED_LEGACY_CONTEXT_COMPILER');
    expect(factory).toContain('phase22_legacy_context_compiler_disabled');
    expect(factory).toContain('LegiWatchContextPlaneService');
    expect(factory).toContain('contextPlane.resolve');
    expect(memoModule).toContain('LegiWatchContextPlaneService');
    expect(districtModule).toContain('LegiWatchContextPlaneService');
    expect(memoModule).not.toContain("from '../../context/context-compiler.service.js'");
    expect(districtModule).not.toContain("from '../../context/context-compiler.service.js'");
  });

  test('authoritative legislative and district fact-sheet rails remain intact and separate', () => {
    const memo = read(join(API_ROOT, 'src/intelligence/alert-memo/alert-memo.service.ts'));
    const district = read(join(API_ROOT, 'src/intelligence/alert-memo/district-brief.service.ts'));
    const intelPacket = read(join(REPO_ROOT, 'apps/intel-api/src/feed/alert-packet.service.ts'));

    expect(memo).toContain('billTruthBlock');
    expect(memo).toContain('buildClaims(');
    expect(memo).toContain('FACT SHEET (the ONLY material you may assert; cite ids)');
    expect(district).toContain('representativesForFacility');
    expect(district).toContain('buildDistrictClaims');
    expect(district).toContain('FACT SHEET (the ONLY material you may assert; cite ids)');
    expect(intelPacket).toContain('officialEvidence');
    expect(intelPacket).toContain('proceduralMeaning');
    expect(intelPacket).not.toContain('ContextPlaneGatewayService');
  });
});
