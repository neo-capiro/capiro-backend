import { CLIENT_QUERY_RELATIONS } from './client-query-projections.js';

describe('fixed client Objective and recorded-activity query projections', () => {
  const [objectives, activity] = CLIENT_QUERY_RELATIONS;
  const names = (relation: typeof objectives) => relation!.fields.map((field) => field.name);

  it('publishes the complete Objective business projection without operational state', () => {
    expect(names(objectives)).toEqual([
      'id',
      'client_id',
      'request_id',
      'outcome',
      'government_problem',
      'ask_type',
      'minimum_win',
      'limits',
      'owner_user_id',
      'created_by_user_id',
      'status',
      'version',
      'ready_at',
      'review_requested_at',
      'created_at',
      'updated_at',
      'readiness_outcome',
      'readiness_government_problem',
      'readiness_ask_type',
      'readiness_minimum_win',
      'readiness_completed_fields',
      'readiness_required_fields',
      'readiness_is_ready',
    ]);
    expect(objectives!.fields.find((field) => field.name === 'version')).toMatchObject({
      type: 'integer',
      nullable: false,
    });
    expect(objectives!.fields.filter((field) => field.nullable).map((field) => field.name)).toEqual(
      ['ask_type', 'owner_user_id', 'ready_at', 'review_requested_at'],
    );
  });

  it('preserves activity text/nulls/attribution and exposes only validated scalar details', () => {
    expect(names(activity)).toEqual([
      'id',
      'client_id',
      'kind',
      'occurred_at',
      'title',
      'body',
      'actor_user_id',
      'person_id',
      'source_type',
      'source_id',
      'pinned',
      'due_at',
      'settled_at',
      'created_by_user_id',
      'created_at',
      'updated_at',
      'origin',
      'direction',
      'counterparty',
      'objective_id',
      'objective_version',
      'objective_revision_id',
      'objective_availability',
    ]);
    expect(activity!.fields.find((field) => field.name === 'body')).toMatchObject({
      type: 'string',
      nullable: true,
    });
    expect(activity!.fields.find((field) => field.name === 'title')).toMatchObject({
      type: 'string',
      nullable: false,
    });
    for (const name of [
      'direction',
      'counterparty',
      'objective_id',
      'objective_version',
      'objective_revision_id',
      'objective_availability',
    ])
      expect(activity!.fields.find((field) => field.name === name)?.nullable).toBe(true);
    expect(activity!.fields.find((field) => field.name === 'objective_version')?.type).toBe(
      'integer',
    );
  });

  it('keeps the historical relationship soft and scoped by both client and Objective identity', () => {
    expect(objectives!.primaryKey).toEqual(['client_id', 'id']);
    expect(activity!.primaryKey).toEqual(['id']);
    expect(activity!.relationships).toEqual([
      {
        fields: ['client_id', 'objective_id'],
        referencedRelation: 'client_objectives',
        referencedFields: ['client_id', 'id'],
        cardinality: 'many_to_one',
        integrity: 'soft',
      },
    ]);
    for (const relation of CLIENT_QUERY_RELATIONS)
      for (const field of relation.fields)
        if (
          field.name === 'id' ||
          field.name.endsWith('_user_id') ||
          [
            'client_id',
            'request_id',
            'person_id',
            'objective_id',
            'objective_revision_id',
          ].includes(field.name)
        )
          expect(field.parameterType).toBe('UUID');
    expect(
      activity!.fields.find((field) => field.name === 'source_id')?.parameterType,
    ).toBeUndefined();
  });

  it('does not advertise a hidden context/timeline cap, row version or public-data coverage', () => {
    for (const relation of CLIENT_QUERY_RELATIONS) {
      expect(relation.coverage.basis).toBe('authorized_client_records');
      expect(relation.freshness).toEqual({
        field: 'updated_at',
        sourceAsOf: null,
        sourceVersion: null,
      });
      expect(relation.coverage.limitations.join(' ')).toMatch(
        /completeness|complete client history/,
      );
    }
    expect(objectives!.coverage.limitations.join(' ')).toContain(
      'No automatic-context three-item sample',
    );
    expect(activity!.coverage.limitations.join(' ')).toContain(
      'no hidden first-500 Timeline union',
    );
    expect(activity!.fields.find((field) => field.name === 'updated_at')?.description).toContain(
      'not a version',
    );
    expect(names(activity)).not.toContain('version');
  });

  it('names only the two constrained views and no raw metadata or policy escape', () => {
    expect(
      CLIENT_QUERY_RELATIONS.map(({ name, table, schema }) => ({ name, table, schema })),
    ).toEqual([
      { name: 'client_objectives', table: 'client_objectives', schema: 'meri_private' },
      { name: 'client_activity', table: 'client_activity', schema: 'meri_private' },
    ]);
    for (const relation of CLIENT_QUERY_RELATIONS) {
      expect(Object.hasOwn(relation, 'predicate')).toBe(false);
      expect(new Set(names(relation)).size).toBe(relation.fields.length);
      expect(relation.fields.length).toBeLessThanOrEqual(32);
      expect(names(relation)).not.toEqual(expect.arrayContaining(['metadata_jsonb']));
      expect(
        names(relation).some((name) =>
          /tenant_id|create_request_hash|ledger|payload|consent/.test(name),
        ),
      ).toBe(false);
      expect(
        relation.fields.every((field) =>
          ['string', 'integer', 'boolean', 'timestamp'].includes(field.type),
        ),
      ).toBe(true);
    }
  });

  it('cannot be widened or altered after server composition', () => {
    expect(() => (CLIENT_QUERY_RELATIONS as unknown[]).push({ name: 'users' })).toThrow(TypeError);
    expect(() => Object.assign(objectives!, { table: 'clients' })).toThrow(TypeError);
    expect(() => Object.assign(objectives!.fields[0]!, { name: 'metadata_jsonb' })).toThrow(
      TypeError,
    );
    expect(() => (activity!.fields as unknown[]).push({ name: 'private' })).toThrow(TypeError);
    expect(() => (activity!.relationships[0]!.fields as string[]).pop()).toThrow(TypeError);
    expect(() => (objectives!.primaryKey as string[]).pop()).toThrow(TypeError);
    expect(() => (activity!.coverage.limitations as string[]).pop()).toThrow(TypeError);
    expect(() => Object.assign(activity!.freshness, { sourceVersion: 'fabricated' })).toThrow(
      TypeError,
    );
  });
});
