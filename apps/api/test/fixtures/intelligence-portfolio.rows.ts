export const tenantId = '00000000-0000-0000-0000-000000000001';
export const clientId = '00000000-0000-0000-0000-000000000010';
export const userId = 'actor-one';
export const now = new Date('2026-10-13T02:00:00.000Z');
export function client(overrides: Record<string, unknown> = {}) {
  return {
    id: clientId,
    name: 'Acme Research',
    profileStatus: 'ACTIVE',
    primaryContactEmail: null,
    people: [],
    ...overrides,
  };
}
export function hearing(overrides: Record<string, unknown> = {}) {
  return {
    id: 'hear-one',
    committeeName: 'Science',
    title: 'Research hearing',
    type: 'hearing',
    date: new Date('2026-10-12T00:00:00.000Z'),
    time: '10:00',
    location: null,
    witnesses: ['One', 'Two', 'Three', 'Four'],
    url: null,
    ...overrides,
  };
}
export function deadline(overrides: Record<string, unknown> = {}) {
  return {
    id: 'doc-one',
    title: 'Research rule',
    agencyNames: ['Science', 'Commerce', 'Defense'],
    commentEndDate: new Date('2026-10-12T00:00:00.000Z'),
    htmlUrl: null,
    ...overrides,
  };
}
export function change(overrides: Record<string, unknown> = {}) {
  return {
    id: 'change-one',
    source: 'lda',
    title: 'Research change',
    description: 'Material change',
    relatedClientIds: [],
    severity: 'notable',
    detectedAt: new Date('2026-10-12T12:00:00.000Z'),
    ...overrides,
  };
}
export function meeting(overrides: Record<string, unknown> = {}) {
  return {
    id: 'meet-one',
    clientId,
    subject: 'Research meeting',
    startsAt: new Date('2026-10-14T14:00:00.000Z'),
    location: 'Office',
    organizerName: 'Example',
    organizerEmail: 'example@example.test',
    ...overrides,
  };
}
export function alert(overrides: Record<string, unknown> = {}) {
  return {
    id: 'alert-one',
    type: 'hearing_upcoming',
    title: 'Hearing scheduled',
    subtitle: 'Research impact',
    severity: 'notable',
    when: '2026-10-15T00:00:00.000Z',
    countdownDays: 2,
    href: '/intelligence/changes',
    ...overrides,
  };
}
export function profile(alerts: Array<Record<string, unknown>> = []) {
  return { sections: { snapshot: { topAlerts: alerts } } };
}
export function emptyAlerts(generatedAt = now.toISOString()) {
  return { alerts: [], total: 0, clientCount: 0, generatedAt };
}
export function grouped(clientIdValue: string, count: number) {
  return { clientId: clientIdValue, _count: { id: count } };
}
