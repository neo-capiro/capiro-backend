import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

/**
 * Controller DTO validation coverage for the Advocacy Matter write surface.
 * The regression this guards: the edit form renders legacy Matter statuses
 * ('open'/'resolved'/'stalled', still valid at the DB layer per migration
 * 20271231050000) as selectable "(legacy)" options and submits them back
 * unchanged on an ordinary edit — an @IsIn restricted to the new lifecycle
 * set rejected every save of a legacy Matter with a 400. The DTO must
 * accept both sets at the API boundary; the lifecycle-vs-legacy semantics
 * live in the service.
 *
 * These are true validation-pipe tests (class-validator `validate` on the
 * real DTO classes), not mocks — a decorator change that drops a status
 * fails here directly.
 */

// The DTO classes are module-private to the controller file; re-declaring
// the validation contract here would test a copy, not the real thing.
// Instead we import the controller module and pull the DTO prototypes off
// its metadata — NestJS stores design:paramtypes per method, and the PATCH
// handler's body param is UpdateAdvocacyMatterDto.
import { ClientAdvocacyMatterController } from './client-advocacy-matter.controller.js';

function dtoInstanceFor(methodName: string, body: unknown): object {
  const types: unknown[] = Reflect.getMetadata(
    'design:paramtypes',
    ClientAdvocacyMatterController.prototype,
    methodName,
  );
  const DtoClass = types[types.length - 1] as new () => object;
  return plainToInstance(DtoClass, body);
}

describe('ClientAdvocacyMatterController DTO validation', () => {
  describe('UpdateAdvocacyMatterDto (PATCH :matterId)', () => {
    test.each(['planning', 'active', 'monitoring', 'outcome_observed', 'successful', 'partially_successful', 'unsuccessful', 'withdrawn', 'archived'])(
      'accepts lifecycle status %s',
      async (status) => {
        const errors = await validate(dtoInstanceFor('update', { status }));
        expect(errors).toHaveLength(0);
      },
    );

    test.each(['open', 'resolved', 'stalled'])(
      'accepts legacy status %s (still valid on pre-existing rows)',
      async (status) => {
        const errors = await validate(dtoInstanceFor('update', { status }));
        expect(errors).toHaveLength(0);
      },
    );

    test('rejects an unknown status', async () => {
      const errors = await validate(dtoInstanceFor('update', { status: 'magnificent' }));
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0]!.property).toBe('status');
    });

    test('accepts an empty body (pure metadata-less PATCH)', async () => {
      const errors = await validate(dtoInstanceFor('update', {}));
      expect(errors).toHaveLength(0);
    });
  });

  describe('MergeAdvocacyMatterDto (POST :matterId/merge)', () => {
    test('rejects a non-UUID sourceMatterId', async () => {
      const errors = await validate(dtoInstanceFor('merge', { sourceMatterId: 'not-a-uuid' }));
      expect(errors.length).toBeGreaterThan(0);
    });

    test('accepts a UUID sourceMatterId', async () => {
      const errors = await validate(
        dtoInstanceFor('merge', { sourceMatterId: '33333333-3333-4333-8333-333333333333' }),
      );
      expect(errors).toHaveLength(0);
    });
  });
});
