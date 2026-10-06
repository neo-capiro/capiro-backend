import {
  globalPublicAudioSource,
  globalPublicAudioRetentionDays,
} from './global-public-audio-policy.js';

describe('operator-controlled public audio retention', () => {
  const keys = [
    'HEARING_PUBLIC_AUDIO_STORAGE_ENABLED',
    'HEARING_PUBLIC_AUDIO_CAPTURE_ALL_ENABLED',
    'HEARING_PUBLIC_AUDIO_RETENTION_DAYS',
  ];
  const prior = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  beforeEach(() => keys.forEach((key) => delete process.env[key]));
  afterAll(() =>
    keys.forEach((key) => {
      if (prior[key] === undefined) delete process.env[key];
      else process.env[key] = prior[key];
    }),
  );
  it('stays off unless audio storage and the separate global opt-in are both enabled', async () => {
    const tx = { $queryRaw: jest.fn() };
    process.env.HEARING_PUBLIC_AUDIO_STORAGE_ENABLED = 'true';
    expect(await globalPublicAudioSource(tx as never, 'h')).toBeNull();
    expect(tx.$queryRaw).not.toHaveBeenCalled();
  });
  it('rejects incomplete caller identity before querying public playback permission', async () => {
    process.env.HEARING_PUBLIC_AUDIO_STORAGE_ENABLED = 'true';
    process.env.HEARING_PUBLIC_AUDIO_CAPTURE_ALL_ENABLED = 'true';
    const tx = { $queryRaw: jest.fn() };
    expect(await globalPublicAudioSource(tx as never, 'h', { tenantId: 't' })).toBeNull();
    expect(tx.$queryRaw).not.toHaveBeenCalled();
  });
  it('uses bounded retention and rejects invalid configuration', () => {
    expect(globalPublicAudioRetentionDays()).toBe(30);
    for (const value of ['0', '91', 'NaN', '1.5']) {
      process.env.HEARING_PUBLIC_AUDIO_RETENTION_DAYS = value;
      expect(() => globalPublicAudioRetentionDays()).toThrow();
    }
  });
});
