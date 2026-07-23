import { describe, expect, it } from '@jest/globals';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateNodeDto, UpdateNodeDto } from './node.dto.js';

async function errorsFor<T extends object>(cls: new () => T, payload: unknown): Promise<string[]> {
  const dto = plainToInstance(cls, payload);
  const errors = await validate(dto as object, { whitelist: true });
  return errors.map((e) => e.property);
}

describe('CreateNodeDto', () => {
  const valid = {
    kind: 'action',
    subject: 'deliverable',
    title: 'Submit the FY27 request',
    startsOn: '2027-02-06',
  };

  it('accepts a well-formed node', async () => {
    expect(await errorsFor(CreateNodeDto, valid)).toEqual([]);
  });

  it('rejects an unknown kind', async () => {
    expect(await errorsFor(CreateNodeDto, { ...valid, kind: 'task' })).toContain('kind');
  });

  it('rejects an unknown subject', async () => {
    expect(await errorsFor(CreateNodeDto, { ...valid, subject: 'thing' })).toContain('subject');
  });

  it('rejects a non-ISO startsOn', async () => {
    expect(await errorsFor(CreateNodeDto, { ...valid, startsOn: '02/06/2027' })).toContain(
      'startsOn',
    );
  });

  it('rejects a missing title', async () => {
    const { title: _omit, ...rest } = valid;
    expect(await errorsFor(CreateNodeDto, rest)).toContain('title');
  });
});

describe('UpdateNodeDto', () => {
  it('accepts a changeNote-only patch', async () => {
    expect(await errorsFor(UpdateNodeDto, { changeNote: 'Pushed one quarter.' })).toEqual([]);
  });

  it('accepts nulling a nullable field', async () => {
    expect(await errorsFor(UpdateNodeDto, { note: null, endsOn: null })).toEqual([]);
  });

  it('rejects an unknown status', async () => {
    expect(await errorsFor(UpdateNodeDto, { status: 'done' })).toContain('status');
  });

  it('rejects a malformed endsOn', async () => {
    expect(await errorsFor(UpdateNodeDto, { endsOn: '2027/02/06' })).toContain('endsOn');
  });
});
