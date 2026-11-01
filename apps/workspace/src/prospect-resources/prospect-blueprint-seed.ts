import { ConflictException } from '@nestjs/common';
import { parseWorkspaceBlueprintDefinition } from '@capiro/shared/workspace-template-studio';
import { TemplateValidator } from '../template-studio/template-validator.js';

/** Seed an empty manual section projection; instructions are never presented as generated content. */
export function prospectBlueprintSections(definition: unknown, definitionHash: string) {
  const parsed = parseWorkspaceBlueprintDefinition(definition);
  if (
    !parsed.ok ||
    parsed.value.sections.length < 1 ||
    parsed.value.sections.length > 100 ||
    parsed.value.sections.some(section => section.id.length > 300) ||
    new TemplateValidator().computeDefinitionHash(parsed.value) !== definitionHash
  )
    throw new ConflictException(
      'The published blueprint cannot provide a verified bounded section outline',
    );
  // Ordinals keep duplicate/truncated titles distinct. Original section IDs
  // remain separately bound to the immutable definition for later generation.
  const sections = parsed.value.sections.map((section, index) =>
    `${index + 1}. ${section.title}`.slice(0, 300),
  );
  return {
    sections,
    sectionContent: Object.fromEntries(sections.map((name) => [name, ''])),
    blueprintSectionIds: Object.fromEntries(
      sections.map((name, index) => [name, parsed.value.sections[index]!.id]),
    ),
  };
}
