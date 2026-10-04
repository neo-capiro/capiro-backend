import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const API_ROOT = process.cwd();
const REPO_ROOT = join(API_ROOT, '../..');
const read = (path: string) => readFileSync(path, 'utf8');

describe('Knowledge Plane Phase 19 Meri adoption contract', () => {
  test('Meri product traffic enters through one API Context Plane adapter', () => {
    const module = read(join(API_ROOT, 'src/meri/meri.module.ts'));
    const adapter = read(join(API_ROOT, 'src/meri/meri-context-plane.service.ts'));
    const runtime = read(join(API_ROOT, 'src/meri/meriv3-runtime.proxy.ts'));

    expect(module).toContain('MeriContextPlaneService');
    expect(module).toContain('MeriContextPlaneRuntimeService');
    expect(adapter).toContain('ContextPlaneGatewayService');
    expect(adapter).toContain('currentPhase: PHASE_19');
    expect(runtime).toContain('governedRuntime.runChatTurn');
    expect(runtime).toContain('currentMeriGovernedRuntime');
    expect(runtime).not.toContain('RetrievalV2Service');
    expect(runtime).not.toContain('ContextCompilerService');
  });

  test('legacy chat prewarms are suppressed on governed turns', () => {
    const runtime = read(join(API_ROOT, 'src/meri/meriv3-runtime.proxy.ts'));

    expect(runtime).toContain('loadRelevantMemories');
    expect(runtime).toContain('currentMeriGovernedRuntime() ? []');
    expect(runtime).toContain('governedClientKbProxy');
    expect(runtime).toContain('governedContext: governed.context');
  });

  test('Deep Research uses both Phase 19 governed operations and no direct compiler dependency', () => {
    const research = read(join(API_ROOT, 'src/meri/governed-meri-research.factory.ts'));

    expect(research).toContain("'meri.research'");
    expect(research).toContain("'research.generate-report'");
    expect(research).toContain('MeriContextPlaneService');
    expect(research).not.toContain('ContextCompilerService');
  });

  test('Phase 19 registry operations are packet-required with their old exception ids removed', () => {
    const registry = read(join(API_ROOT, 'src/context/context-plane-operation-registry.ts'));

    for (const operation of ["id: 'meri.chat'", "id: 'meri.research'", "id: 'research.generate-report'"]) {
      expect(registry).toContain(operation);
    }
    expect(registry).toContain('governedOperation({');
    expect(registry).not.toContain('phase19-meri-chat-adoption');
    expect(registry).not.toContain('phase19-meri-research-adoption');
    expect(registry).not.toContain('phase19-research-report-adoption');
  });

  test('V2 and V3 public chat routes fail closed without an upstream governed bundle', () => {
    const v2 = read(
      join(REPO_ROOT, 'apps/meriv2-orchestrator/src/meri/chat/chat.controller.ts'),
    );
    const v3 = read(
      join(REPO_ROOT, 'apps/meriv2-orchestrator/src/meri/meriv3/meriv3.controller.ts'),
    );

    for (const controller of [v2, v3]) {
      expect(controller).toContain('meri_governed_context_required');
      expect(controller).toContain('resolveIdentity(tenant)');
      expect(controller).not.toContain('this.resolver.resolve(tenant');
    }
  });

  test('V3 does not expose its parallel retrieval recipes on a governed Capiro turn', () => {
    const v3Retrieval = read(
      join(
        REPO_ROOT,
        'apps/meriv2-orchestrator/src/meri/meriv3/meriv3-retrieval-assistant.service.ts',
      ),
    );

    expect(v3Retrieval).toContain('currentGovernedMeriContext');
    expect(v3Retrieval).toContain('const governed = currentGovernedMeriContext();');
    expect(v3Retrieval).toMatch(/const recipes = governed\s*\? \[\]/);
    expect(v3Retrieval).toContain('if (governed)');
    expect(v3Retrieval).toContain('super.run');
  });

  test('durable Meri recall is a shared Retrieval V2 institutional-knowledge source', () => {
    const adapter = read(
      join(
        API_ROOT,
        'src/retrieval/adapters/institutional-knowledge-retrieval.adapter.ts',
      ),
    );
    const catalog = read(
      join(API_ROOT, 'src/retrieval/data-catalog/semantic-data-catalog.service.ts'),
    );

    expect(adapter).toContain('FROM memory_items mi');
    expect(adapter).not.toContain('clioMemory.findMany');
    expect(adapter).toContain('clientMemoryAllowed');
    const eligibility = read(
      join(API_ROOT, 'src/retrieval/adapters/governed-memory-eligibility.helpers.ts'),
    );
    expect(adapter).toContain('canonicalMemoryEligibilitySql({');
    expect(adapter).toContain('includeCanonicalGovernedMemoryRow(row, {');
    expect(eligibility).toContain("governedRecallEligibilitySql('mi')");
    expect(eligibility).toContain('filterGovernedMemory(row, {');
    expect(catalog).toContain("'semantic_recall'");
    expect(catalog).toContain("'governed_memory'");
  });

  test('Phase 19 introduces no ContextPacket V3 or Meri-specific knowledge database', () => {
    const adapter = read(join(API_ROOT, 'src/meri/meri-context-plane.service.ts'));
    const runtime = read(join(API_ROOT, 'src/meri/meriv3-runtime.proxy.ts'));
    const research = read(join(API_ROOT, 'src/meri/governed-meri-research.factory.ts'));

    for (const source of [adapter, runtime, research]) {
      expect(source).not.toContain('ContextPacketV3');
      expect(source).not.toContain('meri_knowledge');
      expect(source).not.toContain('meri_embeddings');
    }
  });
});
