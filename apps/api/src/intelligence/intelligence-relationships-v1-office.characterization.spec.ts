import {
  clientId,
  deferred,
  harness,
  installHooks,
  tenantId,
} from '../../test/fixtures/intelligence-supporting.js';

installHooks();

it('office recommendations look up optional dependency before tracked resolution and return empty when absent', async () => {
  const h = harness();
  const tracked = h.overrideTracked(new Error('Must not read tracked bills'));
  await expect(h.service.computeOfficeRecommendations(clientId, tenantId)).resolves.toEqual([]);
  expect(h.events).toEqual(['office.lookup']);
  expect(tracked).not.toHaveBeenCalled();
});

it('office recommendations filter only identifier type/length while retaining raw projection and array references', async () => {
  const h = harness({ office: true });
  const subjects = ['Defense'];
  const codes = ['DEF'];
  h.overrideTracked({
    total: 99,
    issueCodes: codes,
    bills: [
      { identifier: ' id ', subjectNames: subjects },
      { identifier: '', subjectNames: null },
      { identifier: 7 },
      { identifier: ' id ', subjectNames: ['Defense'] },
    ],
  });
  const response = [{ marker: 'same-result' }];
  const collaborator = h.makeOffice(response);
  h.setOffice(collaborator);
  expect(await h.service.computeOfficeRecommendations(clientId, tenantId)).toBe(response);
  expect(collaborator.recommend).toHaveBeenCalledTimes(1);
  const input = collaborator.recommend.mock.calls[0]![0];
  expect(input).toEqual({
    clientId,
    tenantId,
    trackedBillIds: [' id ', ' id '],
    trackedBills: [
      { identifier: ' id ', subjectNames: subjects },
      { identifier: '', subjectNames: [] },
      { identifier: 7, subjectNames: [] },
      { identifier: ' id ', subjectNames: ['Defense'] },
    ],
    issueCodes: codes,
  });
  expect(input.trackedBills[0]!.subjectNames).toBe(subjects);
  expect(input.issueCodes).toBe(codes);
  expect(collaborator.recommend.mock.contexts[0]).toBe(collaborator);
  expect(h.events).toEqual([
    'office.lookup',
    'trackedBills',
    'office.lookup',
    'office.recommend',
    'recommend',
  ]);
});

it('office recommendations pass empty issue codes and empty lists through to the present recommender', async () => {
  const h = harness({ office: true });
  h.overrideTracked({ total: 0, bills: [] });
  await h.service.computeOfficeRecommendations(clientId, tenantId);
  expect(h.office.recommend).toHaveBeenCalledWith({
    clientId,
    tenantId,
    trackedBillIds: [],
    trackedBills: [],
    issueCodes: [],
  });
});

it('office recommendations use dependency added after construction at request time', async () => {
  const h = harness();
  h.overrideTracked({ total: 0, bills: [] });
  const office = h.makeOffice([{ marker: 'added' }]);
  h.setOffice(office);
  await expect(h.service.computeOfficeRecommendations(clientId, tenantId)).resolves.toEqual([
    { marker: 'added' },
  ]);
  expect(office.recommend).toHaveBeenCalledTimes(1);
});

it('office recommendations use replacement dependency after the tracked await and preserve call receiver', async () => {
  const h = harness({ office: true });
  const gate = deferred<unknown>();
  h.overrideTracked(gate.promise);
  const response = [{ marker: 'replacement' }];
  const replacement = h.makeOffice(response, 'replacement');
  const pending = h.service.computeOfficeRecommendations(clientId, tenantId);
  expect(h.events).toEqual(['office.lookup', 'trackedBills']);
  h.setOffice(replacement);
  gate.resolve({ total: 0, bills: [] });
  expect(await pending).toBe(response);
  expect(h.office.recommend).not.toHaveBeenCalled();
  expect(replacement.recommend).toHaveBeenCalledTimes(1);
  expect(replacement.recommend.mock.contexts[0]).toBe(replacement);
  expect(h.events).toEqual([
    'office.lookup',
    'trackedBills',
    'office.lookup',
    'replacement.recommend',
    'recommend',
  ]);
});

it('office recommendations retain the original TypeError when the optional dependency is removed across the tracked await', async () => {
  const h = harness({ office: true });
  const gate = deferred<unknown>();
  h.overrideTracked(gate.promise);
  const pending = h.service.computeOfficeRecommendations(clientId, tenantId);
  h.setOffice(undefined);
  const assertion = expect(pending).rejects.toBeInstanceOf(TypeError);
  gate.resolve({ total: 0, bills: [] });
  await assertion;
  expect(h.office.recommend).not.toHaveBeenCalled();
  expect(h.events).toEqual(['office.lookup', 'trackedBills', 'office.lookup']);
});

it('office recommendations propagate tracked-source failure before a second dependency lookup', async () => {
  const h = harness({ office: true });
  const failure = new Error('Tracked failed');
  h.overrideTracked(failure);
  await expect(h.service.computeOfficeRecommendations(clientId, tenantId)).rejects.toBe(failure);
  expect(h.events).toEqual(['office.lookup', 'trackedBills']);
  expect(h.office.recommend).not.toHaveBeenCalled();
});

it('office recommendations propagate the collaborator error after both dependency reads', async () => {
  const h = harness({ office: true });
  const failure = new Error('Recommend failed');
  h.overrideTracked({ total: 0, bills: [] });
  const collaborator = h.makeOffice(failure);
  h.setOffice(collaborator);
  await expect(h.service.computeOfficeRecommendations(clientId, tenantId)).rejects.toBe(failure);
  expect(collaborator.recommend).toHaveBeenCalledTimes(1);
  expect(h.events.filter((event) => event === 'office.lookup')).toHaveLength(2);
});
