import fs from 'node:fs';

const file = 'apps/api/src/meri/meri.service.ts';
let source = fs.readFileSync(file, 'utf8');
function replaceOnce(search, replacement) {
  if (!source.includes(search)) throw new Error(`MeriService anchor not found: ${search.slice(0, 160)}`);
  source = source.replace(search, replacement);
}

replaceOnce(`import { passesWriteConfidenceGate } from './memory-confidence.helpers.js';\n`, ``);
replaceOnce(
  `import { MemoryIngestService } from '../memory/memory-ingest.service.js';\n`,
  `import { MemoryIngestService } from '../memory/memory-ingest.service.js';\nimport { MemoryCandidateService } from '../memory/memory-candidate.service.js';\nimport { evaluateMemoryMutation } from '../memory/memory-mutation-auth.js';\nimport { decideMemoryAutoLearn, exactUserExcerpt } from '../memory/memory-autolearn-governance.js';\n`,
);
replaceOnce(
  `import { planTurnRerun } from './meri-turn.helpers.js';\n`,
  `import { planTurnRerun } from './meri-turn.helpers.js';\nimport { shouldRouteMeriV2FullChat } from './meriv2-routing.helpers.js';\n`,
);
replaceOnce(
  `    private readonly memoryIngest: MemoryIngestService,\n    private readonly meriFlags: MeriFeatureFlagsService,\n`,
  `    private readonly memoryIngest: MemoryIngestService,\n    private readonly memoryCandidates: MemoryCandidateService,\n    private readonly meriFlags: MeriFeatureFlagsService,\n`,
);

replaceOnce(
  `    if (\n      bearerToken &&\n      this.meriV2Chat.configured &&\n      (await this.meriFlags.isMeriV2SurfaceEnabled(ctx.tenantId, MERIV2_FLAGS.fullChat))\n    ) {\n`,
  `    const meriV2FullChatEnabled =\n      bearerToken && this.meriV2Chat.configured\n        ? await this.meriFlags.isMeriV2SurfaceEnabled(ctx.tenantId, MERIV2_FLAGS.fullChat)\n        : false;\n    if (\n      shouldRouteMeriV2FullChat({\n        bearerToken,\n        configured: this.meriV2Chat.configured,\n        enabled: meriV2FullChatEnabled,\n        impersonateTenantId,\n      })\n    ) {\n`,
);
replaceOnce(
  `        content,\n        replayHistory,\n`,
  `        content,\n        sourceMessageId: lastUserMessage?.id ?? null,\n        replayHistory,\n`,
);
replaceOnce(
  `    content: string;\n    replayHistory: Array<{ role: 'user' | 'assistant'; body: string }>;\n`,
  `    content: string;\n    sourceMessageId: string | null;\n    replayHistory: Array<{ role: 'user' | 'assistant'; body: string }>;\n`,
);
replaceOnce(
  `    let doneFrame: Extract<MeriV2ChatStreamEvent, { type: 'done' }> | null = null;\n    let errorMessage: string | null = null;\n`,
  `    let doneFrame: Extract<MeriV2ChatStreamEvent, { type: 'done' }> | null = null;\n    let errorMessage: string | null = null;\n    let groundingSeverity: string | null = null;\n`,
);
replaceOnce(
  `        case 'grounding_caveat':\n          // Chat enforce-gate (non-blocking): forward the orchestrator's caveat\n`,
  `        case 'grounding_caveat':\n          groundingSeverity = event.topSeverity;\n          // Chat enforce-gate (non-blocking): forward the orchestrator's caveat\n`,
);

replaceOnce(
  `    if (assistantContent.length > 200 && !auditorFoundIssues) {\n      void this.maybeLearnFromConversation(\n        ctx.tenantId,\n        ctx.userId,\n        conversationId,\n        content,\n        assistantContent,\n        ctx.role,\n      ).catch(() => {});\n    }\n`,
  `    if (assistantContent.length > 200) {\n      void this.maybeLearnFromConversation({\n        ctx,\n        conversationId,\n        sourceMessageId: lastUserMessage?.id ?? null,\n        userMessage: content,\n        assistantResponse: assistantContent,\n        aborted,\n        complianceRefusal: complianceScreen.flagged,\n        executionError:\n          assistantContent.startsWith('Error:') ||\n          traceRounds.some((round) => round.tools.some((tool) => !tool.ok)),\n        groundingSeverity: auditorFoundIssues ? 'high' : null,\n      }).catch(() => {});\n    }\n`,
);
replaceOnce(
  `    if (assistantContent.length > 200) {\n      void this.maybeLearnFromConversation(\n        ctx.tenantId,\n        ctx.userId,\n        args.conversationId,\n        args.content,\n        assistantContent,\n        ctx.role,\n      ).catch(() => {});\n    }\n`,
  `    if (assistantContent.length > 200) {\n      void this.maybeLearnFromConversation({\n        ctx,\n        conversationId: args.conversationId,\n        sourceMessageId: args.sourceMessageId,\n        userMessage: args.content,\n        assistantResponse: assistantContent,\n        aborted,\n        complianceRefusal: args.complianceScreen.flagged,\n        executionError: Boolean(errorMessage) || steps.some((step) => step.status === 'error'),\n        groundingSeverity,\n      }).catch(() => {});\n    }\n`,
);

fs.writeFileSync(file, source);
console.log('Meri routing and governed-learning call sites applied.');
