import { describe, expect, it } from '@jest/globals';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateArtifactDto } from './artifact.dto.js';

async function errorsFor(payload: unknown): Promise<string[]> {
  const dto = plainToInstance(CreateArtifactDto, payload);
  const errors = await validate(dto as object, { whitelist: true });
  return errors.map((e) => e.property);
}

describe('CreateArtifactDto', () => {
  it('accepts a workspace_draft back-link', async () => {
    expect(await errorsFor({ artifactType: 'workspace_draft', artifactRef: 'ws-123' })).toEqual([]);
  });

  it('accepts an outreach_record back-link', async () => {
    expect(await errorsFor({ artifactType: 'outreach_record', artifactRef: 'or-456' })).toEqual([]);
  });

  it('rejects an unknown artifactType', async () => {
    expect(await errorsFor({ artifactType: 'meeting', artifactRef: 'x' })).toContain('artifactType');
  });

  it('rejects an empty artifactRef', async () => {
    expect(await errorsFor({ artifactType: 'workspace_draft', artifactRef: '' })).toContain(
      'artifactRef',
    );
  });

  it('rejects a missing artifactRef', async () => {
    expect(await errorsFor({ artifactType: 'workspace_draft' })).toContain('artifactRef');
  });
});
