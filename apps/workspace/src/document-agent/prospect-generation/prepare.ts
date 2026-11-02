import { BadRequestException } from '@nestjs/common';
import { parseWorkspaceBlueprintDefinition } from '@capiro/shared/workspace-template-studio';
import { workspaceProspectGenerationSourceWithinTx } from '@capiro/shared/workspace-prospect-generation-source';
import type { Prisma } from '../../../generated/prisma-client/index.js';
import { nativeGenerationRequestId } from '../native-generation.bridge.js';
import { nativeGenerationSourceSnapshot } from '../native-generation-source.js';
import { resolveBlueprintPin } from '../../template-studio/blueprint-pin.js';
import { TemplateValidator } from '../../template-studio/template-validator.js';
import {
  generationHash,
  record,
  generationConflict,
  type ProspectGenerationInput,
  type ProspectGenerationPayload,
} from './contract.js';

const snapshot = (...args: Parameters<typeof nativeGenerationSourceSnapshot>) => {
  try {
    return nativeGenerationSourceSnapshot(...args);
  } catch {
    throw new BadRequestException('Selected source exceeds the bounded generation contract');
  }
};

/** Select exact saved bytes; current working edits never leak into an attempt. */
export async function prepareProspectGeneration(
  tx: Prisma.TransactionClient,
  tenantId: string,
  draftId: string,
  actorId: string,
  input: ProspectGenerationInput,
): Promise<ProspectGenerationPayload> {
  const provisional = {
    schemaVersion: 1 as const,
    requestId: `wsgen:${'0'.repeat(64)}`,
    draftId,
    prospectId: input.expectedProspectId,
    sourceVersionId: input.sourceVersionId,
    sourceSnapshotHash: input.sourceSnapshotHash,
  };
  const saved = await workspaceProspectGenerationSourceWithinTx(
    tx,
    tenantId,
    { clerkUserId: actorId },
    provisional,
    { edit: true },
  );
  if (saved.stateHash !== input.expectedStateHash) return generationConflict('SOURCE_CONFLICT');
  const config = record(saved.content.config),
    names = config.sections,
    content = record(config.sectionContent);
  if (
    !Array.isArray(names) ||
    !names.length ||
    names.length > 100 ||
    new Set(names).size !== names.length ||
    names.some(
      (name) =>
        typeof name !== 'string' ||
        !name.trim() ||
        name.length > 300 ||
        ['__proto__', 'constructor', 'prototype'].includes(name),
    ) ||
    input.selectedSections.some(
      (name) => !names.includes(name) || typeof content[name] !== 'string',
    )
  )
    throw new BadRequestException('The saved version has no supported selected sections');
  const title = saved.content.docTitle;
  if (typeof title !== 'string' || !title.trim() || title.length > 500)
    return generationConflict('SOURCE_CONFLICT');
  const sources = [
    snapshot(
      input.requestId,
      'generation-request',
      JSON.stringify({
        sourceVersionId: input.sourceVersionId,
        sourceSnapshotHash: input.sourceSnapshotHash,
        selectedSections: input.selectedSections,
      }),
    ),
  ];
  const pin = record(config.documentAgent).blueprintPin;
  if (pin) {
    const template = await resolveBlueprintPin(tx, tenantId, pin, 'retained');
    const parsed = parseWorkspaceBlueprintDefinition(template.version.definition);
    if (
      !parsed.ok ||
      new TemplateValidator().computeDefinitionHash(parsed.value) !== template.pin.definitionHash
    )
      return generationConflict('SOURCE_CONFLICT');
    sources.push(
      snapshot(
        template.pin.versionId,
        'published-template',
        JSON.stringify({ pin: template.pin, definition: parsed.value }),
      ),
    );
  }
  sources.push(
    snapshot(
      input.sourceVersionId,
      'saved-source',
      JSON.stringify({
        title,
        sections: input.selectedSections.map((name) => ({ name, text: content[name] })),
      }),
    ),
  );
  const outline = (names as string[]).map((name, index) => ({ id: `section-${index + 1}`, name }));
  for (const section of outline)
    sources.push(
      snapshot(
        section.id,
        'outline-section',
        JSON.stringify({
          title: section.name,
          templateSectionId: record(config.blueprintSectionIds)[section.name] ?? null,
        }),
      ),
    );
  const exact = {
    tenantId,
    actorId: saved.scope.userId,
    draftId,
    clientId: null,
    phase: 'document' as const,
    expectedRevision: 0,
    writingBrief: input.writingBrief,
    sources,
  };
  const turn = {
    ...exact,
    paidGeneration: true as const,
    requestId: nativeGenerationRequestId(exact),
  };
  if (Buffer.byteLength(JSON.stringify({ schemaVersion: 1, request: turn })) > 65536)
    throw new BadRequestException(
      'Selected sources exceed the generation limit; select fewer or shorter sections',
    );
  return {
    schemaVersion: 1,
    input,
    requestHash: generationHash({ tenantId, draftId, actorId, input }),
    source: { ...provisional, requestId: turn.requestId },
    turn,
    outline,
    title,
    phase: 'prepared',
  };
}
