import { captureDeferredUntil } from './capture-start-policy.js';

describe('official capture start boundary', () => {
  const now = new Date('2026-10-06T14:00:00Z');
  const hearing = {
    publicAccess: 'PUBLIC',
    eventStatus: 'scheduled',
    scheduledStart: new Date('2026-10-07T14:00:00Z'),
  };
  it('waits until five minutes before a future scheduled proceeding', () => {
    expect(captureDeferredUntil(hearing, now)).toEqual(new Date('2026-10-07T13:55:00Z'));
    expect(captureDeferredUntil(hearing, new Date('2026-10-07T13:55:00Z'))).toBeNull();
  });
  it.each([undefined, new Date(NaN)])(
    'keeps unknown scheduled times waiting (%s)',
    (scheduledStart) => {
      expect(captureDeferredUntil({ ...hearing, scheduledStart }, now)).toEqual(
        new Date('2026-10-06T14:05:00Z'),
      );
    },
  );
  it.each(['in_progress', 'canceled', 'cancelled', 'postponed', 'completed'])(
    'preserves live/terminal policy precedence (%s)',
    (eventStatus) => {
      expect(
        captureDeferredUntil({ ...hearing, eventStatus, scheduledStart: undefined }, now),
      ).toBeNull();
    },
  );
  it('leaves nonpublic proceedings to access policy', () => {
    expect(captureDeferredUntil({ ...hearing, publicAccess: 'CLOSED' }, now)).toBeNull();
  });
});
