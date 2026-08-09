import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function apiRoot(): string {
  const cwd = process.cwd();
  if (existsSync(resolve(cwd, 'src/outreach-v3'))) return cwd;
  return resolve(cwd, 'apps/api');
}

const provider = readFileSync(
  resolve(apiRoot(), 'src/outreach-v3/reasoning/openai-outreach-reasoning.provider.ts'),
  'utf8',
);

describe('Outreach V3 stateless reasoning continuity', () => {
  it('requests encrypted reasoning content when using a reasoning model with store=false', () => {
    // OpenAI's stateless reasoning contract requires encrypted reasoning items
    // to be included when reasoning state must be carried across tool-call
    // rounds without provider storage. Do not weaken/delete this assertion;
    // update the provider body to request reasoning.encrypted_content and keep
    // returned reasoning items transient in memory only.
    expect(provider).toContain('reasoning.encrypted_content');
    expect(provider).toMatch(/include\s*=/);
  });

  it('never writes encrypted reasoning content to Capiro persistence', () => {
    const repo = readFileSync(
      resolve(apiRoot(), 'src/outreach-v3/reasoning/outreach-reasoning.repository.ts'),
      'utf8',
    );
    expect(repo).not.toContain('encrypted_content');
    expect(repo).not.toContain('encryptedContent');
  });
});
