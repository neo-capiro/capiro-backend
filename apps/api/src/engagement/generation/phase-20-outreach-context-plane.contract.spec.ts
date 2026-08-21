import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const API_ROOT = process.cwd();
const REPO_ROOT = join(API_ROOT, '../..');
const read = (path: string) => readFileSync(path, 'utf8');

const FORBIDDEN_RETRIEVAL = [
  'RetrievalV2Service',
  'new OpenAI',
  'new Anthropic',
  'Pinecone',
  'weaviate',
  'featureRag',
  'OutreachRag',
  'ContextPacketV3',
];

describe('Knowledge Plane Phase 20 Outreach adoption contract', () => {
  test('Outreach product traffic enters through one API Context Plane adapter', () => {
    const module = read(join(API_ROOT, 'src/engagement/engagement.module.ts'));
    const adapter = read(join(API_ROOT, 'src/engagement/generation/outreach-context-plane.service.ts'));
    const gateway = read(join(API_ROOT, 'src/engagement/generation/generation-gateway.service.ts'));

    expect(module).toContain('OutreachContextPlaneService');
    expect(adapter).toContain('ContextPlaneGatewayService');
    expect(adapter).toContain("operationId: 'outreach.generate'");
    expect(adapter).toContain("surface: 'outreach'");
    expect(adapter).toContain('currentPhase: PHASE_20');
    expect(adapter).toContain("kind === 'migration_exception'");
    expect(gateway).toContain('OutreachContextPlaneService');
    expect(gateway).toContain('this.contextPlane.resolve');
  });

  test('Phase 20 registry operation is packet-required with its old exception and legacy debt removed', () => {
    const registry = read(join(API_ROOT, 'src/context/context-plane-operation-registry.ts'));

    expect(registry).toContain("id: 'outreach.generate'");
    expect(registry).toContain('governedOperation({');
    expect(registry).not.toContain('phase20-outreach-adoption');
    expect(registry).not.toContain('apps/api/src/engagement/generation/**');
    expect(registry).not.toContain("'apps/api/src/engagement/outreach-job.service.ts'");
  });

  test('Classic, V3, batch, async, and revision drafting all cross GenerationGateway.generate', () => {
    const classic = read(join(API_ROOT, 'src/engagement/engagement.service.ts'));
    const job = read(join(API_ROOT, 'src/engagement/outreach-job.service.ts'));
    const samples = read(join(API_ROOT, 'src/outreach-v3/generation/outreach-v3-sample-generation.service.ts'));
    const worker = read(
      join(API_ROOT, 'src/engagement-workers/outreach-v3-full-generation-worker.service.ts'),
    );
    const gateway = read(join(API_ROOT, 'src/engagement/generation/generation-gateway.service.ts'));

    expect(classic).toContain('this.gateway.generate');
    expect(job).toContain('this.engagement.generateBatchEmails');
    expect(samples).toContain('this.gateway.generate');
    expect(worker).toContain('this.gateway.generate');
    expect(gateway).toContain('existingBody');
    expect(gateway).toContain('reviseInstruction');
  });

  test('no live Outreach generation path starts its own retrieval or packet compiler', () => {
    const sources = [
      read(join(API_ROOT, 'src/engagement/generation/generation-gateway.service.ts')),
      read(join(API_ROOT, 'src/engagement/generation/outreach-context-plane.service.ts')),
      read(join(API_ROOT, 'src/engagement/outreach-job.service.ts')),
      read(join(API_ROOT, 'src/outreach-v3/generation/outreach-v3-sample-generation.service.ts')),
      read(join(API_ROOT, 'src/engagement-workers/outreach-v3-full-generation-worker.service.ts')),
    ];

    for (const source of sources) {
      for (const forbidden of FORBIDDEN_RETRIEVAL) {
        expect(source).not.toContain(forbidden);
      }
    }

    const adapter = sources[1]!;
    expect(adapter).not.toContain('ContextCompilerService');
    expect(adapter).not.toContain('ContextPacketV2Service');
    expect(adapter).not.toContain('ContextResolverService');
  });

  test('Evidence Packet standing memory is projected from the shared Context Plane packet', () => {
    const evidence = read(join(API_ROOT, 'src/engagement/generation/evidence-packet.service.ts'));
    expect(evidence).toContain('governedContext');
    expect(evidence).toContain('projectStandingMemory');
    expect(evidence).not.toMatch(/await this\.loadStandingMemory\(ctx, request\.clientId\)/);
  });

  test('outbound send controls stay independent of Context Packet health', () => {
    const send = read(join(API_ROOT, 'src/engagement/outreach-send-intent.service.ts'));
    const gateway = read(join(API_ROOT, 'src/engagement/generation/generation-gateway.service.ts'));
    const drafts = read(join(REPO_ROOT, 'apps/api/src/outreach-v3/drafts/outreach-v3-drafts-architecture.spec.ts'));

    expect(send).not.toContain('OutreachContextPlaneService');
    expect(send).not.toContain('retrievalCompleteness');
    expect(gateway).toContain('sendable: version.sendable');
    expect(drafts).toContain("expect(service).not.toContain('GenerationGatewayService')");
  });

  test('Phase 20 introduces no Outreach-specific knowledge database or second packet', () => {
    const adapter = read(join(API_ROOT, 'src/engagement/generation/outreach-context-plane.service.ts'));
    for (const forbidden of ['ContextPacketV3', 'outreach_knowledge', 'outreach_embeddings']) {
      expect(adapter).not.toContain(forbidden);
    }
  });
});
