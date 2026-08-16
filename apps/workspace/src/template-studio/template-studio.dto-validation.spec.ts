import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Regression for the New-blueprint 400:
 *   property slug should not exist
 *   property product should not exist
 *   property description should not exist
 *   property scope should not exist
 *
 * Root cause: the controller used `import type { CreateBlueprintDto, ... }`,
 * which erases the class constructors at runtime. Nest's ValidationPipe then
 * has no @Body() metatype, and with forbidNonWhitelisted:true every legitimate
 * field is rejected as unknown.
 *
 * We lock the controller source shape rather than spinning ValidationPipe here:
 * workspace Jest's relative-*.js mapper breaks class-validator's dependency
 * chain (libphonenumber-js), so a full pipe test is unreliable in this package.
 */
function controllerSource(): string {
  return readFileSync(
    join(process.cwd(), 'src/template-studio/template-studio.controller.ts'),
    'utf8',
  );
}

function dtoSource(): string {
  return readFileSync(
    join(process.cwd(), 'src/template-studio/dto/template-studio.dto.ts'),
    'utf8',
  );
}

/** Collect import blocks from `./dto/template-studio.dto.js` only. */
function dtoImportBlocks(src: string): Array<{ kind: 'value' | 'type'; names: string[] }> {
  const blocks: Array<{ kind: 'value' | 'type'; names: string[] }> = [];
  const re =
    /import\s+(type\s+)?\{([^}]+)\}\s*from\s*'\.\/dto\/template-studio\.dto\.js'/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const kind = m[1] ? 'type' : 'value';
    const body = m[2] ?? '';
    const names = body
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => s.replace(/\s+as\s+\w+$/, ''));
    blocks.push({ kind, names });
  }
  return blocks;
}

describe('Template Studio create-blueprint DTO metatype (import type erasure)', () => {
  it('keeps body DTO classes as runtime value imports in the controller', () => {
    const src = controllerSource();
    const blocks = dtoImportBlocks(src);
    expect(blocks.length).toBeGreaterThan(0);

    const valueNames = new Set(blocks.filter((b) => b.kind === 'value').flatMap((b) => b.names));
    const typeNames = new Set(blocks.filter((b) => b.kind === 'type').flatMap((b) => b.names));

    for (const name of [
      'CreateBlueprintDto',
      'CreateVersionDto',
      'UpdateVersionDto',
      'CloneBlueprintDto',
      'TestVersionDto',
    ]) {
      expect(valueNames.has(name)).toBe(true);
      // Must NOT be type-only (the erasure bug).
      expect(typeNames.has(name)).toBe(false);
    }

    // Pure interface — type-only is correct and required.
    expect(typeNames.has('CompareVersionsResult')).toBe(true);
    expect(valueNames.has('CompareVersionsResult')).toBe(false);
  });

  it('CreateBlueprintDto still declares the New-blueprint body fields', () => {
    const src = dtoSource();
    const m = src.match(/export class CreateBlueprintDto \{([\s\S]*?)\n\}/);
    expect(m).toBeTruthy();
    const body = m![1];
    for (const field of ['slug', 'name', 'product', 'description', 'scope']) {
      expect(body).toContain(field);
    }
  });
});
