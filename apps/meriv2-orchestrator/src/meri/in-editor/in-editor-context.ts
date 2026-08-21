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
  // in-editor-prompt bounds each linked-context item to 600 chars and the whole
  // block to 8k. Pre-chunking keeps the Context Plane coverage header + evidence
  // usable instead of silently losing everything after the first 600 chars.
  const chunks: Array<{ label: string; text: string }> = [];
  for (let offset = 0, part = 1; offset < prompt.length && part <= 12; offset += 520, part += 1) {
    chunks.push({
      label: `Governed Context Plane ${part}`,
      text: prompt.slice(offset, offset + 520),
    });
  }
  return chunks;
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
