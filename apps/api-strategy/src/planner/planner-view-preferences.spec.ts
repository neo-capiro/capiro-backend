import { validateResource } from './planner-resources.js';
const id = '20000000-0000-4000-8000-000000000045';
const data = {
  scope: 'project',
  projectId: id,
  view: 'list',
  expandedTaskIds: [id],
  collapsedGroupIds: ['section:'],
  hideUnscheduled: false,
};
describe('Private layout preference validation', () => {
  it('accepts bounded layout identities for a matching project or personal scope', () => {
    expect(validateResource('view_preferences', data)).toEqual(data);
    expect(
      validateResource('view_preferences', {
        ...data,
        scope: 'mine',
        projectId: null,
        view: 'board',
      }),
    ).toMatchObject({ projectId: null });
  });
  it.each([
    { scope: 'mine' },
    { projectId: null },
    { view: 'capacity' },
    { expandedTaskIds: ['other'] },
    { expandedTaskIds: [id, id] },
    { collapsedGroupIds: [''] },
    { collapsedGroupIds: ['one', 'one'] },
    { collapsedGroupIds: Array(1001).fill('one') },
    { hideUnscheduled: 'true' },
    { privacy: 'team' },
  ])('rejects malformed identities, widened scope or unrelated properties: %j', (patch) => {
    expect(() => validateResource('view_preferences', { ...data, ...patch })).toThrow();
  });
});
