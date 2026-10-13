import { BadRequestException, NotFoundException } from '@nestjs/common';
import { canonicalWorkspaceSnapshot, type ProspectBriefVersionIdentity } from '@capiro/shared';
import { createHash } from 'node:crypto';
import type {
  ProspectBriefCommandDto,
  SaveProspectBriefCopyDto,
} from './dto/prospect-brief-copy.dto.js';

export const briefSectionLabels = {
  companyAndFirmImplication: 'Company and firm implication',
  verifiedEvidence: 'Verified evidence',
  judgment: 'Judgment',
  practicalAction: 'Practical action',
  missingInformation: 'Missing information',
} as const;
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const stateHash = (value: unknown) =>
  createHash('sha256').update(canonicalWorkspaceSnapshot(value)).digest('hex');

export function validateBriefCommand(
  tenantId: string,
  draftId: string,
  actorId: string,
  input: ProspectBriefCommandDto,
) {
  if (
    ![tenantId, draftId, input.requestId].every((id) => typeof id === 'string' && UUID.test(id)) ||
    typeof actorId !== 'string' ||
    !actorId ||
    actorId.length > 200 ||
    typeof input.expectedStateHash !== 'string' ||
    !/^[0-9a-f]{64}$/.test(input.expectedStateHash) ||
    !Object.prototype.hasOwnProperty.call(input, 'expectedClientId') ||
    (input.expectedClientId !== null && !UUID.test(input.expectedClientId))
  )
    throw new BadRequestException('Invalid prospect brief command');
}

/** Preserve complete ordered JSON, including photo/table/logo payload fields.
 * No HTML rendering, conversion or generated content occurs on save. */
export function validateBriefCopyEdit(input: SaveProspectBriefCopyDto) {
  let nodes = 0;
  function json(value: unknown, depth: number): void {
    if (++nodes > 100000 || depth > 32)
      throw new BadRequestException('Document JSON is too complex');
    if (value === null || typeof value === 'boolean' || typeof value === 'string') return;
    if (typeof value === 'number' && Number.isFinite(value)) return;
    if (Array.isArray(value)) {
      for (const v of value) json(v, depth + 1);
      return;
    }
    if (
      typeof value === 'object' &&
      value &&
      [Object.prototype, null].includes(Object.getPrototypeOf(value))
    ) {
      for (const [k, v] of Object.entries(value)) {
        if (['__proto__', 'prototype', 'constructor'].includes(k))
          throw new BadRequestException('Invalid document JSON key');
        json(v, depth + 1);
      }
      return;
    }
    throw new BadRequestException('Document must contain JSON values');
  }
  json(input.body, 0);
  const blocks = input.body?.blocks;
  if (
    !input.body ||
    Array.isArray(input.body) ||
    !Array.isArray(blocks) ||
    blocks.length > 1000 ||
    Buffer.byteLength(canonicalWorkspaceSnapshot(input.body)) > 4_000_000
  )
    throw new BadRequestException('Document requires at most 1000 blocks and 4MB JSON');
  const ids = new Set<string>();
  for (const b of blocks) {
    if (
      !b ||
      typeof b !== 'object' ||
      Array.isArray(b) ||
      typeof b.id !== 'string' ||
      !b.id ||
      b.id.length > 64 ||
      ids.has(b.id) ||
      !['section', 'photo', 'table', 'logo'].includes(b.type) ||
      (b.title !== undefined && typeof b.title !== 'string') ||
      (b.content !== undefined && typeof b.content !== 'string')
    )
      throw new BadRequestException('Invalid ordered document block');
    ids.add(b.id);
  }
  if (
    (input.name !== undefined &&
      (typeof input.name !== 'string' || !input.name || input.name.length > 300)) ||
    (input.docTitle !== undefined &&
      (typeof input.docTitle !== 'string' || !input.docTitle || input.docTitle.length > 500)) ||
    (input.label !== undefined && (typeof input.label !== 'string' || input.label.length > 300)) ||
    (input.ordinal !== undefined &&
      (!Number.isSafeInteger(input.ordinal) || input.ordinal < 0 || input.ordinal > 100000))
  )
    throw new BadRequestException('Invalid document edit metadata');
}

export function importedBriefBody(source: {
  source: ProspectBriefVersionIdentity;
  sections: unknown;
  citations: unknown;
  sourceSnapshot: unknown;
}) {
  const sections = source.sections as Record<
    string,
    { text: string; provenance: string; citationIndexes: number[] }
  >;
  const keys = Object.keys(briefSectionLabels);
  if (
    !sections ||
    typeof sections !== 'object' ||
    Array.isArray(sections) ||
    Object.keys(sections).sort().join() !== keys.sort().join() ||
    !Array.isArray(source.citations) ||
    source.citations.length > 12 ||
    stateHash(source.sections) !== source.source.sectionsHash ||
    stateHash(source.sourceSnapshot) !== source.source.snapshotHash
  )
    throw new NotFoundException('Saved brief source unavailable');
  const escape = (text: string) =>
    text
      .replace(
        /[&<>"']/g,
        (c) =>
          ({
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#39;',
          })[c]!,
      )
      .replace(/\r\n|\r|\n/g, '<br/>');
  return {
    blocks: Object.entries(briefSectionLabels).map(([key, title]) => {
      const s = sections[key];
      if (
        !s ||
        Object.keys(s).sort().join() !== 'citationIndexes,provenance,text' ||
        typeof s.text !== 'string' ||
        !s.text ||
        s.text.length > 4000 ||
        !['generated', 'edited'].includes(s.provenance) ||
        !Array.isArray(s.citationIndexes) ||
        s.citationIndexes.length > 12 ||
        s.citationIndexes.some(
          (i) => !Number.isInteger(i) || i < 0 || i >= (source.citations as unknown[]).length,
        )
      )
        throw new NotFoundException('Saved brief source unavailable');
      return {
        id: `core-brief-${key}`,
        type: 'section' as const,
        title,
        content: `<p>${escape(s.text)}</p>`,
      };
    }),
  };
}
