import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const source = (name: string) =>
  readFileSync(resolve(process.cwd(), `src/research-portfolios/${name}`), 'utf8');

describe('Research Portfolios Phase 1 route ownership', () => {
  it('registers the module only in the main API', () => {
    const appModule = readFileSync(resolve(process.cwd(), 'src/app.module.ts'), 'utf8');
    expect(appModule).toContain("import { ResearchPortfoliosModule } from './research-portfolios/research-portfolios.module.js';");
    expect(appModule).toMatch(/imports:\s*\[[\s\S]*ResearchPortfoliosModule/);
  });

  it('exposes the complete Phase 1 manual route set', () => {
    const controller = source('research-portfolios.controller.ts');
    for (const decorator of [
      '@Get()', '@Post()', "@Get(':id')", "@Patch(':id')", "@Post(':id/archive')",
      "@Post(':id/restore')", "@Get(':id/grants')", "@Put(':id/grants/:principalId')",
      "@Delete(':id/grants/:principalId')", "@Get(':id/client-links')",
      "@Post(':id/client-links')", "@Delete(':id/client-links/:clientId')",
      "@Get(':id/members')", "@Post(':id/members')", "@Post(':id/members/decisions')",
      "@Post(':id/members/:memberId/resolve')",
      "@Post('templates/:templateId/versions')",
    ]) {
      expect(controller).toContain(decorator);
    }
  });

  it('reserves templates/taxonomy before dynamic IDs and keeps delete receipts explicit', () => {
    const controller = source('research-portfolios.controller.ts');
    expect(controller).toContain("new Set(['templates', 'taxonomy'])");
    expect(controller).not.toContain('ParseUUIDPipe');
    expect(controller.match(/@Delete\([^)]*\)[\s\S]*?@Body\(\) dto/g)?.length).toBe(2);
  });
});
