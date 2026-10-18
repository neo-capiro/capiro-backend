/** Planner owner's pure access decisions. Callers normalize their own stored data first. */
export type PlannerResourceRole = 'admin' | 'editor' | 'commenter' | 'viewer';
export interface PlannerResourceProjectAccess {
  id?: string;
  ownerId: string;
  data: {
    privacy: 'private' | 'team';
    members: { userId: string; role: PlannerResourceRole }[];
  };
}
export interface PlannerResourceTaskAccess {
  ownerId: string;
  data: {
    memberships: { projectId: string }[];
    assigneeId: string | null;
    collaborators: string[];
  };
}
const RANK: Record<PlannerResourceRole, number> = { viewer: 0, commenter: 1, editor: 2, admin: 3 };

export function plannerProjectAccessDecision(
  project: PlannerResourceProjectAccess,
  userId: string,
): PlannerResourceRole | null {
  if (project.ownerId === userId) return 'admin';
  const grant = project.data.members.find((m) => m.userId === userId);
  return grant?.role ?? (project.data.privacy === 'team' ? 'editor' : null);
}

export function plannerTaskAccessDecision(
  task: PlannerResourceTaskAccess,
  projects: readonly PlannerResourceProjectAccess[],
  userId: string,
): PlannerResourceRole | null {
  const data = task.data;
  const roles = data.memberships.flatMap((m) => {
    const p = projects.find((p) => p.id === m.projectId);
    const role = p && plannerProjectAccessDecision(p, userId);
    return role ? [role] : [];
  });
  if ((!data.memberships.length && task.ownerId === userId) || data.assigneeId === userId)
    roles.push('editor');
  if (data.collaborators.includes(userId)) roles.push('commenter');
  return roles.sort((a, b) => RANK[b] - RANK[a])[0] ?? null;
}
