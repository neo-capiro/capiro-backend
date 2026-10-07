import type { PlannerFormQuestion } from './planner.js';

/** Forms store parents before their children; validation bounds depth to five.
 * A hidden parent's stale answer never opens a descendant branch. */
export function plannerVisibleFormQuestions<T extends PlannerFormQuestion>(
  fields: readonly T[],
  answers: Record<string, unknown>,
): T[] {
  const visible = new Set<string>();
  return fields.filter((field) => {
    if (field.showWhen) {
      const parent = field.showWhen.questionId;
      if (!visible.has(parent)) return false;
      const answer = answers[parent];
      const selected = Array.isArray(answer) ? answer : [answer];
      if (!field.showWhen.values.some((value) => selected.includes(value))) return false;
    }
    visible.add(field.id);
    return true;
  });
}

/** Strip stale hidden values before sending. The server independently applies
 * the same visibility rules and validates every visible answer. */
export function plannerVisibleFormAnswers(
  fields: readonly PlannerFormQuestion[],
  answers: Record<string, unknown>,
): Record<string, unknown> {
  const visible = new Set(plannerVisibleFormQuestions(fields, answers).map((field) => field.id));
  return Object.fromEntries(Object.entries(answers).filter(([id]) => visible.has(id)));
}
