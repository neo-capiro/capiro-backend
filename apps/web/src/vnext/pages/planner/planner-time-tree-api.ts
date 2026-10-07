import { useQuery } from '@tanstack/react-query';
import type { PlannerTimeTreePage, PlannerTimeTreeNode } from '@capiro/strategy-verifier';
import { plannerTimeRollups } from '@capiro/strategy-verifier';
import { useApi } from '../../../lib/use-api.js';
import { usePlannerKey } from './planner-api.js';
export type PlannerTimeTreeScope = {
  projectId?: string;
  taskId?: string;
  mine?: string;
  archived?: string;
};

/** Publish a complete, finally verified tree. A failed page never becomes a partial total. */
export function usePlannerTimeTree(scope: PlannerTimeTreeScope, enabled: boolean) {
  const api = useApi(),
    key = usePlannerKey();
  return useQuery({
    queryKey: [...key, 'time-tree', scope],
    enabled,
    retry: false,
    refetchInterval: 30_000,
    queryFn: async ({ signal }) => {
      let page = (
        await api.get<PlannerTimeTreePage>('/strategy-api/planner/time/tree', {
          params: scope,
          signal,
        })
      ).data;
      const revision = page.revision,
        matched = page.matched,
        nodes: PlannerTimeTreeNode[] = [];
      const ids = new Set<string>(),
        cursors = new Set<string>();
      let pages = 0;
      for (;;) {
        if (page.revision !== revision || page.matched !== matched)
          throw new Error('Task time changed. Refresh the time tree.');
        for (const node of page.nodes) {
          if (ids.has(node.id)) throw new Error('The time tree contains repeated tasks.');
          ids.add(node.id);
          nodes.push(node);
        }
        pages++;
        if (!page.nextCursor) break;
        if (cursors.has(page.nextCursor) || !page.nodes.length)
          throw new Error('Time tree paging did not advance.');
        cursors.add(page.nextCursor);
        page = (
          await api.get<PlannerTimeTreePage>('/strategy-api/planner/time/tree', {
            params: { ...scope, cursor: page.nextCursor, revision },
            signal,
          })
        ).data;
      }
      if (nodes.length !== matched) throw new Error('The time tree is incomplete.');
      if (pages > 1) {
        const verified = await api.get<PlannerTimeTreePage>('/strategy-api/planner/time/tree', {
          params: { ...scope, revision },
          signal,
        });
        if (verified.data.revision !== revision || verified.data.matched !== matched)
          throw new Error('Task time changed during verification.');
      }
      plannerTimeRollups(nodes);
      return nodes;
    },
  });
}
