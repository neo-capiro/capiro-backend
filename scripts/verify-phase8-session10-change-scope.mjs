const modulePath = 'apps/defense-api/src/budget-lifecycle/budget-lifecycle.module.ts';
const schemaPath = 'apps/api/prisma/schema.prisma';
function relevantSchema(source) {
  if (source == null) return null;
  const text = source
    .replace(/\r\n?/g, '\n')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .map((line) => line.replace(/(^|\s)\/\/.*$/, '$1'))
    .join('\n');
  const model = text.match(/^model\s+DefenseBudgetScheduleTick\s*\{[\s\S]*?^\}/m)?.[0];
  if (!model) return null;
  const global = [...text.matchAll(/^(?:datasource|generator)\s+\w+\s*\{[\s\S]*?^\}/gm)].map(
    (match) => match[0],
  );
  return [model, ...global].map((block) => block.trim()).join('\n');
}
export function hasScheduleProductChanges(changes) {
  return changes.some(({ file, before, after }) => {
    if (file === schemaPath) {
      const previous = relevantSchema(before),
        current = relevantSchema(after);
      return previous == null || current == null || previous !== current;
    }
    return (
      file === modulePath ||
      file.startsWith('apps/defense-api/src/budget-lifecycle/schedule/') ||
      file === 'apps/defense-api/scripts/run-schedule-controller.mjs' ||
      file === 'packages/defense-domain/src/budget-lifecycle/schedule.ts' ||
      file === 'packages/defense-domain/src/budget-lifecycle/index.ts' ||
      file === 'packages/defense-domain/src/index.ts' ||
      file.startsWith(
        'apps/api/prisma/migrations/20261211120000_phase8_session10_schedule_control_plane/',
      )
    );
  });
}
export function frozenScheduleProblems(changes) {
  if (!hasScheduleProductChanges(changes)) return [];
  return changes
    .filter(
      ({ file }) =>
        file.startsWith('apps/defense-api/src/budget-lifecycle/') &&
        file !== modulePath &&
        !file.startsWith('apps/defense-api/src/budget-lifecycle/schedule/'),
    )
    .map(({ file }) => file);
}
