import type { MeriContext } from '@capiro/meriv2-core';
import type { InEditorInput } from './in-editor-prompt.js';

function entry(label: string, text: string | undefined): { label: string; text: string } | null {
  const value = text?.trim();
  return value ? { label, text: value } : null;
}

/**
 * Add the same governed firm/user/client steering that full chat receives to
 * the document assistant's linked-context block. The prompt already treats this
 * block as data rather than instructions; the safe contextPacket travels back
 * separately for the inspector and contains no body text.
 */
export function withGovernedEditorContext(dto: InEditorInput, ctx: MeriContext): InEditorInput {
  const governed = [
    entry('Firm Soul', ctx.firmMemory?.soul),
    entry('Firm Compass', ctx.firmMemory?.compass),
    entry('User writing voice', ctx.userVoice),
    entry('Client Soul', ctx.clientSteering?.soul),
    entry('Client Compass', ctx.clientSteering?.compass),
    entry('Client people', ctx.clientSteering?.people),
  ].filter((item): item is { label: string; text: string } => item !== null);

  return {
    ...dto,
    context: [...governed, ...(dto.context ?? [])],
  };
}
