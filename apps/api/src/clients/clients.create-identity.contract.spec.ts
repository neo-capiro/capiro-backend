import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { ClientsController } from './clients.controller.js';

const canonicalEntityId = '10000000-0000-4000-8000-000000000020';
const createDto = Reflect.getMetadata(
  'design:paramtypes',
  ClientsController.prototype,
  'create',
)[1];
const updateDto = Reflect.getMetadata(
  'design:paramtypes',
  ClientsController.prototype,
  'update',
)[2];
const pipe = new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true });
const create = (body: Record<string, unknown>) =>
  pipe.transform(body, { type: 'body', metatype: createDto });

describe('client creation confirmed identity admission', () => {
  test('admits the actual automated profile payload and preserves the confirmed identity', async () => {
    const body = {
      name: 'Synthetic Client',
      website: 'https://example.test',
      canonicalEntityId,
      profileType: 'CLIENT',
      profileStatus: 'ACTIVE',
    };
    await expect(create(body)).resolves.toMatchObject(body);
  });
  test('still admits a separate profile without a canonical identity', async () => {
    await expect(create({ name: 'Synthetic Separate Client' })).resolves.toMatchObject({
      name: 'Synthetic Separate Client',
    });
  });
  test('rejects malformed canonical identities by UUID validation', async () => {
    await expect(
      create({ name: 'Synthetic Client', canonicalEntityId: 'not-a-uuid' }),
    ).rejects.toMatchObject({ response: { message: ['canonicalEntityId must be a UUID'] } });
  });
  test('still rejects unrelated unrecognized properties', async () => {
    await expect(
      create({ name: 'Synthetic Client', tenantOverride: canonicalEntityId }),
    ).rejects.toMatchObject({
      response: { message: ['property tenantOverride should not exist'] },
    });
  });
  test('preserves valid CSV bulk import without identity bindings', async () => {
    const bulkDto = Reflect.getMetadata(
      'design:paramtypes',
      ClientsController.prototype,
      'bulkImport',
    )[1];
    const body = { rows: [{ name: 'Synthetic Client', website: 'https://example.test' }] };
    await expect(pipe.transform(body, { type: 'body', metatype: bulkDto })).resolves.toMatchObject(
      body,
    );
  });
  test('does not silently admit canonical identities through CSV bulk import', async () => {
    const bulkDto = Reflect.getMetadata(
      'design:paramtypes',
      ClientsController.prototype,
      'bulkImport',
    )[1];
    await expect(
      pipe.transform(
        { rows: [{ name: 'Synthetic Client', canonicalEntityId }] },
        { type: 'body', metatype: bulkDto },
      ),
    ).rejects.toMatchObject({
      response: { message: ['rows.0.property canonicalEntityId should not exist'] },
    });
  });
  test('does not permit canonical identity reassignment through ordinary updates', async () => {
    await expect(
      pipe.transform(
        { name: 'Synthetic Client', canonicalEntityId },
        { type: 'body', metatype: updateDto },
      ),
    ).rejects.toMatchObject({
      response: { message: ['property canonicalEntityId should not exist'] },
    });
  });
});
