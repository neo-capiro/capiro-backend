import { beforeEach, describe, expect, test } from 'vitest';
import type { AxiosRequestConfig, AxiosResponse } from 'axios';
import { activateEngagementPreview, clearEngagementPreview } from './engagement-api-preview.js';
import {
  ENGAGEMENT_EXTERNAL_ACTION_DISABLED,
  ENGAGEMENT_PREVIEW_ROUTE_MISS,
  ENGAGEMENT_PREVIEW_STALE_RESPONSE,
  markEngagementPreviewRequest,
  normalizeEngagementPreviewError,
} from './engagement-preview-errors.js';

function errorFor(
  status: number,
  data: unknown,
  service = 'engagement-api',
): Error & { response: AxiosResponse; code?: string } {
  const config = { headers: {} } as AxiosRequestConfig;
  markEngagementPreviewRequest(config);
  const response = {
    data,
    status,
    statusText: String(status),
    headers: service ? { 'x-capiro-service': service } : {},
    config: config as AxiosResponse['config'],
  } as AxiosResponse;
  return Object.assign(new Error(`original-${status}`), { response });
}

describe('Engagement preview resilience matrix', () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    activateEngagementPreview();
  });

  test.each([400, 401, 403, 404, 409, 429, 500])(
    'ordinary HTTP %s remains the original error class/message',
    (status) => {
      const error = errorFor(status, { code: `ORDINARY_${status}`, message: `ordinary-${status}` });
      expect(normalizeEngagementPreviewError(error)).toBe(error);
      expect(error.message).toBe(`original-${status}`);
      expect(error.code).toBeUndefined();
      expect((error.response.data as { code: string }).code).toBe(`ORDINARY_${status}`);
    },
  );

  test('malformed/non-object server payload is not reinterpreted as a shadow denial', () => {
    const error = errorFor(500, '<not-json>');
    expect(normalizeEngagementPreviewError(error)).toBe(error);
    expect(error.message).toBe('original-500');
  });

  test('connection reset / transport error with no response remains unchanged', () => {
    const error = Object.assign(new Error('socket reset'), { code: 'ECONNRESET' });
    expect(normalizeEngagementPreviewError(error)).toBe(error);
    expect(error.message).toBe('socket reset');
    expect(error.code).toBe('ECONNRESET');
  });

  test('route miss is distinct from shadow denial', () => {
    const error = errorFor(503, { code: ENGAGEMENT_EXTERNAL_ACTION_DISABLED }, 'api');
    expect(() => normalizeEngagementPreviewError(error)).toThrowError(
      expect.objectContaining({ code: ENGAGEMENT_PREVIEW_ROUTE_MISS }),
    );
  });

  test('exact shadow denial is the only 503 translated into preview refusal copy', () => {
    const error = errorFor(503, { code: ENGAGEMENT_EXTERNAL_ACTION_DISABLED, message: 'server' });
    expect(normalizeEngagementPreviewError(error)).toBe(error);
    expect(error.code).toBe(ENGAGEMENT_EXTERNAL_ACTION_DISABLED);
    expect(error.message).toMatch(/No external action was taken/);
  });

  test('preview response completing after mode-off is rejected as stale, not rendered as an error state', () => {
    const error = errorFor(500, { code: 'ORDINARY_500' });
    clearEngagementPreview();
    expect(() => normalizeEngagementPreviewError(error)).toThrowError(
      expect.objectContaining({ code: ENGAGEMENT_PREVIEW_STALE_RESPONSE }),
    );
  });
});
