import { Readable } from 'node:stream';
import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { PLANNER_ATTACHMENT_LIMIT, type PlannerFormUpload } from './planner-files.js';
import {
  plannerFormAnswers,
  plannerFormFiles,
  plannerFormMemoryStorage,
} from './planner-form-upload.js';
import { PlannerFormFilesService } from './planner-form-files.service.js';
import type { PlannerFormData } from '@capiro/strategy-verifier';

const file = (name = 'notes.txt'): PlannerFormUpload => ({
  fieldname: 'files',
  originalname: name,
  buffer: Buffer.from('synthetic'),
  size: 9,
});
const config = {
  fields: [
    { id: 'choice', type: 'select', options: ['Yes', 'No'] },
    { id: 'files', type: 'attachment', showWhen: { questionId: 'choice', values: ['Yes'] } },
  ],
} as PlannerFormData;
describe('Planner form upload boundaries', () => {
  it('parses multipart answers and rejects malformed or injected multipart properties', () => {
    expect(plannerFormAnswers({ answers: '{"choice":"Yes"}' })).toEqual({ choice: 'Yes' });
    expect(plannerFormAnswers({ choice: 'No' })).toEqual({ choice: 'No' });
    for (const raw of [{ answers: '[]' }, { answers: '{' }, { answers: '{}', tenantId: 'other' }])
      expect(() => plannerFormAnswers(raw)).toThrow();
  });
  it('drops hidden uploads but rejects unknown questions and dishonest file metadata', () => {
    expect(plannerFormFiles(config, { choice: 'No' }, [file()])).toEqual([]);
    expect(plannerFormFiles(config, { choice: 'Yes' }, [file()])).toHaveLength(1);
    for (const upload of [
      { ...file(), fieldname: 'unknown' },
      { ...file(), size: 2 },
      file('../secret.txt'),
    ])
      expect(() => plannerFormFiles(config, { choice: 'Yes' }, [upload])).toThrow();
  });
  it('bounds aggregate memory as concurrent file streams arrive', async () => {
    const storage = plannerFormMemoryStorage(),
      request = {};
    const save = (buffer: Buffer) =>
      new Promise<{ size: number; buffer: Buffer }>((resolve, reject) =>
        storage._handleFile(request, { stream: Readable.from([buffer]) }, (error, result) =>
          error ? reject(error) : resolve(result!),
        ),
      );
    const first = await save(Buffer.alloc(13 * 1024 * 1024));
    expect(first.size).toBe(13 * 1024 * 1024);
    await expect(save(Buffer.alloc(13 * 1024 * 1024))).rejects.toMatchObject({ status: 413 });
    await expect(
      new Promise((resolve, reject) =>
        storage._handleFile(
          {},
          { stream: Readable.from([Buffer.alloc(PLANNER_ATTACHMENT_LIMIT + 1)]) },
          (error, result) => (error ? reject(error) : resolve(result)),
        ),
      ),
    ).rejects.toMatchObject({ status: 413 });
  });
});
describe('Planner intake private storage', () => {
  const priorBucket = process.env.ASSETS_BUCKET;
  let send: jest.SpyInstance;
  beforeEach(() => {
    process.env.ASSETS_BUCKET = 'synthetic-planner-qa';
    send = jest.spyOn(S3Client.prototype, 'send').mockResolvedValue({} as never);
  });
  afterEach(() => {
    send.mockRestore();
    if (priorBucket === undefined) delete process.env.ASSETS_BUCKET;
    else process.env.ASSETS_BUCKET = priorBucket;
  });
  it('uses only the existing private tenant/task prefix and never exposes public storage URLs', async () => {
    const service = new PlannerFormFilesService();
    const prepared = await service.prepare('tenant-synthetic', 'task-synthetic', [file()]);
    expect(prepared[0]?.objectKey).toMatch(
      /^tenants\/tenant-synthetic\/planner\/tasks\/task-synthetic\//,
    );
    const command = send.mock.calls[0]?.[0];
    expect(command).toBeInstanceOf(PutObjectCommand);
    expect(command.input).toMatchObject({
      ContentType: 'application/octet-stream',
      Body: Buffer.from('synthetic'),
    });
    expect(command.input).not.toHaveProperty('ACL');
  });
  it('cleans both completed and uncertain uploads after a partial storage failure', async () => {
    send.mockImplementation(async (command) => {
      if (
        command instanceof PutObjectCommand &&
        send.mock.calls.filter(([c]) => c instanceof PutObjectCommand).length === 2
      )
        throw new Error('Synthetic storage failure');
      return {};
    });
    await expect(
      new PlannerFormFilesService().prepare('tenant-synthetic', 'task-synthetic', [
        file(),
        file('second.txt'),
      ]),
    ).rejects.toThrow('Synthetic storage failure');
    const puts = send.mock.calls
      .filter(([command]) => command instanceof PutObjectCommand)
      .map(([command]) => command.input.Key);
    const deletes = send.mock.calls
      .filter(([command]) => command instanceof DeleteObjectCommand)
      .map(([command]) => command.input.Key);
    expect(deletes).toEqual(puts);
  });
});
