import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const API_ROOT = process.cwd();
const read = (path: string) => readFileSync(path, 'utf8');

/** Undo TypeScript template-literal backtick escaping for prompt assertions. */
const unescapeTicks = (source: string) =>
  // 92 = backslash, 96 = backtick: built from char codes so the needle itself
  // is not subject to another layer of escaping.
  source.split(String.fromCharCode(92, 96)).join(String.fromCharCode(96));

describe('Knowledge Plane Phase 24 Meetings architecture contract', () => {
  test('Meetings owns a thin adapter over the single shared Context Plane gateway', () => {
    const service = read(join(API_ROOT, 'src/engagement/meeting-context-plane.service.ts'));

    expect(service).toContain('ContextPlaneGatewayService');
    expect(service).toContain('this.contextPlane.requestContext');
    expect(service).toContain("operationId: 'meetings.prep-debrief'");
    expect(service).toContain("surface: 'engagement'");
    expect(service).toContain("surface: 'memo'");
    expect(service).toContain('currentPhase: PHASE_24');
    expect(service).not.toContain('ContextCompilerService');
    expect(service).not.toContain('ContextPacketV2Service');
    expect(service).not.toContain('RetrievalV2Service');
    expect(service).not.toContain('EmbeddingProvider');
    expect(service).not.toContain('vectorStore');
    expect(service).not.toContain('pgvector');
  });

  test('production DI exposes only governed meeting AI and one request-scoped bundle', () => {
    const module = read(join(API_ROOT, 'src/engagement/engagement.module.ts'));
    const serviceFactory = read(join(API_ROOT, 'src/engagement/governed-engagement.factory.ts'));
    const aiFactory = read(join(API_ROOT, 'src/engagement/governed-meeting-ai.factory.ts'));

    expect(module).toContain('MeetingContextPlaneService');
    expect(module).toContain('RAW_ENGAGEMENT_AI_SERVICE');
    expect(module).toContain('createGovernedMeetingAiService');
    expect(module).toContain('createGovernedEngagementService');
    expect(serviceFactory).toContain('meetingContext.resolve');
    expect(serviceFactory).toContain('runWithMeetingGovernedContext');
    expect(serviceFactory).toContain('currentMeetingGovernedContext');
    expect(serviceFactory).toContain('return activeMeeting.modelContextBlock');
    expect(aiFactory).toContain("requireMeetingGovernedContext('prep')");
    expect(aiFactory).toContain("requireMeetingGovernedContext('debrief')");
    expect(aiFactory).toContain('recentMeetings: []');
    expect(aiFactory).toContain('recentThreads: []');
    expect(aiFactory).toContain('clientContext: null');
  });

  test('notetaker and meeting-capture persistence reuse the governed debrief-draft path', () => {
    const notetaker = read(join(API_ROOT, 'src/engagement/notetaker/notetaker.service.ts'));
    const persistence = read(
      join(API_ROOT, 'src/meeting-capture/meeting-capture-persistence.service.ts'),
    );

    expect(notetaker).toContain('this.engagement.generateMeetingDebriefDraft');
    expect(notetaker).toContain('createMeetingNote');
    expect(persistence).toContain('this.engagement.generateMeetingDebriefDraft');
    expect(persistence).not.toContain('EngagementAiService');
    expect(persistence).not.toContain('ContextCompilerService');
    expect(notetaker).not.toContain('ContextCompilerService');
    expect(notetaker).not.toContain('ContextPlaneGatewayService');
  });

  test('transcript and visible notes remain authoritative; background cannot invent commitments', () => {
    const ai = read(join(API_ROOT, 'src/engagement/engagement-ai.service.ts'));
    const context = read(join(API_ROOT, 'src/engagement/meeting-context-plane.service.ts'));

    // The prompt lives inside a template literal, so its backticks are escaped in
    // the source file. Compare against the unescaped prompt text, not the raw
    // TypeScript escaping, or this gate breaks on an unrelated prompt edit.
    expect(unescapeTicks(ai)).toContain(
      '`source.text`: primary evidence of what was said during the meeting',
    );
    expect(ai).toContain('Do not convert a question, possibility, hypothesis, suggestion');
    expect(ai).toContain('Return an empty array when there are no supported action items');
    expect(context).toContain(
      'only source.text, visibleNotes, and confirmed current-meeting metadata may establish what happened',
    );
    expect(context).toContain(
      'does not authorize sending email, creating commitments/tasks, or mutating CRM records',
    );
  });

  test('shared supplemental domains use adapter-backed allowlisted content fields', () => {
    const service = read(join(API_ROOT, 'src/engagement/meeting-context-plane.service.ts'));
    const retrievalModule = read(join(API_ROOT, 'src/retrieval/retrieval.module.ts'));

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
    expect(service).toContain("'fromEmail'");
    expect(service).toContain("'bodyText'");
    expect(service).toContain("'toRecipients'");
    expect(service).not.toContain("pick(payload, ['body']");
  });
});
