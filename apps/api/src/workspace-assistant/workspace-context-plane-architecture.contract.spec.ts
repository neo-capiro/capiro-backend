import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const API_ROOT = process.cwd();
const REPO_ROOT = join(API_ROOT, '../..');
const read = (path: string) => readFileSync(path, 'utf8');

describe('Knowledge Plane Phase 21 Workspace architecture contract', () => {
  test('apps/api Workspace adapter crosses the shared Context Plane gateway for both operations', () => {
    const service = read(join(API_ROOT, 'src/workspace-assistant/workspace-context-plane.service.ts'));

    expect(service).toContain('ContextPlaneGatewayService');
    expect(service).toContain('this.contextPlane.requestContext');
    expect(service).toContain("operationId: 'workspace.editor-assist'");
    expect(service).toContain("'workspace.generate'");
    expect(service).toContain('currentPhase: PHASE_21');
    // Every mixed client domain supports lookup; relationship_history would
    // manufacture partial coverage for clients/strategy/outreach.
    expect(service).toContain("subjectClientId ? 'lookup' : 'semantic_recall'");
    expect(service).not.toContain("subjectClientId ? 'relationship_history'");
    expect(service).not.toContain('RetrievalV2Service');
    expect(service).not.toContain('ContextCompilerService');
    expect(service).not.toContain('Embedding');
    expect(service).not.toContain('vector');
  });

  test('isolated Workspace service is now a thin internal Context Plane client, not a compiler/store', () => {
    const compiler = read(
      join(REPO_ROOT, 'apps/workspace/src/generation/context-compiler.service.ts'),
    );

    expect(compiler).toContain('/api/internal/workspace/context/');
    expect(compiler).toContain('x-internal-service-secret');
    expect(compiler).toContain("'workspace.generate'");
    expect(compiler).toContain("'workspace.editor-assist'");
    expect(compiler).not.toContain('PrismaService');
    expect(compiler).not.toContain('memory_items');
    expect(compiler).not.toContain('context_packet');
    expect(compiler).not.toContain('ContextPacketRolloutCompiler');
    expect(compiler).not.toContain('loadSteeringRows');
  });

  test('in-process editor compiler token is overridden with the Context Plane adapter', () => {
    const module = read(join(API_ROOT, 'src/workspace-assistant/workspace-assistant.module.ts'));
    const adapter = read(
      join(API_ROOT, 'src/workspace-assistant/workspace-editor-context-compiler.adapter.ts'),
    );

    expect(module).toContain('WorkspaceEditorContextCompilerAdapter');
    expect(module).toContain('provide: ContextCompilerService');
    expect(module).toContain('useExisting: WorkspaceEditorContextCompilerAdapter');
    expect(adapter).toContain("operationId: 'workspace.editor-assist'");
    expect(adapter).toContain("surface: 'workspace-editor'");
    expect(adapter).not.toContain('PrismaService');
  });

  test('MeriV2 editor accepts governed context only over the trusted apps/api proxy hop', () => {
    const apiClient = read(join(API_ROOT, 'src/workspace-assistant/meriv2-orchestrator.client.ts'));
    const controller = read(
      join(REPO_ROOT, 'apps/meriv2-orchestrator/src/meri/in-editor/in-editor.controller.ts'),
    );

    expect(apiClient).toContain('this.contextPlane.resolveEditor');
    expect(apiClient).toContain('governedContext: governed.governedContext');
    expect(apiClient).toContain("'x-internal-service-secret': this.internalSecret");
    expect(controller).toContain('requireInternalContextProxy');
    expect(controller).toContain("req.headers['x-internal-service-secret']");
    expect(controller).toContain('requireGovernedContext');
    expect(controller).toContain('this.resolver.resolveIdentity');
    expect(controller).toContain('runWithGovernedMeriContext');
    expect(controller).not.toContain('this.resolver.resolve(tenant');
  });
});
