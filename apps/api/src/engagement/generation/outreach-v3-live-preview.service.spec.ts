import { OutreachV3LivePreviewService } from './outreach-v3-live-preview.service.js';

describe('OutreachV3LivePreviewService', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('returns null for a key that was never written', () => {
    const svc = new OutreachV3LivePreviewService();
    expect(svc.get('k1')).toBeNull();
  });

  it('returns the most recently written text', () => {
    const svc = new OutreachV3LivePreviewService();
    svc.update('k1', 'Hello');
    expect(svc.get('k1')).toBe('Hello');
  });

  it('throttles writes within the window — a rapid second write is dropped', () => {
    const svc = new OutreachV3LivePreviewService();
    svc.update('k1', 'Hello');
    svc.update('k1', 'Hello wor');
    expect(svc.get('k1')).toBe('Hello');
  });

  it('accepts a write once the throttle window has elapsed', () => {
    const svc = new OutreachV3LivePreviewService();
    svc.update('k1', 'Hello');
    jest.advanceTimersByTime(500);
    svc.update('k1', 'Hello world');
    expect(svc.get('k1')).toBe('Hello world');
  });

  it('expires an entry older than the TTL', () => {
    const svc = new OutreachV3LivePreviewService();
    svc.update('k1', 'Hello');
    jest.advanceTimersByTime(31 * 60_000);
    expect(svc.get('k1')).toBeNull();
  });

  it('keeps separate keys independent', () => {
    const svc = new OutreachV3LivePreviewService();
    svc.update('k1', 'from one');
    svc.update('k2', 'from two');
    expect(svc.get('k1')).toBe('from one');
    expect(svc.get('k2')).toBe('from two');
  });
});
