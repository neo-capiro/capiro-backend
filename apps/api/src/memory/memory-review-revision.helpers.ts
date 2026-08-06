import { BadRequestException } from '@nestjs/common';
import type { MemorySection } from './memory.types.js';

const MAX_SECTIONS = 50;
const MAX_SECTION_BODY_CHARS = 50_000;
const MAX_TOTAL_BODY_CHARS = 200_000;
const MAX_VALUE_CHARS = 200_000;

export interface MemoryReviewRevisionInput {
  value?: unknown;
  sections?: unknown;
}

export interface PreparedMemoryReviewRevision {
  payload: Record<string, unknown>;
  changed: true;
  revisionSummary: {
    valueChanged: boolean;
    sectionBodiesChanged: number;
  };
}

export function prepareMemoryReviewRevision(
  sourceKind: string,
  existingPayload: unknown,
  input: MemoryReviewRevisionInput,
): PreparedMemoryReviewRevision {
  const payload = objectRecord(existingPayload, 'The memory proposal payload is invalid.');
  const existingValue = typeof payload.value === 'string' ? payload.value : null;
  const canonical = nullableObjectRecord(payload.canonicalItem);
  const existingSections = canonical ? parseExistingSections(canonical.sections) : null;

  const hasValue = input.value !== undefined;
  const hasSections = input.sections !== undefined;
  if (!hasValue && !hasSections) {
    throw new BadRequestException('A revised value or revised sections are required.');
  }
  if (canonical && hasValue) {
    throw new BadRequestException(
      'Canonical memory revisions accept only the complete section set.',
    );
  }

  let nextSections: MemorySection[] | null = null;
  let sectionBodiesChanged = 0;
  if (hasSections) {
    if (!canonical || !existingSections) {
      throw new BadRequestException('This proposal does not support section-based revision.');
    }
    nextSections = validateRevisedSections(input.sections, existingSections);
    sectionBodiesChanged = existingSections.reduce(
      (count, section, index) => count + (section.body !== nextSections?.[index]?.body ? 1 : 0),
      0,
    );
  } else if (canonical) {
    throw new BadRequestException(
      'Canonical memory must be revised by submitting its complete section set.',
    );
  }

  let nextValue = existingValue;
  if (nextSections) {
    nextValue = valueForSections(sourceKind, nextSections);
  } else if (hasValue) {
    if (typeof input.value !== 'string') {
      throw new BadRequestException('Revised memory value must be text.');
    }
    nextValue = input.value.trim();
    if (!nextValue) throw new BadRequestException('Revised memory value cannot be empty.');
    if (nextValue.length > MAX_VALUE_CHARS) {
      throw new BadRequestException('Revised memory value is too large.');
    }
  }

  const valueChanged = nextValue !== existingValue;
  if (!valueChanged && sectionBodiesChanged === 0) {
    throw new BadRequestException('The revised proposal is identical to the prior revision.');
  }

  return {
    payload: {
      ...payload,
      ...(nextValue !== null ? { value: nextValue } : {}),
      ...(canonical && nextSections
        ? {
            canonicalItem: {
              ...canonical,
              sections: nextSections,
            },
          }
        : {}),
    },
    changed: true,
    revisionSummary: { valueChanged, sectionBodiesChanged },
  };
}

function validateRevisedSections(
  value: unknown,
  existing: MemorySection[],
): MemorySection[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_SECTIONS) {
    throw new BadRequestException('Revised sections must be a non-empty bounded list.');
  }
  if (value.length !== existing.length) {
    throw new BadRequestException('A revision must preserve the complete section structure.');
  }

  let totalChars = 0;
  return value.map((entry, index) => {
    const source = existing[index];
    const section = objectRecord(entry, 'Each revised section must be an object.');
    if (!source) throw new BadRequestException('Revision section structure is invalid.');
    if (
      section.key !== source.key ||
      section.heading !== source.heading ||
      section.owner !== source.owner
    ) {
      throw new BadRequestException(
        'A revision may change section content but not section identity or ownership.',
      );
    }
    if (typeof section.body !== 'string') {
      throw new BadRequestException('Each revised section body must be text.');
    }
    const body = section.body.trim();
    if (body.length > MAX_SECTION_BODY_CHARS) {
      throw new BadRequestException('A revised section body is too large.');
    }
    totalChars += body.length;
    if (totalChars > MAX_TOTAL_BODY_CHARS) {
      throw new BadRequestException('The revised memory proposal is too large.');
    }
    return {
      key: source.key,
      heading: source.heading,
      owner: source.owner,
      body,
    };
  });
}

function parseExistingSections(value: unknown): MemorySection[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_SECTIONS) return null;
  const sections: MemorySection[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
    const section = entry as Record<string, unknown>;
    if (
      typeof section.key !== 'string' ||
      typeof section.heading !== 'string' ||
      (section.owner !== 'human' && section.owner !== 'engine') ||
      typeof section.body !== 'string'
    ) {
      return null;
    }
    sections.push({
      key: section.key,
      heading: section.heading,
      owner: section.owner,
      body: section.body,
    });
  }
  return sections;
}

function valueForSections(sourceKind: string, sections: MemorySection[]): string {
  if (sourceKind === 'settings_sections') return JSON.stringify(sections);
  return sections.map((section) => section.body).join('\n\n');
}

function objectRecord(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new BadRequestException(message);
  }
  return value as Record<string, unknown>;
}

function nullableObjectRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}
