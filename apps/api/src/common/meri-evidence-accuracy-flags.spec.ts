import {
  logEvidenceAccuracyConfigIssues,
  resolveEvidenceAccuracyModeForTenant,
} from './meri-evidence-accuracy-flags.js';

const TENANT = '17b63099-bc0f-4ac5-b596-496161e9481e';

const configuredEnv = {
  MERI_EVIDENCE_ACCURACY_MODE: 'enforce',
  MERI_EVIDENCE_ACCURACY_TENANTS: TENANT,
  MERI_EVIDENCE_ACCURACY_SURFACES: 'chat,strategy',
};

describe('Meri evidence accuracy flags', () => {
  test('uses injected env and defaults the surface to chat', () => {
    expect(resolveEvidenceAccuracyModeForTenant(TENANT, undefined, configuredEnv)).toBe('enforce');
    expect(resolveEvidenceAccuracyModeForTenant(TENANT, 'strategy', configuredEnv)).toBe('enforce');
  });

  test('fails closed for missing enrollment without mutating process.env', () => {
    const originalMode = process.env.MERI_EVIDENCE_ACCURACY_MODE;
    expect(resolveEvidenceAccuracyModeForTenant(TENANT, 'chat', {})).toBe('off');
    expect(process.env.MERI_EVIDENCE_ACCURACY_MODE).toBe(originalMode);
  });

  test('logs structured configuration issues once when invalid', () => {
    const logger = { warn: jest.fn() };
    logEvidenceAccuracyConfigIssues(logger, {
      MERI_EVIDENCE_ACCURACY_MODE: 'enabled',
      MERI_EVIDENCE_ACCURACY_TENANTS: 'capiro-internal',
      MERI_EVIDENCE_ACCURACY_SURFACES: 'chat,bogus',
    });
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith('meri.evidence_accuracy.invalid_config', {
      issues: ['invalid_mode', 'invalid_tenant:capiro-internal', 'invalid_surface:bogus'],
    });
  });

  test('does not log valid dark defaults', () => {
    const logger = { warn: jest.fn() };
    logEvidenceAccuracyConfigIssues(logger, {
      MERI_EVIDENCE_ACCURACY_MODE: 'off',
      MERI_EVIDENCE_ACCURACY_TENANTS: '',
      MERI_EVIDENCE_ACCURACY_SURFACES: '',
    });
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
