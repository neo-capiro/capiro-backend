import { addDaysInZone, ymdInZone } from './time-zone';

export type ScheduleIssueCode =
  | 'deadline_passed'
  | 'milestone_after_deadline'
  | 'milestone_before_as_of'
  | 'order_conflict'
  | 'insufficient_runway';

export interface ScheduleIssue {
  code: ScheduleIssueCode;
  milestoneId?: string;
  deadlineId?: string;
  detail: string;
}

interface NamedDate {
  id: string;
  label: string;
  date: string;
}

export function validateSchedule(input: {
  asOf: string;
  deadlines: NamedDate[];
  milestones: Array<NamedDate & { dependsOn?: string[] }>;
}): { ok: boolean; issues: ScheduleIssue[] } {
  const issues: ScheduleIssue[] = [];
  const asOf = timestamp(input.asOf);
  const deadlines = input.deadlines.map((deadline) => ({ ...deadline, at: timestamp(deadline.date) }));
  const earliest = deadlines.filter((item) => item.at != null).sort((a, b) => a.at! - b.at!)[0];

  for (const deadline of deadlines) {
    if (deadline.at != null && asOf != null && deadline.at < asOf) {
      issues.push({ code: 'deadline_passed', deadlineId: deadline.id, detail: `${deadline.label} has passed.` });
    }
  }

  const milestoneDates = new Map(input.milestones.map((item) => [item.id, timestamp(item.date)]));
  for (const milestone of input.milestones) {
    const at = milestoneDates.get(milestone.id) ?? null;
    if (at == null) continue;
    if (asOf != null && at < asOf) {
      issues.push({ code: 'milestone_before_as_of', milestoneId: milestone.id, detail: `${milestone.label} is before the as-of time.` });
    }
    if (earliest?.at != null && at > earliest.at) {
      issues.push({ code: 'milestone_after_deadline', milestoneId: milestone.id, deadlineId: earliest.id, detail: `${milestone.label} falls after ${earliest.label}.` });
    }
    for (const dependencyId of milestone.dependsOn ?? []) {
      const dependencyAt = milestoneDates.get(dependencyId);
      if (dependencyAt != null && dependencyAt > at) {
        issues.push({ code: 'order_conflict', milestoneId: milestone.id, detail: `${milestone.label} is scheduled before dependency ${dependencyId}.` });
      }
    }
  }

  if (asOf != null && earliest?.at != null && earliest.at >= asOf) {
    const earliestAt = earliest.at;
    const futureMilestones = input.milestones
      .map((item) => milestoneDates.get(item.id))
      .filter((at): at is number => at != null && at >= asOf && at <= earliestAt);
    if (input.milestones.length > 0 && futureMilestones.length < input.milestones.length) {
      issues.push({ code: 'insufficient_runway', deadlineId: earliest.id, detail: `The available runway cannot contain every milestone.` });
    }
  }

  return { ok: issues.length === 0, issues };
}

export function proposeFeasibleSchedule(input: {
  asOf: string;
  deadline: string;
  offsets: Array<{ id: string; label: string; daysBefore: number }>;
}): {
  milestones: Array<{ id: string; label: string; date: string; daysBefore: number }>;
  feasible: boolean;
  reason: string | null;
} {
  const asOf = timestamp(input.asOf);
  const deadline = timestamp(input.deadline);
  if (asOf == null || deadline == null) {
    return { milestones: [], feasible: false, reason: 'The as-of time or deadline is invalid.' };
  }
  if (deadline < asOf) {
    return { milestones: [], feasible: false, reason: 'The deadline has passed.' };
  }

  const zone = 'UTC';
  const asOfYmd = ymdInZone(new Date(asOf), zone);
  const deadlineYmd = ymdInZone(new Date(deadline), zone);
  const runway = Math.max(0, Math.floor((Date.parse(`${deadlineYmd}T00:00:00Z`) - Date.parse(`${asOfYmd}T00:00:00Z`)) / 86_400_000));
  const total = input.offsets.reduce((sum, offset) => sum + Math.max(0, offset.daysBefore), 0);
  const scale = total > runway && total > 0 ? runway / total : 1;
  const milestones = input.offsets.map((offset) => {
    const compressed = Math.floor(Math.max(0, offset.daysBefore) * scale);
    return { id: offset.id, label: offset.label, date: addDaysInZone(deadlineYmd, -compressed, zone), daysBefore: compressed };
  });
  return {
    milestones,
    feasible: true,
    reason: scale < 1 ? 'Milestones were compressed proportionally to fit the available runway.' : null,
  };
}

function timestamp(value: string): number | null {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}
