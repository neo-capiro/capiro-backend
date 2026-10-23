import { ObjectiveOperationalService } from '../../src/clients/objectives/operational/objective-operational.service.js';
import { fixture, actor, tenant, client, ctx, id } from './fixture.js';

export const objective = id(200),
  revision = id(201);
export const sources = [id(210), id(211), id(212), id(213)];
export const links = [id(220), id(221), id(222), id(223)];

export async function associationsFixture() {
  const h = await fixture('associations');
  const service = new ObjectiveOperationalService(h.prisma);
  const reset = async () => {
    await h.reset();
    await h.sql(
      `INSERT INTO client_objectives
      (id,tenant_id,client_id,created_by_user_id,client_request_id,create_request_hash)
      VALUES($1,$2,$3,$4,$5,repeat('a',64))`,
      [objective, tenant, client, actor, id(202)],
    );
    await h.sql(
      `INSERT INTO client_objective_revisions
      (id,tenant_id,client_id,objective_id,version,operation,actor_user_id,snapshot)
      VALUES($1,$2,$3,$4,1,'create',$5,'{}')`,
      [revision, tenant, client, objective, actor],
    );
    await h.sql(
      `INSERT INTO client_objective_operational_states
      (tenant_id,client_id,objective_id,version) VALUES($1,$2,$3,4)`,
      [tenant, client, objective],
    );
    for (let i = 0; i < sources.length; i++) {
      const kind = i === 0 ? 'strategy' : i === 3 ? 'planner_task' : 'planner_project';
      if (kind === 'strategy') {
        await h.sql(
          `INSERT INTO sp_strategy(id,tenant_id,client_id,title,type,updated_at)
          VALUES($1,$2,$3,'Synthetic strategy','authorization','2026-10-23T00:00:00Z')`,
          [sources[i], tenant, client],
        );
      } else {
        const data = JSON.stringify({
          clientId: client,
          name: `Synthetic ${kind} ${i}`,
          privacy: 'private',
        });
        // Table choice is fixed fixture code, never a request value.
        const table = kind === 'planner_task' ? 'sp_planner_tasks' : 'sp_planner_projects';
        await h.sql(
          `INSERT INTO ${table}(id,tenant_id,owner_id,data,updated_at)
          VALUES($1,$2,$3,$4::jsonb,'2026-10-23T00:00:00Z')`,
          [sources[i], tenant, ctx.clerkUserId, data],
        );
      }
      await h.sql(
        `INSERT INTO client_objective_resource_links
        (id,tenant_id,client_id,objective_id,linked_revision_id,linked_objective_version,
         resource_kind,resource_id,linked_by_user_id)
        VALUES($1,$2,$3,$4,$5,1,$6,$7,$8)`,
        [links[i], tenant, client, objective, revision, kind, sources[i], actor],
      );
    }
  };
  return { ...h, reset, service };
}
