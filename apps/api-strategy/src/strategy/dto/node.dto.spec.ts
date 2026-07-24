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

  describe('dependsOnIds (A2)', () => {
    const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

    it('accepts a well-formed array of UUIDs', async () => {
      expect(
        await errorsFor(CreateNodeDto, { ...valid, dependsOnIds: [uuid(1), uuid(2)] }),
      ).toEqual([]);
    });

    it('accepts an omitted dependsOnIds (optional)', async () => {
      expect(await errorsFor(CreateNodeDto, valid)).toEqual([]);
    });

    it('accepts exactly 20 ids (the ArrayMaxSize boundary)', async () => {
      const ids = Array.from({ length: 20 }, (_, i) => uuid(i));
      expect(await errorsFor(CreateNodeDto, { ...valid, dependsOnIds: ids })).toEqual([]);
    });

    it('rejects 21 ids (one over the ArrayMaxSize boundary)', async () => {
      const ids = Array.from({ length: 21 }, (_, i) => uuid(i));
      expect(await errorsFor(CreateNodeDto, { ...valid, dependsOnIds: ids })).toContain(
        'dependsOnIds',
      );
    });

    it('rejects a non-UUID string in the array', async () => {
      expect(
        await errorsFor(CreateNodeDto, { ...valid, dependsOnIds: ['not-a-uuid'] }),
      ).toContain('dependsOnIds');
    });

    it('rejects dependsOnIds sent as a non-array (e.g. a bare string)', async () => {
      expect(
        await errorsFor(CreateNodeDto, { ...valid, dependsOnIds: uuid(1) }),
      ).toContain('dependsOnIds');
    });
  });

  describe('targetRef', () => {
    it('accepts a well-formed target', async () => {
      expect(
        await errorsFor(CreateNodeDto, {
          ...valid,
          subject: 'member',
          targetRef: { memberId: 'M000123', memberName: 'Rep. Jane Doe', party: 'D' },
        }),
      ).toEqual([]);
    });

    it('accepts an omitted targetRef (optional)', async () => {
      expect(await errorsFor(CreateNodeDto, valid)).toEqual([]);
    });

    it('rejects a targetRef missing memberId', async () => {
      expect(
        await errorsFor(CreateNodeDto, { ...valid, targetRef: { memberName: 'Rep. Jane Doe' } }),
      ).toContain('targetRef');
    });

    it('rejects an unknown sourceDirectory', async () => {
      expect(
        await errorsFor(CreateNodeDto, {
          ...valid,
          targetRef: { memberId: 'M000123', sourceDirectory: 'made-up' },
        }),
      ).toContain('targetRef');
    });
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

  describe('dependsOnIds (A2)', () => {
    const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

    it('accepts replacing the edge set with well-formed UUIDs', async () => {
      expect(await errorsFor(UpdateNodeDto, { dependsOnIds: [uuid(1)] })).toEqual([]);
    });

    it('accepts an explicit empty array (clears all edges)', async () => {
      expect(await errorsFor(UpdateNodeDto, { dependsOnIds: [] })).toEqual([]);
    });

    it('rejects 21 ids (one over the ArrayMaxSize boundary)', async () => {
      const ids = Array.from({ length: 21 }, (_, i) => uuid(i));
      expect(await errorsFor(UpdateNodeDto, { dependsOnIds: ids })).toContain('dependsOnIds');
    });

    it('rejects a non-UUID string in the array', async () => {
      expect(await errorsFor(UpdateNodeDto, { dependsOnIds: ['not-a-uuid'] })).toContain(
        'dependsOnIds',
      );
    });
  });

  describe('targetRef', () => {
    it('accepts setting a well-formed target', async () => {
      expect(
        await errorsFor(UpdateNodeDto, { targetRef: { memberId: 'M000123' } }),
      ).toEqual([]);
    });

    it('accepts nulling targetRef (clears it)', async () => {
      expect(await errorsFor(UpdateNodeDto, { targetRef: null })).toEqual([]);
    });

    it('rejects a targetRef missing memberId', async () => {
      expect(await errorsFor(UpdateNodeDto, { targetRef: { memberName: 'Rep. Doe' } })).toContain(
        'targetRef',
      );
    });
  });
});
