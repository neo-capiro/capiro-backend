import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ActivityCommandService } from '../../src/clients/activity-commands/activity-command.service.js';
import { ClientActivityService } from '../../src/clients/client-activity.service.js';
import { fixture } from './fixture.js';

export const undoMigration = () =>
  readFileSync(
    resolve(
      __dirname,
      '../../prisma/migrations/20281024060000_client_activity_command_undo/migration.sql',
    ),
    'utf8',
  );
/** Run this spec alone in a fresh guarded disposable database. Reuses the file
 * fixture's canonical authority tables; no changes to the sealed 22-case suite. */
export async function activityUndoFixture() {
  const h = await fixture('files');
  try {
    await h.sql(`
      CREATE TYPE tenant_status AS ENUM ('active','suspended','pending');
      ALTER TABLE tenants ADD status tenant_status NOT NULL DEFAULT 'active';
      CREATE FUNCTION uuid_generate_v4() RETURNS uuid LANGUAGE sql AS $$ SELECT gen_random_uuid() $$;
      CREATE TABLE client_activity (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        client_id uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,kind varchar(24) NOT NULL,
        occurred_at timestamptz NOT NULL DEFAULT now(),title text NOT NULL,body text,
        actor_user_id uuid,person_id uuid,source_type varchar(32),source_id varchar(128),
        pinned boolean NOT NULL DEFAULT false,due_at timestamptz,settled_at timestamptz,
        metadata_jsonb jsonb NOT NULL DEFAULT '{}',created_by_user_id uuid,
        created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
      );
      ALTER TABLE client_activity ENABLE ROW LEVEL SECURITY;
      ALTER TABLE client_activity FORCE ROW LEVEL SECURITY;
      CREATE POLICY activity_tenant ON client_activity USING(tenant_id=current_tenant_id()) WITH CHECK(tenant_id=current_tenant_id());
      GRANT SELECT,INSERT,UPDATE,DELETE ON client_activity TO capiro_app;
    `);
    await h.sql(
      readFileSync(
        resolve(
          __dirname,
          '../../prisma/migrations/20281012010000_client_activity_commands/migration.sql',
        ),
        'utf8',
      ),
    );
    await h.sql(undoMigration());
    await h.sql(undoMigration());
    const activities = new ClientActivityService(h.prisma, {} as never);
    const service = new ActivityCommandService(h.prisma, activities, {
      origin: () => {
        throw Error('Unexpected Planner operation');
      },
      lookup: () => {
        throw Error('Unexpected Planner operation');
      },
      create: () => {
        throw Error('Unexpected Planner operation');
      },
    } as never);
    return { ...h, service };
  } catch (error) {
    await h.close();
    throw error;
  }
}
