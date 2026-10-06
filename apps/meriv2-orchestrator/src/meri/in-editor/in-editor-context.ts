import type { MeriContext, MeriGovernedTurnContext } from '@capiro/meriv2-core';
import type { InEditorInput } from './in-editor-prompt.js';

function entry(label: string, text: string | undefined): { label: string; text: string } | null {
  const value = text?.trim();
  return value ? { label, text: value } : null;
}

function governedPromptEntries(
  governed?: MeriGovernedTurnContext,
): Array<{ label: string; text: string }> {
  const prompt = governed?.prompt?.trim();
  if (!prompt) return [];
  // The complete combined request is bounded by the editor service. Do not
  // silently drop evidence here before that safety check can see it.
  return [{ label: 'Governed Context Plane', text: prompt }];
}

/**
 * Add governed context to the document assistant's linked-context block.
 *
 * Phase 21 passes a pre-resolved Context Plane runtime projection. Legacy
 * MeriContext fields remain supported for compatibility tests, but the live
 * orchestrator controller now uses identity-only resolution and the governed
 * prompt instead of compiling institutional context a second time.
 */
export function withGovernedEditorContext(
  dto: InEditorInput,
  ctx: MeriContext,
  governed?: MeriGovernedTurnContext,
): InEditorInput {
  const legacy = [
    entry('Firm Soul', ctx.firmMemory?.soul),
    entry('Firm Compass', ctx.firmMemory?.compass),
    entry('User writing voice', ctx.userVoice),
    entry('Client Soul', ctx.clientSteering?.soul),
    entry('Client Compass', ctx.clientSteering?.compass),
    entry('Client people', ctx.clientSteering?.people),
  ].filter((item): item is { label: string; text: string } => item !== null);

  return {
    ...dto,
    context: [...governedPromptEntries(governed), ...legacy, ...(dto.context ?? [])],
  };
}
