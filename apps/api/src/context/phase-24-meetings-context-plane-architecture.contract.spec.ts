import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const API_ROOT = process.cwd();
const runtimePath = join(API_ROOT, 'src/context/meetings-context-plane.runtime.ts');
const gatewayPath = join(API_ROOT, 'src/context/context-plane-gateway.service.ts');
const aiPath = join(API_ROOT, 'src/engagement/engagement-ai.service.ts');
const sourceRoots = [join(API_ROOT, 'src/engagement'), join(API_ROOT, 'src/meeting-capture')];

const read = (path: string) => readFileSync(path, 'utf8');

function sourceFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (directory: string) => {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (name.endsWith('.ts') && !name.endsWith('.spec.ts')) out.push(path);
    }
  };
  walk(root);
  return out;
}

describe('Knowledge Plane Phase 24 Meetings architecture contract', () => {
  test('the mature prep and debrief methods are guarded by the shared gateway runtime', () => {
    const ai = read(aiPath);
    const runtime = read(runtimePath);
    const gateway = read(gatewayPath);

    expect(ai).toContain('async generateMeetingPrep(');
    expect(ai).toContain('async generateMeetingDebrief(');
    expect(runtime).toContain("source.includes('generateMeetingPrep')");
    expect(runtime).toContain("source.includes('generateMeetingDebrief')");
    expect(runtime).toContain('phase24_meetings_governed_invocation_required');
    expect(runtime).toContain('phase24_meetings_provider_context_not_injected');
    expect(gateway).toContain('new MeetingsContextPlaneRuntime(');
    expect(gateway).toContain('this.meetingsRuntime.install()');
  });

  test('every live direct caller is discoverable by the permanent caller wrapper', () => {
    const runtime = read(runtimePath);
    const callers = sourceRoots
      .flatMap(sourceFiles)
      .filter((path) => path !== aiPath)
      .map((path) => ({ path, source: read(path) }))
      .filter(
        ({ source }) =>
          source.includes('generateMeetingPrep') || source.includes('generateMeetingDebrief'),
      );

    expect(callers.length).toBeGreaterThan(0);
    expect(callers.some(({ source }) => source.includes('generateMeetingPrep'))).toBe(true);
    expect(callers.some(({ source }) => source.includes('generateMeetingDebrief'))).toBe(true);
    expect(runtime).toContain('Function.prototype.toString.call(entry.fn)');
    expect(runtime).toContain('phase24_meetings_live_callers_not_found');

    for (const caller of callers) {
      expect(relative(API_ROOT, caller.path)).not.toContain('context/meetings-context-plane');
    }
  });

  test('meeting product code owns no independent compiler, Retrieval V2, embedding, or vector path', () => {
    const productSource = sourceRoots.flatMap(sourceFiles).map(read).join('\n');

    expect(productSource).not.toContain('ContextCompilerService');
    expect(productSource).not.toContain('ContextPacketV2Service');
    expect(productSource).not.toContain('RetrievalV2Service');
    expect(productSource).not.toContain('EmbeddingProvider');
    expect(productSource).not.toContain('ContextPacketRolloutCompiler');
    expect(productSource).not.toContain('pgvector');
  });

  test('calendar/transcript authority is separate from supplemental private context', () => {
    const runtime = read(runtimePath);

    expect(runtime).toContain(
      'Calendar/meeting input and the current transcript/notes stay authoritative',
    );
    expect(runtime).toContain('CURRENT TRANSCRIPT/NOTES AUTHORITY');
    expect(runtime).toContain(
      'Only the current meeting transcript and current notes may establish',
    );
    expect(runtime).toContain('Never convert an old task, prior email, prior meeting');
    expect(runtime).toContain('PREP AUTHORITY');
    expect(runtime).toContain('suggestions must be labelled');
    expect(runtime).toContain(
      'This block never grants permission to send email, create a task, update CRM',
    );
  });

  test('the runtime is read-only except for ContextPacket/audit persistence owned by the gateway', () => {
    const runtime = read(runtimePath);

    expect(runtime).toContain('this.gateway.requestContext');
    expect(runtime).toContain('tx.client.findFirst');
    expect(runtime).toContain('tx.client.findMany');
    expect(runtime).not.toContain('tx.client.update');
    expect(runtime).not.toContain('tx.task.create');
    expect(runtime).not.toContain('tx.outreach.create');
    expect(runtime).not.toContain('$executeRaw');
    expect(runtime).not.toContain('OutreachSendIntentService');
  });
});
