import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const API_ROOT = process.cwd();
const REPO_ROOT = join(API_ROOT, '../..');
const gatewayPath = join(API_ROOT, 'src/context/context-plane-gateway.service.ts');
const registryPath = join(API_ROOT, 'src/context/context-plane-operation-registry.ts');
const auditPath = join(API_ROOT, 'src/context/context-plane-audit.service.ts');
const modulePath = join(API_ROOT, 'src/context/context.module.ts');
const corePath = join(
  REPO_ROOT,
  'packages/meriv2-core/src/context/operation-enforcement.ts',
);

const read = (path: string) => readFileSync(path, 'utf8');

describe('Knowledge Plane Phase 18 architecture contract', () => {
  test('packet-required operations use the Phase 15 -> 17 shared pipeline only', () => {
    const gateway = read(gatewayPath);

    expect(gateway).toContain('this.resolver.resolveAndRetrieve');
    expect(gateway).toContain('this.packets.compile');
    expect(gateway).toContain('this.compiler.modeFor');
    expect(gateway).not.toContain('RetrievalV2Service');
    expect(gateway).not.toContain('Embedding');
    expect(gateway).not.toContain('Anthropic');
    expect(gateway).not.toContain('OpenAI');
    expect(gateway).not.toContain('NVIDIA');
    expect(gateway).not.toContain('fetch(');
  });

  test('future operations default to governed packets and exceptions cannot be wildcard or indefinite', () => {
    const core = read(corePath);

    expect(core).toContain("mode: 'packet_required'");
    expect(core).toContain('targetPhase <= CONTEXT_PLANE_ENFORCEMENT_PHASE');
    expect(core).toContain("registration.id.includes('*')");
    expect(core).toContain("reason: 'migration_exception_expired'");
    expect(core).not.toContain('allowBypass');
    expect(core).not.toContain('skipContextPlane');
  });

  test('adopted Meri operations are governed while remaining product paths stay explicit reviewed debt', () => {
    const registry = read(registryPath);

    for (const adopted of ["id: 'meri.chat'", "id: 'meri.research'", "id: 'research.generate-report'"]) {
      expect(registry).toContain(adopted);
    }
    expect(registry).toContain('governedOperation({');
    for (const marker of [
      'apps/api/src/engagement/',
      'apps/workspace/',
      'apps/api/src/workspace-assistant/',
      'apps/api/src/intelligence/alert-memo/',
      'apps/intel-api/',
      'apps/api/src/clients/',
      'apps/api-strategy/src/context/',
    ]) {
      expect(registry).toContain(marker);
    }
    expect(registry).toContain('approvalBasis: APPROVAL_BASIS');
    expect(registry).not.toContain('phase19-meri-chat-adoption');
    expect(registry).not.toContain('phase19-meri-research-adoption');
    expect(registry).not.toContain('phase19-research-report-adoption');
  });

  test('enforcement decisions are auditable without copying prompts, responses, or retrieved bodies', () => {
    const audit = read(auditPath);

    expect(audit).toContain('INSERT INTO audit_logs');
    expect(audit).toContain('decisionReason');
    expect(audit).toContain('packetTraceHash');
    expect(audit).toContain('retrievalCompleteness');
    expect(audit).not.toContain('promptBody');
    expect(audit).not.toContain('responseBody');
    expect(audit).not.toContain('retrievalPayload');
    expect(audit).not.toContain('memoryBody');
  });

  test('ContextModule exports the single application enforcement boundary', () => {
    const module = read(modulePath);

    expect(module).toContain('ContextPlaneGatewayService');
    expect(module).toContain('ContextPlaneAuditService');
    expect(module).toContain('ContextResolverService');
    expect(module).toContain('ContextPacketV2Service');
    expect(module).not.toContain('ContextPacketV3');
  });
});
