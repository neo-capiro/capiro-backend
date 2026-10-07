/** Compact authorized topology, independent of task search/filter and task-list pagination. */
export interface PlannerTimeTreeNode {
  id: string;
  parentId: string | null;
  version: number;
  scoped: boolean;
  estimateMinutes: number;
  actualMinutes: number;
}
export interface PlannerTimeTreePage {
  nodes: PlannerTimeTreeNode[];
  revision: string;
  matched: number;
  nextCursor: string | null;
}
export interface PlannerTimeRollup {
  estimateMinutes: number;
  actualMinutes: number;
  childCount: number;
  descendantCount: number;
}
export function plannerTimeLabel(minutes: number) {
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}`;
}
/** Leaf-first accumulation avoids recursion limits on deeply nested work. */
export function plannerTimeRollups(nodes: PlannerTimeTreeNode[]) {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  if (byId.size !== nodes.length) throw new Error('Duplicate tasks in the time tree');
  const children = new Map<string, string[]>();
  for (const node of nodes) {
    if (
      !Number.isSafeInteger(node.estimateMinutes) ||
      node.estimateMinutes < 0 ||
      !Number.isSafeInteger(node.actualMinutes) ||
      node.actualMinutes < 0
    )
      throw new Error('Invalid task time');
    if (node.parentId && byId.has(node.parentId)) {
      const ids = children.get(node.parentId) ?? [];
      ids.push(node.id);
      children.set(node.parentId, ids);
    }
  }
  const remaining = new Map(nodes.map((node) => [node.id, children.get(node.id)?.length ?? 0]));
  const values = new Map<string, PlannerTimeRollup>(
    nodes.map((node) => [
      node.id,
      {
        estimateMinutes: node.estimateMinutes,
        actualMinutes: node.actualMinutes,
        childCount: remaining.get(node.id)!,
        descendantCount: 0,
      },
    ]),
  );
  const queue = nodes.filter((node) => !remaining.get(node.id)).map((node) => node.id);
  for (let index = 0; index < queue.length; index++) {
    const id = queue[index]!,
      node = byId.get(id)!,
      parent = node.parentId && values.get(node.parentId);
    if (!parent) continue;
    const child = values.get(id)!;
    parent.estimateMinutes += child.estimateMinutes;
    parent.actualMinutes += child.actualMinutes;
    parent.descendantCount += child.descendantCount + 1;
    if (
      !Number.isSafeInteger(parent.estimateMinutes) ||
      !Number.isSafeInteger(parent.actualMinutes)
    )
      throw new Error('Task time exceeds the supported total');
    const left = remaining.get(node.parentId!)! - 1;
    remaining.set(node.parentId!, left);
    if (!left) queue.push(node.parentId!);
  }
  if (queue.length !== nodes.length) throw new Error('The task hierarchy contains a cycle');
  return { values, children };
}
/** Sections count each task once even when both an ancestor and descendant match. */
export function plannerTimeTotal(nodes: PlannerTimeTreeNode[], rootIds: string[]) {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const { children } = plannerTimeRollups(nodes),
    visited = new Set<string>();
  const pending = [...rootIds];
  let estimateMinutes = 0,
    actualMinutes = 0;
  while (pending.length) {
    const id = pending.pop()!;
    if (visited.has(id)) continue;
    const node = byId.get(id);
    if (!node) continue;
    visited.add(id);
    estimateMinutes += node.estimateMinutes;
    actualMinutes += node.actualMinutes;
    pending.push(...(children.get(id) ?? []));
  }
  if (!Number.isSafeInteger(estimateMinutes) || !Number.isSafeInteger(actualMinutes))
    throw new Error('Task time exceeds the supported total');
  return { estimateMinutes, actualMinutes, tasks: visited.size };
}
