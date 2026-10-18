import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import {
  readObjectivePlanResource,
  type ObjectiveOperationalActor,
  type ObjectiveOperationalBinding,
  type ObjectiveOperationalSelection,
  type ObjectiveOperationalTx,
} from '@capiro/shared';
import { operationalDigest } from './objective-operational.rules.js';
import {
  commitOperationalCommand,
  findOperationalReceipt,
  loadCurrentOperationalScopeWithinTx,
  readOperationalSetVersion,
} from './objective-operational.store.js';
import type {
  OperationalCommand,
  OperationalLinkCommand,
  OperationalScope,
  OperationalUnlinkCommand,
} from './objective-operational.types.js';

const migrations = [
  '20281011010000_client_objectives',
  '20281015010000_client_objective_work_intents',
  '20281015020000_client_objective_canonical_plans',
  '20281015030000_client_objective_operational_links',
].map((name) =>
  readFileSync(resolve(process.cwd(), 'prisma/migrations', name, 'migration.sql'), 'utf8'),
);

function uuid(value: number): string {
  return `00000000-0000-4000-8000-${value.toString(16).padStart(12, '0')}`;
}

const tenantA = uuid(1);
const tenantB = uuid(2);
const clientA = 'abcdefab-0000-4000-8000-000000000003';
const clientAOther = uuid(4);
const clientB = uuid(5);
const objectiveA = uuid(6);
const objectiveAOther = uuid(7);
const objectiveAOtherClient = uuid(8);
const objectiveB = uuid(9);
const revisionA1 = uuid(10);
const revisionA2 = uuid(11);
const revisionAOther = uuid(12);
const revisionAOtherClient = uuid(13);
const revisionB1 = uuid(14);
const revisionB2 = uuid(15);
const actor = uuid(16);
const otherActor = uuid(17);
const associationA = uuid(18);
const associationB = uuid(19);
const resourceA = uuid(20);
const resourceB = uuid(21);
const requestA = uuid(22);
const requestB = uuid(23);
const receiptA = uuid(24);
const receiptB = uuid(25);
const candidateAssociation = uuid(26);
const candidateReceipt = uuid(27);
const candidateRequest = uuid(28);
const removedRequest = uuid(29);
const candidateResource = uuid(30);
const ownerProject = '3abcdef0-0000-4000-8000-000000000201';
const ownerArchivedGrant = uuid(202);
const ownerTask = uuid(203);
const ownerJsonOnlyTask = uuid(204);
const ownerPrivateTask = uuid(205);
const ownerArchivedGrantTask = uuid(206);
const ownerPrivateProject = uuid(207);
const ownerUppercaseMembershipTask = uuid(210);
const ownerStrategy = uuid(211);
const ownerObservedAt = '2028-10-20T12:00:00.000Z';
const storeActor: ObjectiveOperationalActor = {
  tenantId: tenantA,
  tenantSlug: 'synthetic-tenant-a',
  userId: actor,
  clerkUserId: 'synthetic-clerk-actor',
  role: 'standard_user',
};
const storeScope: OperationalScope = {
  clientId: clientA,
  objectiveId: objectiveA,
  currentRevisionId: revisionA2,
  objectiveVersion: 2,
  objectiveStatus: 'draft',
  ownerUserId: null,
};

function storeLink(overrides: Partial<OperationalLinkCommand> = {}): OperationalLinkCommand {
  return {
    schemaVersion: 1,
    action: 'link',
    requestId: uuid(100),
    clientId: clientA,
    objectiveId: objectiveA,
    expectedObjectiveVersion: 2,
    expectedAssociationSetVersion: 1,
    resource: { kind: 'strategy', id: uuid(101) },
    cycles: [],
    ...overrides,
  };
}

interface LinkFixture {
  id: string;
  tenant: string;
  client: string;
  objective: string;
  revision: string;
  objectiveVersion: number;
  resource: string;
  kind: string;
}

interface ReceiptFixture {
  id: string;
  tenant: string;
  client: string;
  objective: string;
  actor: string;
  request: string;
  association: string;
  commandRevision: string;
  commandVersion: number;
  linkedRevision: string;
  linkedVersion: number;
  action: 'link' | 'unlink';
  outcome: 'linked' | 'unlinked' | 'unchanged';
}

// One bounded in-memory database, synthetic records, and the checked-in SQL only.
// This is not native PostgreSQL, deployment, role-inheritance, or concurrency qualification.
describe('Objective operational migration SQL on isolated PGlite', () => {
  let db: PGlite;

  async function insertLink(overrides: Partial<LinkFixture> = {}) {
    const link: LinkFixture = {
      id: candidateAssociation,
      tenant: tenantA,
      client: clientA,
      objective: objectiveA,
      revision: revisionA1,
      objectiveVersion: 1,
      resource: candidateResource,
      kind: 'strategy',
      ...overrides,
    };
    return db.query(
      `INSERT INTO client_objective_resource_links
       (id,tenant_id,client_id,objective_id,linked_revision_id,linked_objective_version,
        resource_kind,resource_id,cycles,linked_by_user_id)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,'[]',$9) RETURNING id`,
      [
        link.id,
        link.tenant,
        link.client,
        link.objective,
        link.revision,
        link.objectiveVersion,
        link.kind,
        link.resource,
        actor,
      ],
    );
  }

  async function insertReceipt(overrides: Partial<ReceiptFixture> = {}) {
    const receipt: ReceiptFixture = {
      id: candidateReceipt,
      tenant: tenantA,
      client: clientA,
      objective: objectiveA,
      actor,
      request: candidateRequest,
      association: associationA,
      commandRevision: revisionA2,
      commandVersion: 2,
      linkedRevision: revisionA1,
      linkedVersion: 1,
      action: 'link',
      outcome: 'linked',
      ...overrides,
    };
    return db.query(
      `INSERT INTO client_objective_operational_receipts
       (id,tenant_id,client_id,objective_id,actor_user_id,request_id,payload_digest,command,
        association_id,command_revision_id,command_objective_version,linked_revision_id,
        linked_objective_version,action,outcome,result_set_version)
       VALUES($1,$2,$3,$4,$5,$6,repeat('a',64),'{}',$7,$8,$9,$10,$11,$12,$13,1)
       RETURNING id`,
      [
        receipt.id,
        receipt.tenant,
        receipt.client,
        receipt.objective,
        receipt.actor,
        receipt.request,
        receipt.association,
        receipt.commandRevision,
        receipt.commandVersion,
        receipt.linkedRevision,
        receipt.linkedVersion,
        receipt.action,
        receipt.outcome,
      ],
    );
  }

  async function unlink(id = associationA) {
    return db.query(
      `UPDATE client_objective_resource_links
       SET removed_at='2028-10-15T12:00:00Z',removed_by_user_id=$2,removed_request_id=$3
       WHERE id=$1 RETURNING id`,
      [id, actor, removedRequest],
    );
  }

  async function operationalSnapshot() {
    const [states, links, receipts] = await Promise.all([
      db.query(`SELECT to_jsonb(s) AS row FROM client_objective_operational_states s
        ORDER BY tenant_id,client_id,objective_id`),
      db.query('SELECT to_jsonb(l) AS row FROM client_objective_resource_links l ORDER BY id'),
      db.query(
        'SELECT to_jsonb(r) AS row FROM client_objective_operational_receipts r ORDER BY id',
      ),
    ]);
    return { states: states.rows, links: links.rows, receipts: receipts.rows };
  }

  // Adapt the actual store's tagged SQL to the isolated SQL engine. No store SQL,
  // receipt construction, CAS decision, or membership logic is duplicated here.
  function sqlText(strings: TemplateStringsArray): string {
    return strings.reduce((query, part, index) => `${query}${index ? `$${index}` : ''}${part}`, '');
  }
  const sqlTx: ObjectiveOperationalTx = {
    async $queryRaw<T>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T> {
      return (await db.query(sqlText(strings), values)).rows as T;
    },
    async $executeRaw(strings: TemplateStringsArray, ...values: unknown[]): Promise<number> {
      return (await db.query(sqlText(strings), values)).affectedRows ?? 0;
    },
  };
  async function storeTransaction<T>(work: (tx: ObjectiveOperationalTx) => Promise<T>): Promise<T> {
    await db.exec('BEGIN');
    try {
      const result = await work(sqlTx);
      await db.exec('COMMIT');
      return result;
    } catch (error) {
      await db.exec('ROLLBACK');
      throw error;
    }
  }

  async function seedPlanOwnerFixture() {
    const grantedProject = {
      name: 'Current human project',
      clientId: clientA.toUpperCase(),
      privacy: 'private',
      members: [{ userId: storeActor.clerkUserId, role: 'viewer' }],
    };
    for (const row of [
      { id: ownerProject, data: grantedProject, archived: false },
      {
        id: ownerArchivedGrant,
        data: {
          ...grantedProject,
          name: 'Private archived grant metadata',
          clientId: clientAOther,
        },
        archived: true,
      },
      {
        id: ownerPrivateProject,
        data: { ...grantedProject, name: 'Private ungranted project', members: [] },
        archived: false,
      },
    ]) {
      await db.query(
        `INSERT INTO sp_planner_projects
         (id,tenant_id,owner_id,data,version,archived,created_at,updated_at)
         VALUES($1,$2,'synthetic-other-owner',$3::jsonb,7,$4,'2028-10-01T10:00:00Z','2028-10-01T10:00:00Z')`,
        [row.id, tenantA, JSON.stringify(row.data), row.archived],
      );
    }
    const taskData = {
      name: 'Current human approval',
      clientId: clientA.toUpperCase(),
      status: 'blocked',
      subtype: 'approval',
      approval: 'pending',
      dueOn: '2028-10-01',
      dueTime: '12:00',
      timeZone: 'UTC',
      assigneeId: null,
      collaborators: [],
      memberships: [{ projectId: ownerProject }],
    };
    for (const row of [
      {
        id: ownerTask,
        data: taskData,
        projectIds: [ownerProject],
        tenant: tenantA,
        archived: false,
      },
      {
        id: ownerJsonOnlyTask,
        data: {
          ...taskData,
          name: 'Completed human milestone',
          status: 'done',
          subtype: 'milestone',
          approval: 'approved',
        },
        projectIds: [],
        tenant: tenantA,
        archived: false,
      },
      {
        id: ownerPrivateTask,
        data: { ...taskData, memberships: [{ projectId: ownerPrivateProject }] },
        projectIds: [ownerPrivateProject],
        tenant: tenantA,
        archived: false,
      },
      {
        id: ownerArchivedGrantTask,
        data: { ...taskData, memberships: [{ projectId: ownerArchivedGrant }] },
        projectIds: [ownerArchivedGrant],
        tenant: tenantA,
        archived: false,
      },
      {
        id: uuid(208),
        data: taskData,
        projectIds: [ownerProject],
        tenant: tenantA,
        archived: true,
      },
      {
        id: uuid(209),
        data: taskData,
        projectIds: [ownerProject],
        tenant: tenantB,
        archived: false,
      },
      {
        id: ownerUppercaseMembershipTask,
        data: { ...taskData, memberships: [{ projectId: ownerProject.toUpperCase() }] },
        projectIds: [],
        tenant: tenantA,
        archived: false,
      },
    ]) {
      await db.query(
        `INSERT INTO sp_planner_tasks
         (id,tenant_id,owner_id,project_ids,data,version,archived,created_at,updated_at)
         VALUES($1,$2,'synthetic-other-owner',$3::uuid[],$4::jsonb,11,$5,
           '2028-10-02T10:00:00Z','2028-10-02T10:00:00Z')`,
        [row.id, row.tenant, row.projectIds, JSON.stringify(row.data), row.archived],
      );
    }
    await db.query(
      `INSERT INTO sp_strategy(id,tenant_id,client_id,title,type,updated_at)
       VALUES($1,$2,$3,'Current human Strategy','coalition','2028-10-01T09:00:00Z')`,
      [ownerStrategy, tenantA, clientA],
    );
  }

  function readPlanOwner(selection: ObjectiveOperationalSelection) {
    const binding: ObjectiveOperationalBinding = {
      clientId: clientA,
      objectiveId: objectiveA,
      objectiveRevisionId: revisionA2,
      objectiveVersion: 2,
    };
    return readObjectivePlanResource(
      sqlTx,
      storeActor,
      binding,
      selection,
      ownerObservedAt,
      ownerObservedAt,
    );
  }

  beforeAll(async () => {
    db = new PGlite();
    await db.exec(`
      CREATE ROLE capiro_app NOLOGIN NOSUPERUSER NOBYPASSRLS;
      GRANT USAGE ON SCHEMA public TO capiro_app;
      -- Explicit synthetic fixture matching the migration owner's default DML policy.
      -- It provides no evidence about the configured owner or inherited production grants.
      ALTER DEFAULT PRIVILEGES IN SCHEMA public
        GRANT SELECT,INSERT,UPDATE,DELETE ON TABLES TO capiro_app;
      CREATE FUNCTION rls_bypass() RETURNS boolean LANGUAGE sql AS $$ SELECT false $$;
      CREATE FUNCTION current_tenant_id() RETURNS uuid LANGUAGE sql AS $$
        SELECT nullif(current_setting('app.current_tenant',true),'')::uuid $$;
      -- Minimal typed subsets for executing the actual Core authority queries.
      CREATE TABLE tenants(id uuid PRIMARY KEY,status text NOT NULL DEFAULT 'active',
        settings_jsonb jsonb NOT NULL DEFAULT '{"clioFeatureFlags":{"strategyPlanner.enabled":true}}');
      CREATE TABLE users(id uuid PRIMARY KEY,clerk_user_id text NOT NULL UNIQUE);
      CREATE TABLE tenant_memberships(tenant_id uuid NOT NULL REFERENCES tenants(id),
        user_id uuid NOT NULL REFERENCES users(id),status text NOT NULL,role text NOT NULL,
        PRIMARY KEY(tenant_id,user_id));
      CREATE TABLE clients(id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES tenants(id),
        status text NOT NULL DEFAULT 'active',memory_wall boolean NOT NULL DEFAULT false,
        UNIQUE(tenant_id,id));
      CREATE TABLE client_memory_access(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id uuid NOT NULL REFERENCES tenants(id),client_id uuid NOT NULL REFERENCES clients(id),
        user_id uuid NOT NULL REFERENCES users(id),UNIQUE(tenant_id,client_id,user_id));
      -- Owner table subsets preserve the production column types used by the reader.
      CREATE TYPE sp_strategy_type AS ENUM
        ('appropriations','authorization','regulatory','coalition','procurement','earmark','amendment');
      CREATE TABLE sp_strategy(id uuid PRIMARY KEY,tenant_id uuid NOT NULL,client_id uuid NOT NULL,
        title text NOT NULL,type sp_strategy_type NOT NULL,archived_at timestamp(3),updated_at timestamp(3) NOT NULL);
      CREATE TABLE sp_planner_projects(id uuid PRIMARY KEY,tenant_id uuid NOT NULL,owner_id text NOT NULL,
        data jsonb NOT NULL,version integer NOT NULL DEFAULT 1,archived boolean NOT NULL DEFAULT false,
        created_at timestamptz(6) NOT NULL DEFAULT now(),updated_at timestamptz(6) NOT NULL);
      CREATE TABLE sp_planner_tasks(id uuid PRIMARY KEY,tenant_id uuid NOT NULL,owner_id text NOT NULL,
        project_ids uuid[],data jsonb NOT NULL,version integer NOT NULL DEFAULT 1,
        archived boolean NOT NULL DEFAULT false,created_at timestamptz(6) NOT NULL DEFAULT now(),
        updated_at timestamptz(6) NOT NULL);
    `);
    await db.query('INSERT INTO tenants(id) VALUES($1),($2)', [tenantA, tenantB]);
    await db.query('INSERT INTO users VALUES($1,$2)', [actor, storeActor.clerkUserId]);
    await db.query("INSERT INTO tenant_memberships VALUES($1,$2,'active','standard_user')", [
      tenantA,
      actor,
    ]);
    await db.query('INSERT INTO clients(id,tenant_id) VALUES($1,$2),($3,$2),($4,$5)', [
      clientA,
      tenantA,
      clientAOther,
      clientB,
      tenantB,
    ]);
    await db.exec(migrations[0]!);
    await db.query(
      `INSERT INTO client_objectives
       (id,tenant_id,client_id,created_by_user_id,client_request_id,create_request_hash,version)
       VALUES($1,$2,$3,$4,gen_random_uuid(),repeat('a',64),2),
             ($5,$2,$3,$4,gen_random_uuid(),repeat('a',64),1),
             ($6,$2,$7,$4,gen_random_uuid(),repeat('a',64),1),
             ($8,$9,$10,$4,gen_random_uuid(),repeat('b',64),2)`,
      [
        objectiveA,
        tenantA,
        clientA,
        actor,
        objectiveAOther,
        objectiveAOtherClient,
        clientAOther,
        objectiveB,
        tenantB,
        clientB,
      ],
    );
    await db.query(
      `INSERT INTO client_objective_revisions
       (id,tenant_id,client_id,objective_id,version,operation,actor_user_id,snapshot)
       VALUES($1,$2,$3,$4,1,'create',$5,'{}'),($6,$2,$3,$4,2,'edit',$5,'{}'),
             ($7,$2,$3,$8,1,'create',$5,'{}'),($9,$2,$10,$11,1,'create',$5,'{}'),
             ($12,$13,$14,$15,1,'create',$5,'{}'),($16,$13,$14,$15,2,'edit',$5,'{}')`,
      [
        revisionA1,
        tenantA,
        clientA,
        objectiveA,
        actor,
        revisionA2,
        revisionAOther,
        objectiveAOther,
        revisionAOtherClient,
        clientAOther,
        objectiveAOtherClient,
        revisionB1,
        tenantB,
        clientB,
        objectiveB,
        revisionB2,
      ],
    );
    for (const migration of migrations.slice(1)) await db.exec(migration);
  }, 60_000);

  beforeEach(async () => {
    await db.exec(`
      RESET ROLE;
      SELECT set_config('app.current_tenant','',false);
      TRUNCATE client_objective_operational_receipts,client_objective_resource_links,
        client_objective_operational_states;
    `);
    await db.query(
      `INSERT INTO client_objective_operational_states(tenant_id,client_id,objective_id,version)
       VALUES($1,$2,$3,1),($4,$5,$6,1)`,
      [tenantA, clientA, objectiveA, tenantB, clientB, objectiveB],
    );
    await insertLink({ id: associationA, resource: resourceA });
    await insertLink({
      id: associationB,
      tenant: tenantB,
      client: clientB,
      objective: objectiveB,
      revision: revisionB1,
      resource: resourceB,
    });
    await insertReceipt({ id: receiptA, request: requestA });
    await insertReceipt({
      id: receiptB,
      tenant: tenantB,
      client: clientB,
      objective: objectiveB,
      request: requestB,
      association: associationB,
      commandRevision: revisionB2,
      linkedRevision: revisionB1,
    });
  });

  afterEach(async () => {
    await db.exec('RESET ROLE');
  });

  afterAll(async () => {
    await db?.close();
  });

  test('source migration is LF-exact and preserves preexisting client and Objective rows', async () => {
    expect(migrations[3]!).not.toContain('\r');
    expect((await db.query('SELECT id FROM clients ORDER BY id')).rows).toEqual([
      { id: clientAOther },
      { id: clientB },
      { id: clientA },
    ]);
    expect(
      (await db.query('SELECT id,status,version FROM client_objectives ORDER BY id')).rows,
    ).toEqual([
      { id: objectiveA, status: 'draft', version: 2 },
      { id: objectiveAOther, status: 'draft', version: 1 },
      { id: objectiveAOtherClient, status: 'draft', version: 1 },
      { id: objectiveB, status: 'draft', version: 2 },
    ]);
  });

  test('state and link FKs reject another tenant, client, Objective, or revision/version identity', async () => {
    for (const scope of [
      [tenantB, clientA, objectiveA],
      [tenantA, clientAOther, objectiveA],
      [tenantA, clientA, objectiveB],
    ]) {
      await expect(
        db.query(
          `INSERT INTO client_objective_operational_states(tenant_id,client_id,objective_id)
         VALUES($1,$2,$3)`,
          scope,
        ),
      ).rejects.toMatchObject({ code: '23503' });
    }
    const mismatches: Array<Partial<LinkFixture>> = [
      { tenant: tenantB },
      { client: clientAOther },
      { objective: objectiveAOther },
      { revision: revisionAOtherClient },
      { revision: revisionB1 },
      { objectiveVersion: 2 },
    ];
    for (const mismatch of mismatches) {
      await expect(insertLink(mismatch)).rejects.toMatchObject({ code: '23503' });
    }
    expect(
      (await db.query('SELECT id FROM client_objective_resource_links ORDER BY id')).rows,
    ).toEqual([{ id: associationA }, { id: associationB }]);
  });

  test('receipt FKs bind both its command revision and the exact association linked revision', async () => {
    const mismatches: Array<Partial<ReceiptFixture>> = [
      { tenant: tenantB },
      { client: clientAOther },
      { objective: objectiveAOther },
      { commandRevision: revisionB2 },
      { commandVersion: 1 },
      { association: associationB, linkedRevision: revisionB1 },
      { linkedRevision: revisionA2, linkedVersion: 2 },
      { linkedVersion: 2 },
    ];
    for (const mismatch of mismatches) {
      await expect(insertReceipt(mismatch)).rejects.toMatchObject({ code: '23503' });
    }
    // An unlink at a later Objective revision retains the original linked revision.
    await unlink();
    await insertReceipt({ action: 'unlink', outcome: 'unlinked' });
    expect(
      (
        await db.query(
          `SELECT command_revision_id,command_objective_version,linked_revision_id,
        linked_objective_version FROM client_objective_operational_receipts WHERE id=$1`,
          [candidateReceipt],
        )
      ).rows,
    ).toEqual([
      {
        command_revision_id: revisionA2,
        command_objective_version: 2,
        linked_revision_id: revisionA1,
        linked_objective_version: 1,
      },
    ]);
  });

  test('active uniqueness is scoped and relinking creates a fresh immutable association identity', async () => {
    await expect(insertLink({ resource: resourceA })).rejects.toMatchObject({ code: '23505' });
    await insertLink({ objective: objectiveAOther, revision: revisionAOther, resource: resourceA });
    await unlink();
    await insertLink({
      id: uuid(31),
      resource: resourceA,
      revision: revisionA2,
      objectiveVersion: 2,
    });
    await expect(insertLink({ id: uuid(32), resource: resourceA })).rejects.toMatchObject({
      code: '23505',
    });
    expect(
      (
        await db.query(
          `SELECT id,linked_revision_id,linked_objective_version,removed_at IS NOT NULL AS removed
       FROM client_objective_resource_links WHERE objective_id=$1 AND resource_id=$2 ORDER BY id`,
          [objectiveA, resourceA],
        )
      ).rows,
    ).toEqual([
      {
        id: associationA,
        linked_revision_id: revisionA1,
        linked_objective_version: 1,
        removed: true,
      },
      { id: uuid(31), linked_revision_id: revisionA2, linked_objective_version: 2, removed: false },
    ]);
  });

  test('identity fields and human cycle annotations cannot be rewritten before or after unlink', async () => {
    const identityChanges = [
      `id='${uuid(40)}'`,
      `tenant_id='${tenantB}'`,
      `client_id='${clientAOther}'`,
      `objective_id='${objectiveAOther}'`,
      `linked_revision_id='${revisionA2}'`,
      'linked_objective_version=2',
      "resource_kind='planner_project'",
      `resource_id='${candidateResource}'`,
      `cycles='[{"fiscalYear":2029,"basis":"human_annotation"}]'::jsonb`,
      `linked_by_user_id='${otherActor}'`,
      "linked_at='2028-10-16T12:00:00Z'",
    ];
    for (const removed of [false, true]) {
      if (removed) await unlink();
      for (const change of identityChanges) {
        await expect(
          db.query(`UPDATE client_objective_resource_links SET ${change} WHERE id=$1`, [
            associationA,
          ]),
        ).rejects.toMatchObject({ code: '23514' });
      }
    }
  });

  test('unlink requires all tombstone fields and cannot be reversed, replaced, or repeated', async () => {
    await expect(
      db.query('UPDATE client_objective_resource_links SET removed_at=now() WHERE id=$1', [
        associationA,
      ]),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      db.query(
        `UPDATE client_objective_resource_links SET removed_by_user_id=$2,removed_request_id=$3
       WHERE id=$1`,
        [associationA, actor, removedRequest],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    expect((await unlink()).rows).toEqual([{ id: associationA }]);
    const tombstone = (
      await db.query(
        `SELECT removed_at,removed_by_user_id,removed_request_id
       FROM client_objective_resource_links WHERE id=$1`,
        [associationA],
      )
    ).rows;
    for (const change of [
      'removed_at=NULL,removed_by_user_id=NULL,removed_request_id=NULL',
      `removed_by_user_id='${otherActor}'`,
      `removed_request_id='${candidateRequest}'`,
      "removed_at='2028-10-16T12:00:00Z'",
      'removed_at=removed_at',
    ]) {
      await expect(
        db.query(`UPDATE client_objective_resource_links SET ${change} WHERE id=$1`, [
          associationA,
        ]),
      ).rejects.toMatchObject({ code: '23514' });
    }
    expect(
      (
        await db.query(
          `SELECT removed_at,removed_by_user_id,removed_request_id
       FROM client_objective_resource_links WHERE id=$1`,
          [associationA],
        )
      ).rows,
    ).toEqual(tombstone);
  });

  test('receipts enforce scoped request identity and append-only application privileges', async () => {
    await expect(insertReceipt({ request: requestA })).rejects.toMatchObject({ code: '23505' });
    await expect(insertReceipt({ action: 'link', outcome: 'unlinked' })).rejects.toMatchObject({
      code: '23514',
    });
    await expect(insertReceipt({ action: 'unlink', outcome: 'linked' })).rejects.toMatchObject({
      code: '23514',
    });
    await insertReceipt({ actor: otherActor, request: requestA });
    await expect(
      db.query(
        'UPDATE client_objective_operational_receipts SET result_set_version=2 WHERE id=$1',
        [receiptA],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await db.exec('SET ROLE capiro_app');
    await db.query("SELECT set_config('app.current_tenant',$1,false)", [tenantA]);
    for (const statement of [
      'UPDATE client_objective_operational_receipts SET result_set_version=2',
      'DELETE FROM client_objective_operational_receipts',
      'DELETE FROM client_objective_resource_links',
      'DELETE FROM client_objective_operational_states',
    ]) {
      await expect(db.exec(statement)).rejects.toMatchObject({ code: '42501' });
    }
  });

  test.each(['link', 'state', 'receipt'] as const)(
    '%s SQL failure rolls back link, state, and receipt writes in a real transaction',
    async (failure) => {
      const before = await operationalSnapshot();
      await db.exec('BEGIN');
      try {
        await insertLink();
        await db.query(
          `UPDATE client_objective_operational_states SET version=version+1
           WHERE tenant_id=$1 AND client_id=$2 AND objective_id=$3`,
          [tenantA, clientA, objectiveA],
        );
        await insertReceipt({ association: candidateAssociation });
        if (failure === 'link') {
          await expect(insertLink({ id: uuid(41), resource: resourceA })).rejects.toMatchObject({
            code: '23505',
          });
        } else if (failure === 'state') {
          await expect(
            db.query(
              'UPDATE client_objective_operational_states SET version=-1 WHERE objective_id=$1',
              [objectiveA],
            ),
          ).rejects.toMatchObject({ code: '23514' });
        } else {
          await expect(
            insertReceipt({ id: uuid(42), association: candidateAssociation }),
          ).rejects.toMatchObject({ code: '23505' });
        }
      } finally {
        await db.exec('ROLLBACK');
      }
      expect(await operationalSnapshot()).toEqual(before);
    },
  );

  test('synthetic runtime role sees no hidden foreign-tenant rows, counts, updates, or inserts', async () => {
    await db.exec('SET ROLE capiro_app');
    const tables = [
      'client_objective_operational_states',
      'client_objective_resource_links',
      'client_objective_operational_receipts',
    ];
    for (const table of tables) {
      expect((await db.query(`SELECT tenant_id FROM ${table}`)).rows).toEqual([]);
    }
    await db.query("SELECT set_config('app.current_tenant',$1,false)", [tenantA]);
    for (const table of tables) {
      expect((await db.query(`SELECT tenant_id FROM ${table}`)).rows).toEqual([
        { tenant_id: tenantA },
      ]);
      expect((await db.query(`SELECT count(*)::integer AS count FROM ${table}`)).rows).toEqual([
        { count: 1 },
      ]);
      expect((await db.query(`SELECT * FROM ${table} WHERE tenant_id=$1`, [tenantB])).rows).toEqual(
        [],
      );
    }
    expect(
      (
        await db.query(
          'UPDATE client_objective_operational_states SET version=2 WHERE objective_id=$1 RETURNING *',
          [objectiveB],
        )
      ).rows,
    ).toEqual([]);
    expect((await unlink(associationB)).rows).toEqual([]);
    await expect(
      db.query(
        `INSERT INTO client_objective_operational_states(tenant_id,client_id,objective_id)
       VALUES($1,$2,$3)`,
        [tenantB, clientB, objectiveB],
      ),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      insertLink({ tenant: tenantB, client: clientB, objective: objectiveB, revision: revisionB1 }),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      insertReceipt({
        tenant: tenantB,
        client: clientB,
        objective: objectiveB,
        association: associationB,
        commandRevision: revisionB2,
        linkedRevision: revisionB1,
      }),
    ).rejects.toMatchObject({ code: '42501' });
    await db.query("SELECT set_config('app.current_tenant',$1,false)", [tenantB]);
    for (const table of tables) {
      expect((await db.query(`SELECT tenant_id FROM ${table}`)).rows).toEqual([
        { tenant_id: tenantB },
      ]);
    }
  });

  // Core/source authority acquisition is covered by the service/owner suites.
  // These regressions execute the production store against real checked-in SQL.
  test('actual store commits one new association, exact recoverable receipt, and one set increment', async () => {
    const command = storeLink();
    const validateSource = jest.fn(async () => undefined);
    const receipt = await storeTransaction((tx) =>
      commitOperationalCommand(tx, storeActor, storeScope, command, validateSource),
    );
    expect(receipt).toEqual({
      schemaVersion: 1,
      requestId: command.requestId,
      clientId: clientA,
      objectiveId: objectiveA,
      action: 'link',
      outcome: 'linked',
      associationId: expect.any(String),
      commandRevision: { id: revisionA2, version: 2 },
      associationLinkedRevision: { id: revisionA2, version: 2 },
      resultSetVersion: 2,
      payloadDigest: operationalDigest(command),
      committedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    });
    expect(validateSource).toHaveBeenCalledTimes(1);
    expect(await findOperationalReceipt(sqlTx, storeActor, storeScope, command.requestId)).toEqual(
      receipt,
    );
    expect(await readOperationalSetVersion(sqlTx, storeActor, storeScope)).toBe(2);
    expect(
      (
        await db.query(
          `SELECT id,linked_revision_id,linked_objective_version,resource_kind,resource_id,cycles
       FROM client_objective_resource_links WHERE id=$1`,
          [receipt.associationId],
        )
      ).rows,
    ).toEqual([
      {
        id: receipt.associationId,
        linked_revision_id: revisionA2,
        linked_objective_version: 2,
        resource_kind: 'strategy',
        resource_id: command.resource.id,
        cycles: [],
      },
    ]);
    expect(
      (
        await db.query(
          `SELECT command,payload_digest,result_set_version FROM client_objective_operational_receipts
       WHERE tenant_id=$1 AND actor_user_id=$2 AND request_id=$3`,
          [tenantA, actor, command.requestId],
        )
      ).rows,
    ).toEqual([
      {
        command,
        payload_digest: operationalDigest(command),
        result_set_version: 2,
      },
    ]);
    expect(
      await findOperationalReceipt(
        sqlTx,
        { ...storeActor, userId: otherActor },
        storeScope,
        command.requestId,
      ),
    ).toBeNull();
    expect(
      await findOperationalReceipt(
        sqlTx,
        { ...storeActor, tenantId: tenantB },
        storeScope,
        command.requestId,
      ),
    ).toBeNull();
  });

  test('actual store replays the exact historical receipt before current Objective and set CAS', async () => {
    const command = storeLink();
    const original = await storeTransaction((tx) =>
      commitOperationalCommand(tx, storeActor, storeScope, command, async () => undefined),
    );
    const before = await operationalSnapshot();
    const laterScope = { ...storeScope, currentRevisionId: uuid(120), objectiveVersion: 3 };
    const validateSource = jest.fn(async () => undefined);
    await db.exec('BEGIN');
    try {
      await db.query('UPDATE client_objectives SET version=3 WHERE id=$1', [objectiveA]);
      await db.query(
        `INSERT INTO client_objective_revisions
         (id,tenant_id,client_id,objective_id,version,operation,actor_user_id,snapshot)
         VALUES($1,$2,$3,$4,3,'edit',$5,'{}')`,
        [laterScope.currentRevisionId, tenantA, clientA, objectiveA, actor],
      );
      expect(
        await commitOperationalCommand(sqlTx, storeActor, laterScope, command, validateSource),
      ).toEqual(original);
      expect(
        await findOperationalReceipt(sqlTx, storeActor, laterScope, command.requestId),
      ).toEqual(original);
      await expect(
        commitOperationalCommand(
          sqlTx,
          storeActor,
          laterScope,
          { ...command, requestId: uuid(121) },
          validateSource,
        ),
      ).rejects.toMatchObject({ response: { status: 409, code: 'OBJECTIVE_VERSION_CONFLICT' } });
      await expect(
        commitOperationalCommand(
          sqlTx,
          storeActor,
          laterScope,
          { ...command, requestId: uuid(122), expectedObjectiveVersion: 3 },
          validateSource,
        ),
      ).rejects.toMatchObject({ response: { status: 409, code: 'ASSOCIATION_VERSION_CONFLICT' } });
      expect(validateSource).not.toHaveBeenCalled();
      expect(await operationalSnapshot()).toEqual(before);
      expect(await readOperationalSetVersion(sqlTx, storeActor, laterScope)).toBe(2);
    } finally {
      // Advancing the synthetic Objective is local to this regression.
      await db.exec('ROLLBACK');
    }
    expect(await operationalSnapshot()).toEqual(before);
  });

  test('actual store rejects changed payload under the same request UUID without another write', async () => {
    const command = storeLink();
    const receipt = await storeTransaction((tx) =>
      commitOperationalCommand(tx, storeActor, storeScope, command, async () => undefined),
    );
    const before = await operationalSnapshot();
    const validateSource = jest.fn(async () => undefined);
    await expect(
      storeTransaction((tx) =>
        commitOperationalCommand(
          tx,
          storeActor,
          storeScope,
          { ...command, resource: { ...command.resource, id: uuid(102) } },
          validateSource,
        ),
      ),
    ).rejects.toMatchObject({
      response: { status: 409, code: 'REQUEST_CONFLICT', requestId: command.requestId },
    });
    expect(validateSource).not.toHaveBeenCalled();
    expect(await operationalSnapshot()).toEqual(before);
    expect(await findOperationalReceipt(sqlTx, storeActor, storeScope, command.requestId)).toEqual(
      receipt,
    );
  });

  test('actual store source-validation failure rolls back its newly initialized state row', async () => {
    await db.query('DELETE FROM client_objective_operational_states WHERE objective_id=$1', [
      objectiveA,
    ]);
    const before = await operationalSnapshot();
    const command = storeLink({ requestId: uuid(103), expectedAssociationSetVersion: 0 });
    const unavailable = new Error('synthetic source validation failed');
    const validateSource = jest.fn(async () => {
      throw unavailable;
    });
    await expect(
      storeTransaction((tx) =>
        commitOperationalCommand(tx, storeActor, storeScope, command, validateSource),
      ),
    ).rejects.toBe(unavailable);
    expect(validateSource).toHaveBeenCalledTimes(1);
    expect(await operationalSnapshot()).toEqual(before);
    expect(await readOperationalSetVersion(sqlTx, storeActor, storeScope)).toBe(0);
    expect(
      await findOperationalReceipt(sqlTx, storeActor, storeScope, command.requestId),
    ).toBeNull();
  });

  test.each(['link', 'unlink'] as const)(
    'actual store %s receipt SQL failure rolls back association, tombstone, and set changes',
    async (action) => {
      const command: OperationalCommand =
        action === 'link'
          ? storeLink({ requestId: uuid(104) })
          : {
              schemaVersion: 1,
              action: 'unlink',
              requestId: uuid(104),
              clientId: clientA,
              objectiveId: objectiveA,
              expectedObjectiveVersion: 2,
              expectedAssociationSetVersion: 1,
              associationId: associationA,
            };
      const before = await operationalSnapshot();
      const validateSource = jest.fn(async () => undefined);
      await expect(
        storeTransaction(async (tx) => {
          // The trigger is a transactional fixture and is removed by the same rollback.
          await db.exec(`
          CREATE FUNCTION reject_operational_receipt_fixture() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN
            IF NEW.request_id='${command.requestId}'::uuid THEN
              RAISE EXCEPTION 'synthetic receipt failure' USING ERRCODE='23514';
            END IF;
            RETURN NEW;
          END $$;
          CREATE TRIGGER reject_operational_receipt_fixture BEFORE INSERT
            ON client_objective_operational_receipts FOR EACH ROW
            EXECUTE FUNCTION reject_operational_receipt_fixture();
        `);
          return commitOperationalCommand(tx, storeActor, storeScope, command, validateSource);
        }),
      ).rejects.toMatchObject({ code: '23514' });
      expect(validateSource).toHaveBeenCalledTimes(action === 'link' ? 1 : 0);
      expect(await operationalSnapshot()).toEqual(before);
      expect(await readOperationalSetVersion(sqlTx, storeActor, storeScope)).toBe(1);
      expect(
        await findOperationalReceipt(sqlTx, storeActor, storeScope, command.requestId),
      ).toBeNull();
    },
  );

  test('actual store treats reordered equal cycles as a new-request no-op but a same-UUID digest conflict', async () => {
    const firstCycle = {
      fiscalYear: 2028,
      authorityTrack: 'authorization',
      basis: 'human_annotation' as const,
      context: null,
    };
    const secondCycle = {
      fiscalYear: 2029,
      authorityTrack: null,
      basis: 'human_annotation' as const,
      context: null,
    };
    const command = storeLink({ requestId: uuid(105), cycles: [firstCycle, secondCycle] });
    const validateSource = jest.fn(async () => undefined);
    const original = await storeTransaction((tx) =>
      commitOperationalCommand(tx, storeActor, storeScope, command, validateSource),
    );
    const reordered = {
      ...command,
      requestId: uuid(106),
      expectedAssociationSetVersion: 2,
      cycles: [secondCycle, firstCycle],
    };
    const unchanged = await storeTransaction((tx) =>
      commitOperationalCommand(tx, storeActor, storeScope, reordered, validateSource),
    );
    expect(unchanged).toMatchObject({
      requestId: reordered.requestId,
      outcome: 'unchanged',
      associationId: original.associationId,
      commandRevision: { id: revisionA2, version: 2 },
      associationLinkedRevision: { id: revisionA2, version: 2 },
      payloadDigest: operationalDigest(reordered),
      resultSetVersion: 2,
    });
    expect(validateSource).toHaveBeenCalledTimes(2);
    expect(await readOperationalSetVersion(sqlTx, storeActor, storeScope)).toBe(2);
    expect(
      await findOperationalReceipt(sqlTx, storeActor, storeScope, reordered.requestId),
    ).toEqual(unchanged);
    expect(
      (
        await db.query('SELECT cycles FROM client_objective_resource_links WHERE id=$1', [
          original.associationId,
        ])
      ).rows,
    ).toEqual([{ cycles: command.cycles }]);
    const before = await operationalSnapshot();
    await expect(
      storeTransaction((tx) =>
        commitOperationalCommand(
          tx,
          storeActor,
          storeScope,
          { ...command, cycles: [secondCycle, firstCycle] },
          validateSource,
        ),
      ),
    ).rejects.toMatchObject({ response: { status: 409, code: 'REQUEST_CONFLICT' } });
    expect(validateSource).toHaveBeenCalledTimes(2);
    expect(await operationalSnapshot()).toEqual(before);
    expect(await findOperationalReceipt(sqlTx, storeActor, storeScope, command.requestId)).toEqual(
      original,
    );
  });

  test('actual store unlink, repeated unlink, and relink preserve old revision and create a fresh identity', async () => {
    const command: OperationalUnlinkCommand = {
      schemaVersion: 1,
      action: 'unlink',
      requestId: uuid(110),
      clientId: clientA,
      objectiveId: objectiveA,
      expectedObjectiveVersion: 2,
      expectedAssociationSetVersion: 1,
      associationId: associationA,
    };
    const validateSource = jest.fn(async () => undefined);
    const unlinked = await storeTransaction((tx) =>
      commitOperationalCommand(tx, storeActor, storeScope, command, validateSource),
    );
    expect(unlinked).toMatchObject({
      action: 'unlink',
      outcome: 'unlinked',
      associationId: associationA,
      resultSetVersion: 2,
      commandRevision: { id: revisionA2, version: 2 },
      associationLinkedRevision: { id: revisionA1, version: 1 },
    });
    const originalTombstone = (
      await db.query(
        `SELECT removed_at,removed_by_user_id,removed_request_id
       FROM client_objective_resource_links WHERE id=$1`,
        [associationA],
      )
    ).rows;
    const unchanged = await storeTransaction((tx) =>
      commitOperationalCommand(
        tx,
        storeActor,
        storeScope,
        { ...command, requestId: uuid(111), expectedAssociationSetVersion: 2 },
        validateSource,
      ),
    );
    expect(unchanged).toMatchObject({
      action: 'unlink',
      outcome: 'unchanged',
      associationId: associationA,
      resultSetVersion: 2,
      associationLinkedRevision: { id: revisionA1, version: 1 },
    });
    const relink = storeLink({
      requestId: uuid(112),
      resource: { kind: 'strategy', id: resourceA },
      expectedAssociationSetVersion: 2,
    });
    const relinked = await storeTransaction((tx) =>
      commitOperationalCommand(tx, storeActor, storeScope, relink, validateSource),
    );
    expect(relinked).toMatchObject({
      action: 'link',
      outcome: 'linked',
      resultSetVersion: 3,
      commandRevision: { id: revisionA2, version: 2 },
      associationLinkedRevision: { id: revisionA2, version: 2 },
    });
    expect(relinked.associationId).not.toBe(associationA);
    const oldIdentityNoop = await storeTransaction((tx) =>
      commitOperationalCommand(
        tx,
        storeActor,
        storeScope,
        { ...command, requestId: uuid(113), expectedAssociationSetVersion: 3 },
        validateSource,
      ),
    );
    expect(oldIdentityNoop).toMatchObject({
      action: 'unlink',
      outcome: 'unchanged',
      associationId: associationA,
      resultSetVersion: 3,
      associationLinkedRevision: { id: revisionA1, version: 1 },
    });
    expect(validateSource).toHaveBeenCalledTimes(1);
    expect(await readOperationalSetVersion(sqlTx, storeActor, storeScope)).toBe(3);
    expect(await findOperationalReceipt(sqlTx, storeActor, storeScope, command.requestId)).toEqual(
      unlinked,
    );
    expect(
      (
        await db.query(
          `SELECT removed_at,removed_by_user_id,removed_request_id
       FROM client_objective_resource_links WHERE id=$1`,
          [associationA],
        )
      ).rows,
    ).toEqual(originalTombstone);
    expect(
      (
        await db.query(
          `SELECT linked_revision_id,linked_objective_version,removed_request_id,
        removed_at IS NOT NULL AS removed FROM client_objective_resource_links WHERE id=$1`,
          [associationA],
        )
      ).rows,
    ).toEqual([
      {
        linked_revision_id: revisionA1,
        linked_objective_version: 1,
        removed_request_id: command.requestId,
        removed: true,
      },
    ]);
    expect(
      (
        await db.query(
          `SELECT id FROM client_objective_resource_links
       WHERE objective_id=$1 AND resource_kind='strategy' AND resource_id=$2 AND removed_at IS NULL`,
          [objectiveA, resourceA],
        )
      ).rows,
    ).toEqual([{ id: relinked.associationId }]);
  });

  test('actual Core SQL resolves current revision and requires fresh membership and wall grants before receipt recovery', async () => {
    const command = storeLink({ requestId: uuid(220) });
    const receipt = await storeTransaction((tx) =>
      commitOperationalCommand(tx, storeActor, storeScope, command, async () => undefined),
    );
    const before = await operationalSnapshot();
    async function recoverAfterFreshAuthority() {
      const current = await loadCurrentOperationalScopeWithinTx(
        sqlTx,
        storeActor,
        clientA,
        objectiveA,
      );
      return findOperationalReceipt(sqlTx, storeActor, current, command.requestId);
    }
    await db.exec('BEGIN');
    try {
      await db.query('UPDATE client_objectives SET version=3 WHERE id=$1', [objectiveA]);
      await db.query(
        `INSERT INTO client_objective_revisions
         (id,tenant_id,client_id,objective_id,version,operation,actor_user_id,snapshot)
         VALUES($1,$2,$3,$4,3,'edit',$5,'{}')`,
        [uuid(221), tenantA, clientA, objectiveA, actor],
      );
      expect(
        await loadCurrentOperationalScopeWithinTx(sqlTx, storeActor, clientA, objectiveA),
      ).toEqual({ ...storeScope, currentRevisionId: uuid(221), objectiveVersion: 3 });
      expect(await recoverAfterFreshAuthority()).toEqual(receipt);

      await db.query(
        "UPDATE tenant_memberships SET status='revoked' WHERE tenant_id=$1 AND user_id=$2",
        [tenantA, actor],
      );
      await expect(recoverAfterFreshAuthority()).rejects.toMatchObject({
        response: { status: 404, code: 'NOT_AVAILABLE' },
      });
      // The receipt still exists; its existence does not satisfy current authority.
      expect(
        (
          await db.query(
            'SELECT count(*)::integer AS count FROM client_objective_operational_receipts WHERE request_id=$1',
            [command.requestId],
          )
        ).rows,
      ).toEqual([{ count: 1 }]);

      await db.query(
        "UPDATE tenant_memberships SET status='active' WHERE tenant_id=$1 AND user_id=$2",
        [tenantA, actor],
      );
      await db.query('UPDATE clients SET memory_wall=true WHERE id=$1', [clientA]);
      await db.query(
        'INSERT INTO client_memory_access(tenant_id,client_id,user_id) VALUES($1,$2,$3)',
        [tenantA, clientAOther, actor],
      );
      await expect(recoverAfterFreshAuthority()).rejects.toMatchObject({
        response: { status: 404, code: 'NOT_AVAILABLE' },
      });
      await db.query(
        'INSERT INTO client_memory_access(tenant_id,client_id,user_id) VALUES($1,$2,$3)',
        [tenantA, clientA, actor],
      );
      expect(await recoverAfterFreshAuthority()).toEqual(receipt);
    } finally {
      await db.exec('ROLLBACK');
    }
    expect(await operationalSnapshot()).toEqual(before);
  });

  test('actual Planner CTE joins typed arrays, JSON memberships, and exact grants with uppercase client data', async () => {
    await db.exec('BEGIN');
    try {
      await seedPlanOwnerFixture();
      const project = await readPlanOwner({ kind: 'planner_project', id: ownerProject });
      expect(project).toMatchObject({
        resource: {
          selection: { kind: 'planner_project', id: ownerProject },
          title: 'Current human project',
          ownerVersion: { kind: 'counter', value: 7 },
        },
        taskSourceUnavailable: true,
        tasks: [
          {
            resource: {
              selection: { kind: 'planner_task', id: ownerTask },
              title: 'Current human approval',
            },
            status: 'blocked',
            subtype: 'approval',
            approval: 'pending',
            overdue: true,
            projectIds: [ownerProject],
          },
          {
            resource: {
              selection: { kind: 'planner_task', id: ownerJsonOnlyTask },
              title: 'Completed human milestone',
            },
            status: 'done',
            subtype: 'milestone',
            approval: 'approved',
            overdue: false,
            projectIds: [ownerProject],
          },
        ],
      });
      expect(project?.tasks?.map((task) => task.resource.selection.id)).toEqual([
        ownerTask,
        ownerJsonOnlyTask,
      ]);
      expect(await readPlanOwner({ kind: 'planner_task', id: ownerTask })).toMatchObject({
        resource: { title: 'Current human approval', ownerVersion: { kind: 'counter', value: 11 } },
        tasks: [{ projectIds: [ownerProject], status: 'blocked', subtype: 'approval' }],
      });
      // Uppercase membership discovery marks incomplete coverage without widening raw owner grants.
      expect(
        await readPlanOwner({ kind: 'planner_task', id: ownerUppercaseMembershipTask }),
      ).toBeNull();
      expect(await readPlanOwner({ kind: 'planner_task', id: ownerPrivateTask })).toBeNull();
      const archivedParentGrant = await readPlanOwner({
        kind: 'planner_task',
        id: ownerArchivedGrantTask,
      });
      expect(archivedParentGrant).toMatchObject({
        resource: { selection: { kind: 'planner_task', id: ownerArchivedGrantTask } },
        tasks: [{ projectIds: [] }],
      });
      expect(JSON.stringify(archivedParentGrant)).not.toContain(ownerArchivedGrant);
      expect(JSON.stringify(archivedParentGrant)).not.toContain('Private archived grant metadata');
      expect(await readPlanOwner({ kind: 'planner_task', id: uuid(208) })).toBeNull();
      expect(await readPlanOwner({ kind: 'planner_task', id: uuid(209) })).toBeNull();
    } finally {
      await db.exec('ROLLBACK');
    }
  });

  test('actual owner SQL observes revoked Planner grants, current human edits, and a disabled Strategy rollout flag', async () => {
    await db.exec('BEGIN');
    try {
      await seedPlanOwnerFixture();
      expect(await readPlanOwner({ kind: 'planner_project', id: ownerProject })).not.toBeNull();
      await db.query(
        `UPDATE sp_planner_projects SET data=jsonb_set(data,'{members}','[]'::jsonb),version=version+1
         WHERE id=$1`,
        [ownerProject],
      );
      expect(await readPlanOwner({ kind: 'planner_project', id: ownerProject })).toBeNull();
      expect(await readPlanOwner({ kind: 'planner_task', id: ownerTask })).toBeNull();
      await db.query('UPDATE sp_planner_tasks SET data=data||$2::jsonb,version=12 WHERE id=$1', [
        ownerTask,
        JSON.stringify({
          assigneeId: storeActor.clerkUserId,
          name: 'Human revised milestone',
          status: 'done',
          subtype: 'milestone',
          approval: 'approved',
        }),
      ]);
      expect(await readPlanOwner({ kind: 'planner_task', id: ownerTask })).toMatchObject({
        resource: {
          title: 'Human revised milestone',
          ownerVersion: { kind: 'counter', value: 12 },
        },
        tasks: [
          {
            status: 'done',
            subtype: 'milestone',
            approval: 'approved',
            overdue: false,
            projectIds: [],
          },
        ],
      });
      // PGlite interprets the canonical naive timestamp using the host timezone.
      // Preserve its actual driver Date; this is not native Prisma timestamp proof.
      const rawStrategy = await db.query<{ updated_at: Date }>(
        'SELECT updated_at FROM sp_strategy WHERE id=$1',
        [ownerStrategy],
      );
      expect(rawStrategy.rows).toHaveLength(1);
      expect(await readPlanOwner({ kind: 'strategy', id: ownerStrategy })).toMatchObject({
        resource: {
          title: 'Current human Strategy',
          ownerVersion: { kind: 'timestamp', value: rawStrategy.rows[0]!.updated_at.toISOString() },
        },
        strategyType: 'coalition',
      });
      for (const flag of [false, 'true', null]) {
        await db.query('UPDATE tenants SET settings_jsonb=$2::jsonb WHERE id=$1', [
          tenantA,
          JSON.stringify({ clioFeatureFlags: { 'strategyPlanner.enabled': flag } }),
        ]);
        expect(await readPlanOwner({ kind: 'strategy', id: ownerStrategy })).toBeNull();
      }
    } finally {
      await db.exec('ROLLBACK');
    }
  });
});
