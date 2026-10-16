import type {
  ObjectiveOperationalActor,
  ObjectiveOperationalBinding,
  ObjectiveOperationalSelection,
  ObjectiveOperationalTx,
} from '@capiro/shared';
import {
  createBlankCampaignSpecV1,
  hashCampaignSpecV1,
} from '../../../outreach-v3/state/outreach-campaign-spec.v1.js';
import {
  ownMeetingWhere,
  clientAssociatedMeetingWhere,
} from '../../../engagement/engagement-access.helpers.js';
import {
  lockObjectiveLocalResource,
  readObjectiveLocalResource,
  validateObjectiveCycleContext,
  type ObjectiveLocalResourceGate,
} from './objective-local-resources.js';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const actor: ObjectiveOperationalActor = {
  tenantId: id(1),
  tenantSlug: 'tenant',
  userId: id(2),
  clerkUserId: 'clerk-2',
  role: 'user_admin',
};
const binding: ObjectiveOperationalBinding = {
  clientId: id(3),
  objectiveId: id(4),
  objectiveVersion: 3,
  objectiveRevisionId: id(5),
};
const observedAt = '2026-10-15T12:05:00.000Z';
const asOf = '2026-10-15T12:00:00.000Z';
const meeting: ObjectiveOperationalSelection = { kind: 'meeting', id: id(6) };
const session: ObjectiveOperationalSelection = { kind: 'outreach_session', id: id(7) };
const packageSelection: ObjectiveOperationalSelection = { kind: 'budget_package', id: id(8) };
const cycleSelection: ObjectiveOperationalSelection = { kind: 'defense_budget_cycle', id: id(9) };
const internalActor = { ...actor, tenantSlug: 'capiro-internal' };

type Query = { sql: string; values: unknown[] };
function harness(...replies: unknown[][]) {
  const queries: Query[] = [];
  const query = jest.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    queries.push({ sql: strings.join('?').replace(/\s+/g, ' ').trim(), values });
    if (!replies.length) throw new Error('Unexpected source query');
    return replies.shift();
  });
  const execute = jest.fn();
  return {
    tx: { $queryRaw: query, $executeRaw: execute } as unknown as ObjectiveOperationalTx,
    query,
    execute,
    queries,
  };
}

const read = (tx: ObjectiveOperationalTx, selection = meeting, currentActor = actor) =>
  readObjectiveLocalResource(tx, currentActor, binding, selection, observedAt, asOf);
const meetingRow = (over: Record<string, unknown> = {}) => ({
  id: meeting.id,
  clientId: binding.clientId,
  status: 'scheduled',
  title: 'Scheduled meeting',
  updatedAt: '2026-10-15T11:00:00Z',
  startsAt: '2026-10-15T12:00:00Z',
  endsAt: '2026-10-15T13:00:00Z',
  ...over,
});
const outreachRow = (over: Record<string, unknown> = {}) => {
  const spec = createBlankCampaignSpecV1();
  spec.sponsor = { kind: 'client', label: null, clientRefs: [{ clientId: binding.clientId }] };
  return {
    id: session.id,
    title: null,
    currentStateVersion: 12,
    status: 'active',
    archivedAt: null,
    specJsonb: spec,
    specHash: hashCampaignSpecV1(spec),
    hasPending: false,
    ...over,
  };
};

describe('Objective local source metadata boundaries', () => {
  const originalFlag = process.env.OUTREACH_V3_STATE_ENABLED;
  const originalInternalId = process.env.CAPIRO_INTERNAL_TENANT_ID;
  beforeEach(() => {
    delete process.env.CAPIRO_INTERNAL_TENANT_ID;
  });
  afterEach(() => {
    if (originalFlag === undefined) delete process.env.OUTREACH_V3_STATE_ENABLED;
    else process.env.OUTREACH_V3_STATE_ENABLED = originalFlag;
    if (originalInternalId === undefined) delete process.env.CAPIRO_INTERNAL_TENANT_ID;
    else process.env.CAPIRO_INTERNAL_TENANT_ID = originalInternalId;
  });

  it.each([undefined, '', 'false', '0', 'off', 'no', 'invalid'])(
    'does not query or lock any Outreach session while the owner state flag is %s',
    async (flag) => {
      if (flag === undefined) delete process.env.OUTREACH_V3_STATE_ENABLED;
      else process.env.OUTREACH_V3_STATE_ENABLED = flag;
      const h = harness();
      await lockObjectiveLocalResource(h.tx, actor, session);
      expect(await read(h.tx, session)).toBeNull();
      expect(h.query).not.toHaveBeenCalled();
      expect(h.execute).not.toHaveBeenCalled();
    },
  );

  it('acquires the active session owner row gate without taking Core authority', async () => {
    process.env.OUTREACH_V3_STATE_ENABLED = 'true';
    const h = harness([]);
    await lockObjectiveLocalResource(h.tx, actor, session);
    expect(h.queries[0]!.sql).toContain('FROM outreach_sessions');
    expect(h.queries[0]!.sql).toContain("status = 'active' AND archived_at IS NULL FOR UPDATE");
    expect(h.queries[0]!.sql).toContain('created_by_user_id = ?::uuid');
    expect(h.queries[0]!.values).toEqual([session.id, actor.tenantId, actor.userId]);
    expect(h.queries[0]!.sql).not.toMatch(/client_objectives|client_objective_revisions/);
  });

  it('reads the actual nullable title and current counter, without opening a body or a provider', async () => {
    process.env.OUTREACH_V3_STATE_ENABLED = 'ON';
    const h = harness([outreachRow()]);
    expect(await read(h.tx, session)).toEqual({
      resource: {
        selection: session,
        title: null,
        observedAt,
        ownerVersion: { kind: 'counter', value: 12 },
      },
      pendingProposals: [],
      decisionSourceUnavailable: false,
    });
    const source = h.queries[0]!;
    expect(source.sql).toContain(
      'v.tenant_id = s.tenant_id AND v.version = s.current_state_version',
    );
    expect(source.sql).toContain("s.status = 'active' AND s.archived_at IS NULL");
    expect(source.sql).not.toMatch(/FOR SHARE|FOR UPDATE/);
    expect(source.values).toEqual([actor.userId, session.id, actor.tenantId, actor.userId]);
    expect(h.query).toHaveBeenCalledTimes(1);
    for (const query of h.queries) {
      expect(query.sql).not.toMatch(
        /outreach_records|outreach_draft_artifacts|outreach_send_intents|reasoning|commands_jsonb/,
      );
    }
  });

  it.each([
    ['missing or foreign session', null],
    ['archived session', { status: 'archived', archivedAt: observedAt }],
    ['completed session', { status: 'completed' }],
    ['archive timestamp with active label', { archivedAt: observedAt }],
    ['missing actual state version', { currentStateVersion: 0 }],
    ['invalid actual state version', { currentStateVersion: 1.5 }],
    ['missing pending witness', { hasPending: undefined }],
    ['null pending witness', { hasPending: null }],
    ['numeric pending witness', { hasPending: 0 }],
    ['text pending witness', { hasPending: 'true' }],
    ['corrupt state', { specJsonb: {} }],
    ['corrupt canonical hash', { specHash: 'f'.repeat(64) }],
  ] as Array<[string, Record<string, unknown> | null]>)(
    'withholds %s from the atomic owner observation',
    async (_name, over) => {
      process.env.OUTREACH_V3_STATE_ENABLED = 'true';
      const h = harness(over === null ? [] : [outreachRow(over)]);
      expect(await read(h.tx, session)).toBeNull();
      expect(h.query).toHaveBeenCalledTimes(1);
    },
  );

  it.each(['firm', 'internal_team', 'none', 'undecided', 'wrong_client', 'two_clients'])(
    'denies current campaign sponsor %s despite a readable owner session',
    async (scope) => {
      process.env.OUTREACH_V3_STATE_ENABLED = 'true';
      const row = outreachRow();
      const spec = createBlankCampaignSpecV1();
      if (scope === 'wrong_client')
        spec.sponsor = { kind: 'client', label: null, clientRefs: [{ clientId: id(99) }] };
      else if (scope === 'two_clients')
        spec.sponsor = {
          kind: 'multi_client',
          label: null,
          clientRefs: [{ clientId: binding.clientId }, { clientId: id(99) }],
        };
      else
        spec.sponsor = {
          kind: scope as 'firm' | 'internal_team' | 'none' | 'undecided',
          label: null,
          clientRefs: [],
        };
      row.specJsonb = spec;
      row.specHash = hashCampaignSpecV1(spec);
      const h = harness([row]);
      expect(await read(h.tx, session)).toBeNull();
      expect(h.query).toHaveBeenCalledTimes(1);
    },
  );

  it('withholds proposal rows without a canonical title and reports unavailable rather than a zero', async () => {
    process.env.OUTREACH_V3_STATE_ENABLED = 'true';
    const h = harness([outreachRow({ hasPending: true })]);
    const result = await read(h.tx, session);
    expect(result?.pendingProposals).toEqual([]);
    expect(result?.decisionSourceUnavailable).toBe(true);
    expect(h.query).toHaveBeenCalledTimes(1);
    const source = h.queries[0]!;
    expect(source.sql).toContain('EXISTS ( SELECT 1 FROM outreach_command_proposals p');
    expect(source.sql).toContain('p.tenant_id = s.tenant_id AND p.session_id = s.id');
    expect(source.sql).toContain("p.created_by_user_id = ?::uuid AND p.status = 'pending'");
    expect(source.sql).toContain('p.expected_state_version = s.current_state_version');
    expect(source.sql).toContain(') AS "hasPending"');
    expect(source.sql).toContain('s.created_by_user_id = ?::uuid');
    expect(source.sql).not.toMatch(/p\.id\b|p\.title\b|commands_jsonb|FOR SHARE|FOR UPDATE/);
    expect(source.values).toEqual([actor.userId, session.id, actor.tenantId, actor.userId]);
  });

  it.each([true, false])(
    'keeps pending=%s tied to the same observed current session version without a read lock',
    async (hasPending) => {
      process.env.OUTREACH_V3_STATE_ENABLED = 'true';
      const h = harness([outreachRow({ currentStateVersion: 13, hasPending })]);
      expect(await read(h.tx, session)).toEqual({
        resource: {
          selection: session,
          title: null,
          observedAt,
          ownerVersion: { kind: 'counter', value: 13 },
        },
        pendingProposals: [],
        decisionSourceUnavailable: hasPending,
      });
      expect(h.query).toHaveBeenCalledTimes(1);
      expect(h.queries[0]!.sql).toContain('v.version = s.current_state_version');
      expect(h.queries[0]!.sql).toContain('p.expected_state_version = s.current_state_version');
      expect(h.queries[0]!.sql).not.toMatch(/FOR SHARE|FOR UPDATE|p\.id\b|p\.title\b/);
      expect(h.execute).not.toHaveBeenCalled();
    },
  );

  it('preserves actual meeting dates, exact title, and the owner timestamp', async () => {
    const h = harness([meetingRow({ title: null })]);
    expect(await read(h.tx)).toEqual({
      resource: {
        selection: meeting,
        title: null,
        observedAt,
        ownerVersion: { kind: 'timestamp', value: '2026-10-15T11:00:00.000Z' },
      },
      startsAt: asOf,
      endsAt: '2026-10-15T13:00:00.000Z',
    });
    expect(h.execute).not.toHaveBeenCalled();
  });

  it('pins the SQL translation to the established ownership and association helpers', async () => {
    // Owner helper semantics are independently pinned here so a future policy
    // change cannot silently leave this narrow raw-SQL port behind.
    expect(ownMeetingWhere(actor.userId)).toEqual({
      OR: [{ createdByUserId: actor.userId }, { connection: { createdByUserId: actor.userId } }],
      status: { not: 'deleted' },
    });
    const association = clientAssociatedMeetingWhere(
      [binding.clientId],
      ['\t\n CONTACT@EXAMPLE.COM \u00a0\ufeff'],
    );
    expect(association).toMatchObject({
      OR: [
        { clientId: binding.clientId },
        {
          clientId: null,
          isInternal: false,
          AND: [
            expect.anything(),
            {
              OR: [
                { organizerEmail: { in: ['contact@example.com'] } },
                { attendees: { some: { email: { in: ['contact@example.com'] } } } },
              ],
            },
          ],
        },
      ],
    });
    const h = harness([]);
    expect(await read(h.tx)).toBeNull();
    const q = h.queries[0]!;
    for (const fragment of [
      'm.tenant_id = ?::uuid',
      'm.created_by_user_id = ?::uuid',
      'c.id = m.connection_id AND c.tenant_id = m.tenant_id',
      'c.created_by_user_id = ?::uuid',
      "m.visibility = 'shared' AND m.client_id = ?::uuid",
      'm.client_id IS NULL AND m.is_internal = false',
      "m.association_signals_jsonb -> 'manual' IS NULL",
      "m.association_signals_jsonb -> 'manual' = 'null'::jsonb",
      "m.association_signals_jsonb -> 'manual' = 'false'::jsonb",
      'lower(btrim(c.primary_contact_email::text, ?))',
      'lower(btrim(p.email::text, ?))',
      'a.meeting_id = m.id AND a.tenant_id = m.tenant_id',
      "m.status NOT IN ('deleted', 'cancelled', 'canceled')",
    ])
      expect(q.sql).toContain(fragment);
    const trimCharacters = q.values[6] as string;
    expect(trimCharacters).toContain('\t');
    expect(trimCharacters).toContain('\n');
    expect(trimCharacters).toContain('\u00a0');
    expect(trimCharacters).toContain('\ufeff');
    expect(trimCharacters.trim()).toBe('');
    expect(q.values).toEqual([
      meeting.id,
      actor.tenantId,
      actor.userId,
      actor.userId,
      binding.clientId,
      binding.clientId,
      trimCharacters,
      binding.clientId,
      actor.tenantId,
      trimCharacters,
      binding.clientId,
      actor.tenantId,
      null,
      null,
      null,
      null,
    ]);
    expect(q.sql).toContain('?::uuid[] IS NULL OR p.id = ANY(?::uuid[])');
    expect(q.sql).toContain('?::uuid[] IS NULL OR a.id = ANY(?::uuid[])');
    expect(q.sql).not.toMatch(/FOR SHARE|FOR UPDATE/);
    expect(q.sql).not.toContain('m.starts_at >=');
    expect(q.sql).not.toMatch(
      /meeting_notes|meeting_preps|meeting_debriefs|transcript|description|raw_jsonb|metadata_jsonb/,
    );
  });

  it.each([
    ['missing row', []],
    ['invalid actual date', [meetingRow({ startsAt: 'invalid' })]],
    ['invalid owner timestamp', [meetingRow({ updatedAt: 'invalid' })]],
    ['invalid actual end', [meetingRow({ endsAt: 'invalid' })]],
    ['wrong selected identity', [meetingRow({ id: id(99) })]],
    ['moved to a different client', [meetingRow({ clientId: id(99) })]],
    ['cancelled actual event', [meetingRow({ status: 'cancelled' })]],
    ['canceled actual event', [meetingRow({ status: 'canceled' })]],
    ['deleted actual event', [meetingRow({ status: 'deleted' })]],
  ] as Array<[string, unknown[]]>)(
    'withholds %s without manufacturing a date or resource version',
    async (_name, rows) => {
      expect(await read(harness(rows).tx)).toBeNull();
    },
  );

  it('returns verified past scheduled metadata so the projection can select the earliest actual future start', async () => {
    const startsAt = '2026-10-15T11:59:59.999Z';
    const h = harness([meetingRow({ startsAt })]);
    expect(await read(h.tx)).toMatchObject({ resource: { selection: meeting }, startsAt });
    expect(h.queries[0]!.sql).not.toContain('m.starts_at >=');
  });

  it('checks the current client every time a moved resource is resolved', async () => {
    const h = harness([], []);
    expect(await read(h.tx)).toBeNull();
    await readObjectiveLocalResource(
      h.tx,
      actor,
      { ...binding, clientId: id(99) },
      meeting,
      observedAt,
      asOf,
    );
    expect(h.queries[0]!.values.filter((v) => v === binding.clientId)).toHaveLength(4);
    expect(h.queries[1]!.values).not.toContain(binding.clientId);
    expect(h.queries[1]!.values.filter((v) => v === id(99))).toHaveLength(4);
  });

  it('does not broaden private metadata visibility for an admin role', async () => {
    const h = harness([]);
    expect(await read(h.tx, meeting, { ...actor, role: 'capiro_admin' })).toBeNull();
    expect(h.queries[0]!.values).not.toContain('capiro_admin');
    expect(h.queries[0]!.sql).toContain("m.visibility = 'shared' AND m.client_id = ?::uuid");
  });

  it('fences connection, meeting, and current person/attendee witnesses before Core authority', async () => {
    const connectionId = id(10),
      personId = id(11),
      attendeeId = id(12);
    const ownerRow = { id: meeting.id, connectionId };
    const h = harness(
      [ownerRow],
      [{ id: connectionId }],
      [ownerRow],
      [{ id: personId }],
      [{ id: attendeeId }],
      [meetingRow({ clientId: null })],
    );
    const gate = await lockObjectiveLocalResource(h.tx, actor, meeting, binding.clientId);
    expect(gate).toEqual({
      kind: 'meeting',
      tenantId: actor.tenantId,
      userId: actor.userId,
      meetingId: meeting.id,
      clientId: binding.clientId,
      lockedPersonIds: [personId],
      lockedAttendeeIds: [attendeeId],
    });
    expect(
      await readObjectiveLocalResource(h.tx, actor, binding, meeting, observedAt, asOf, gate),
    ).toMatchObject({ resource: { selection: meeting } });
    expect(h.queries[0]!.sql).not.toMatch(/FOR SHARE|FOR UPDATE/);
    expect(h.queries[1]!.sql).toContain(
      'FROM engagement_connections WHERE id = ?::uuid AND tenant_id = ?::uuid FOR SHARE',
    );
    expect(h.queries[1]!.values).toEqual([connectionId, actor.tenantId]);
    expect(h.queries[2]!.sql).toContain('m.connection_id IS NOT DISTINCT FROM ?::uuid');
    expect(h.queries[2]!.sql).toContain('FOR UPDATE OF m');
    expect(h.queries[2]!.values).toEqual([
      meeting.id,
      actor.tenantId,
      connectionId,
      actor.userId,
      actor.userId,
      binding.clientId,
    ]);
    expect(h.queries[3]!.sql).toContain(
      'FROM client_people WHERE tenant_id = ?::uuid AND client_id = ?::uuid ORDER BY id FOR SHARE',
    );
    expect(h.queries[3]!.values).toEqual([actor.tenantId, binding.clientId]);
    expect(h.queries[4]!.sql).toContain(
      'FROM meeting_attendees WHERE tenant_id = ?::uuid AND meeting_id = ?::uuid ORDER BY id FOR SHARE',
    );
    expect(h.queries[4]!.values).toEqual([actor.tenantId, meeting.id]);
    expect(h.queries[5]!.values.slice(-4)).toEqual([
      [personId],
      [personId],
      [attendeeId],
      [attendeeId],
    ]);
    expect(h.queries[5]!.sql).not.toMatch(/FOR SHARE|FOR UPDATE/);
    expect(
      h.queries.every((q) => !/client_objectives|meeting_notes|meeting_debriefs/.test(q.sql)),
    ).toBe(true);
  });

  it('keeps null-connection explicit meetings eligible with empty bounded witness sets', async () => {
    const ownerRow = { id: meeting.id, connectionId: null };
    const h = harness([ownerRow], [ownerRow], [], [], [meetingRow()]);
    const gate = await lockObjectiveLocalResource(h.tx, actor, meeting, binding.clientId);
    expect(gate?.lockedPersonIds).toEqual([]);
    expect(gate?.lockedAttendeeIds).toEqual([]);
    expect(h.queries.some((q) => q.sql.includes('SELECT id FROM engagement_connections'))).toBe(
      false,
    );
    expect(h.queries[1]!.values[2]).toBeNull();
    expect(
      await readObjectiveLocalResource(h.tx, actor, binding, meeting, observedAt, asOf, gate),
    ).not.toBeNull();
    expect(h.queries[4]!.values.slice(-4)).toEqual([[], [], [], []]);
  });

  it.each([false, true])(
    'refuses a changed connection rather than accepting a stale locked witness (returned=%s)',
    async (returned) => {
      const finalRows = returned ? [{ id: meeting.id, connectionId: id(99) }] : [];
      const h = harness([{ id: meeting.id, connectionId: id(10) }], [{ id: id(10) }], finalRows);
      await expect(
        lockObjectiveLocalResource(h.tx, actor, meeting, binding.clientId),
      ).rejects.toThrow('Objective local resource gate unavailable');
      expect(h.query).toHaveBeenCalledTimes(3);
      expect(h.queries[2]!.sql).toContain('m.connection_id IS NOT DISTINCT FROM ?::uuid');
    },
  );

  it('refuses a deleted or moved connection before taking the meeting lock', async () => {
    const h = harness([{ id: meeting.id, connectionId: id(10) }], []);
    await expect(
      lockObjectiveLocalResource(h.tx, actor, meeting, binding.clientId),
    ).rejects.toThrow('Objective local resource gate unavailable');
    expect(h.query).toHaveBeenCalledTimes(2);
    expect(h.queries.every((q) => !q.sql.includes('FOR UPDATE OF m'))).toBe(true);
  });

  it('requires a selected client scope before any meeting gate SQL', async () => {
    const h = harness();
    await expect(lockObjectiveLocalResource(h.tx, actor, meeting)).rejects.toThrow(
      'Objective local resource gate unavailable',
    );
    expect(h.query).not.toHaveBeenCalled();
  });

  it('ignores person and attendee phantoms inserted after the write gate', async () => {
    const gate: ObjectiveLocalResourceGate = {
      kind: 'meeting',
      tenantId: actor.tenantId,
      userId: actor.userId,
      meetingId: meeting.id,
      clientId: binding.clientId,
      lockedPersonIds: [id(11)],
      lockedAttendeeIds: [id(12)],
    };
    const phantomPersonId = id(13),
      phantomAttendeeId = id(14);
    const h = harness([]);
    expect(
      await readObjectiveLocalResource(h.tx, actor, binding, meeting, observedAt, asOf, gate),
    ).toBeNull();
    const q = h.queries[0]!;
    expect(q.sql).toContain('?::uuid[] IS NULL OR p.id = ANY(?::uuid[])');
    expect(q.sql).toContain('?::uuid[] IS NULL OR a.id = ANY(?::uuid[])');
    expect(q.values.slice(-4)).toEqual([[id(11)], [id(11)], [id(12)], [id(12)]]);
    expect(JSON.stringify(q.values)).not.toContain(phantomPersonId);
    expect(JSON.stringify(q.values)).not.toContain(phantomAttendeeId);
  });

  it.each(['tenantId', 'userId', 'meetingId', 'clientId'] as const)(
    'refuses a gate from another %s before source SQL',
    async (field) => {
      const gate: ObjectiveLocalResourceGate = {
        kind: 'meeting',
        tenantId: actor.tenantId,
        userId: actor.userId,
        meetingId: meeting.id,
        clientId: binding.clientId,
        lockedPersonIds: [],
        lockedAttendeeIds: [],
        [field]: id(99),
      };
      const h = harness();
      await expect(
        readObjectiveLocalResource(h.tx, actor, binding, meeting, observedAt, asOf, gate),
      ).rejects.toThrow('Objective local resource gate unavailable');
      expect(h.query).not.toHaveBeenCalled();
    },
  );

  it('rejects invalid source IDs or cutoffs without querying a source', async () => {
    const h = harness();
    expect(await read(h.tx, { ...meeting, id: 'not-a-uuid' })).toBeNull();
    await lockObjectiveLocalResource(h.tx, actor, { ...meeting, id: 'not-a-uuid' });
    expect(
      await readObjectiveLocalResource(h.tx, actor, binding, meeting, observedAt, 'invalid'),
    ).toBeNull();
    expect(h.query).not.toHaveBeenCalled();
  });

  it('reads exact public package metadata with its actual timestamp', async () => {
    const h = harness([{ id: packageSelection.id, title: 'FY27 Defense Budget', updatedAt: asOf }]);
    expect(await read(h.tx, packageSelection)).toEqual({
      resource: {
        selection: packageSelection,
        title: 'FY27 Defense Budget',
        observedAt,
        ownerVersion: { kind: 'timestamp', value: asOf },
      },
    });
    expect(h.queries[0]!.values).toEqual([packageSelection.id]);
    expect(h.queries[0]!.sql).toContain('FROM budget_package WHERE id = ?::uuid');
  });

  it('preserves a null lifecycle title and admits the canonical database-slug fallback despite a stale context slug', async () => {
    process.env.CAPIRO_INTERNAL_TENANT_ID = id(99);
    const h = harness([{ ok: 1 }], [{ id: cycleSelection.id, updatedAt: asOf }]);
    expect(await read(h.tx, cycleSelection, actor)).toEqual({
      resource: {
        selection: cycleSelection,
        title: null,
        observedAt,
        ownerVersion: { kind: 'timestamp', value: asOf },
      },
    });
    expect(h.queries[0]!.sql).toContain('SELECT 1 FROM tenants WHERE id::text = ? AND slug = ?');
    expect(h.queries[0]!.values).toEqual([actor.tenantId, 'capiro-internal']);
    expect(h.queries[1]!.values).toEqual([cycleSelection.id]);
  });

  it('does not trust a context slug when neither canonical tenant identity path admits the caller', async () => {
    const h = harness([], []);
    expect(await read(h.tx, cycleSelection, internalActor)).toBeNull();
    await lockObjectiveLocalResource(h.tx, internalActor, cycleSelection);
    expect(h.query).toHaveBeenCalledTimes(2);
    expect(
      h.queries.every(
        (q) => q.sql.includes('FROM tenants') && !q.sql.includes('FROM defense_budget_cycle'),
      ),
    ).toBe(true);
  });

  it('preserves configured tenant identity as a fast path for read, owner lock, and cycle validation', async () => {
    process.env.CAPIRO_INTERNAL_TENANT_ID = `  ${actor.tenantId}  `;
    const h = harness(
      [{ id: cycleSelection.id, updatedAt: asOf }],
      [{ id: cycleSelection.id }],
      [{ id: cycleSelection.id }],
    );
    expect(await read(h.tx, cycleSelection, actor)).not.toBeNull();
    await lockObjectiveLocalResource(h.tx, actor, cycleSelection);
    expect(
      await validateObjectiveCycleContext(h.tx, actor, {
        fiscalYear: 2027,
        authorityTrack: 'authorization',
        context: { kind: 'defense_budget_cycle', id: cycleSelection.id },
      }),
    ).toBe(true);
    expect(h.query).toHaveBeenCalledTimes(3);
    expect(h.queries.every((q) => !q.sql.includes('FROM tenants'))).toBe(true);
    expect(h.queries[1]!.sql).toContain('FOR SHARE');
  });

  it('fails closed when the canonical tenant fallback query fails', async () => {
    const h = harness();
    h.query.mockRejectedValueOnce(new Error('private database failure'));
    expect(await read(h.tx, cycleSelection, internalActor)).toBeNull();
    expect(h.query).toHaveBeenCalledTimes(1);
    expect(h.queries).toHaveLength(0);
  });

  it('keeps a missing internal lifecycle cycle unavailable', async () => {
    expect(await read(harness([{ ok: 1 }], []).tx, cycleSelection, internalActor)).toBeNull();
  });

  it('does not turn budget context into a client relationship or official cycle fact', async () => {
    const h = harness([]);
    expect(
      await validateObjectiveCycleContext(h.tx, actor, {
        fiscalYear: 2027,
        authorityTrack: 'authorization',
        context: null,
      }),
    ).toBe(true);
    expect(h.query).not.toHaveBeenCalled();
  });

  it.each([0, 10000, 2027.5, NaN])(
    'refuses invalid annotation fiscal year %s',
    async (fiscalYear) => {
      const h = harness();
      expect(
        await validateObjectiveCycleContext(h.tx, actor, {
          fiscalYear,
          authorityTrack: null,
          context: { kind: 'budget_package', id: packageSelection.id },
        }),
      ).toBe(false);
      expect(h.query).not.toHaveBeenCalled();
    },
  );

  it.each([
    [' ', true],
    ['\u{1f600}'.repeat(600), true],
    ['\u{1f600}'.repeat(601), false],
    ['', false],
  ] as Array<[string, boolean]>)(
    'matches the wire authority-track codepoint boundary without trimming (%s)',
    async (authorityTrack, accepted) => {
      const h = harness();
      expect(
        await validateObjectiveCycleContext(h.tx, actor, {
          fiscalYear: 2027,
          authorityTrack,
          context: null,
        }),
      ).toBe(accepted);
      expect(h.query).not.toHaveBeenCalled();
    },
  );

  it.each([[[]], [[{ id: packageSelection.id }]]] as Array<[Array<{ id: string }>]>)(
    'validates package context by exact UUID and fiscal year',
    async (rows) => {
      const h = harness(rows);
      expect(
        await validateObjectiveCycleContext(h.tx, actor, {
          fiscalYear: 2027,
          authorityTrack: null,
          context: { kind: 'budget_package', id: packageSelection.id },
        }),
      ).toBe(rows.length > 0);
      expect(h.queries[0]!.sql).toContain('WHERE id = ?::uuid AND fiscal_year = ?');
      expect(h.queries[0]!.values).toEqual([packageSelection.id, 2027]);
    },
  );

  it('refuses internal cycle annotation after the canonical fallback denies the tenant', async () => {
    const h = harness([]);
    expect(
      await validateObjectiveCycleContext(h.tx, actor, {
        fiscalYear: 2027,
        authorityTrack: 'authorization',
        context: { kind: 'defense_budget_cycle', id: cycleSelection.id },
      }),
    ).toBe(false);
    expect(h.query).toHaveBeenCalledTimes(1);
    expect(h.queries[0]!.sql).toContain('FROM tenants');
  });

  it('validates exact lifecycle context fiscal year, optional explicit track and internal tenant', async () => {
    const h = harness([{ ok: 1 }], [{ id: cycleSelection.id }], [{ ok: 1 }], []);
    const context = { kind: 'defense_budget_cycle' as const, id: cycleSelection.id };
    expect(
      await validateObjectiveCycleContext(h.tx, internalActor, {
        fiscalYear: 2027,
        authorityTrack: 'authorization',
        context,
      }),
    ).toBe(true);
    expect(
      await validateObjectiveCycleContext(h.tx, internalActor, {
        fiscalYear: 2028,
        authorityTrack: 'appropriations',
        context,
      }),
    ).toBe(false);
    expect(h.queries[1]!.sql).toContain('WHERE id = ?::uuid AND fiscal_year = ?');
    expect(h.queries[1]!.sql).toContain('authority_track = ?');
    expect(h.queries[1]!.values).toEqual([
      cycleSelection.id,
      2027,
      'authorization',
      'authorization',
    ]);
    expect(h.queries[3]!.values).toEqual([
      cycleSelection.id,
      2028,
      'appropriations',
      'appropriations',
    ]);
  });

  it('never writes the local resources it observes', async () => {
    const h = harness([]);
    await read(h.tx);
    expect(h.execute).not.toHaveBeenCalled();
    expect(h.queries.every((q) => q.sql.startsWith('SELECT'))).toBe(true);
  });
});
