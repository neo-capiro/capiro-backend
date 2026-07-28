import fs from 'node:fs';

const file = 'apps/api/src/meri/meri-tools.service.ts';
let source = fs.readFileSync(file, 'utf8');

function replaceOnce(search, replacement) {
  if (!source.includes(search)) throw new Error(`Expected MeriToolsService anchor not found: ${search.slice(0, 120)}`);
  source = source.replace(search, replacement);
}

replaceOnce(
  `import { MeriFeatureFlagsService } from './meri-feature-flags.service.js';\n`,
  `import { MeriFeatureFlagsService } from './meri-feature-flags.service.js';\nimport {\n  validateMeriWriteToolInput,\n  type MeriJsonSchema,\n} from './meri-write-tool-input.js';\n`,
);

replaceOnce(
  `  isSideEffecting(name: string): boolean {\n    return SIDE_EFFECTING_TOOLS.has(name);\n  }\n`,
  `  isSideEffecting(name: string): boolean {\n    return SIDE_EFFECTING_TOOLS.has(name);\n  }\n\n  /**\n   * Canonical parser shared by proposal creation and actual delegated execution.\n   * It rejects unknown/internal authority fields before either persistence or use.\n   */\n  validateSideEffectingInput(name: string, rawInput: unknown): Record<string, unknown> {\n    const normalizedName = normalizeToolName(name);\n    if (!this.isSideEffecting(normalizedName)) {\n      throw new BadRequestException(\`\${normalizedName} is not a side-effecting Meri tool\`);\n    }\n    const definition = this.anthropicToolSchemas().find((tool) => tool.name === normalizedName);\n    if (!definition) throw new BadRequestException(\`Unknown Meri tool: \${normalizedName}\`);\n    return validateMeriWriteToolInput(\n      normalizedName,\n      rawInput,\n      definition.input_schema as MeriJsonSchema,\n    );\n  }\n`,
);

replaceOnce(
  `  executeFromAuthenticatedUser(ctx: TenantContext, rawName: string, rawInput: unknown) {\n    return this.execute(ctx, normalizeToolName(rawName), objectInput(rawInput));\n  }\n`,
  `  executeFromAuthenticatedUser(ctx: TenantContext, rawName: string, rawInput: unknown) {\n    const name = normalizeToolName(rawName);\n    const input = this.isSideEffecting(name)\n      ? this.validateSideEffectingInput(name, rawInput)\n      : objectInput(rawInput);\n    return this.execute(ctx, name, input);\n  }\n`,
);

fs.writeFileSync(file, source);
console.log('MeriToolsService proposal/execution parser wiring applied.');
