import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { CollaboratorsService } from '../collaborators/collaborators.service.js';
import type { SaveProspectDraftDto } from './dto/prospect-save.dto.js';
import { saveAtomicDraft } from './atomic-draft-save.js';

export function saveProspectDraft(
  prisma: PrismaService,
  collaborators: CollaboratorsService,
  tenantId: string,
  draftId: string,
  actorId: string,
  input: SaveProspectDraftDto,
) {
  if (
    !input ||
    typeof input.title !== 'string' ||
    !input.title.trim() ||
    input.title.length > 500 ||
    !Array.isArray(input.names) ||
    input.names.length < 1 ||
    input.names.length > 100 ||
    input.names.some(
      (name) =>
        typeof name !== 'string' ||
        !name.trim() ||
        name.length > 300 ||
        ['__proto__', 'constructor', 'prototype'].includes(name),
    ) ||
    new Set(input.names).size !== input.names.length ||
    !input.sections ||
    Array.isArray(input.sections) ||
    Object.keys(input.sections).some((name) => !input.names.includes(name)) ||
    input.names.some(
      (name) => typeof input.sections[name] !== 'string' || input.sections[name]!.length > 100000,
    ) ||
    Buffer.byteLength(JSON.stringify(input)) > 1_000_000
  )
    throw new BadRequestException('Invalid bounded prospect draft content');
  const save = {
    requestId: input.requestId,
    expectedStateHash: input.expectedStateHash,
    expectedClientId: null,
    label: 'Manual save',
    draft: {
      docTitle: input.title,
      config: { sections: input.names, sectionContent: input.sections },
    },
  };
  return saveAtomicDraft(
    prisma,
    collaborators,
    tenantId,
    draftId,
    actorId,
    save,
    async (tx) => {
      const current = await tx.wsDraft.findFirst({
        where: { tenantId, id: draftId, prospectId: input.expectedProspectId },
      });
      if (!current) throw new NotFoundException('Draft not found');
      await tx.wsDraft.update({
        where: { tenantId, id: draftId },
        data: {
          docTitle: input.title,
          lastEditedById: actorId,
          config: { ...(current.config as Record<string, unknown>), ...save.draft.config } as never,
        },
      });
    },
    input.expectedProspectId,
  );
}
