import { beforeEach, describe, expect, test } from 'vitest';
import type { AxiosRequestConfig, AxiosResponse } from 'axios';
import {
  activateEngagementPreview,
  clearEngagementPreview,
} from './engagement-api-preview.js';
import {
  ENGAGEMENT_EXTERNAL_ACTION_DISABLED,
  ENGAGEMENT_PREVIEW_EXTERNAL_ACTION_MESSAGE,
  ENGAGEMENT_PREVIEW_ROUTE_MISS,
  ENGAGEMENT_PREVIEW_STALE_RESPONSE,
  assertEngagementPreviewResponseIdentity,
  assertEngagementRequestModeCurrent,
  markEngagementPreviewRequest,
  markEngagementRequest,
  normalizeEngagementPreviewError,
  wasEngagementPreviewRequest,
} from './engagement-preview-errors.js';

function response(
  overrides: Partial<AxiosResponse> = {},
  preview = true,
): AxiosResponse {
  const config = { headers: {} } as AxiosRequestConfig;
  if (preview) markEngagementPreviewRequest(config);
  else markEngagementRequest(config, 'main');
  return {
    data: {},
    status: 200,
    statusText: 'OK',
    headers: { 'x-capiro-service': 'engagement-api' },
    config: config as AxiosResponse['config'],
    ...overrides,
  };
}

function axiosError(res: AxiosResponse): Error & { response: AxiosResponse; code?: string } {
  return Object.assign(new Error('request failed'), { response: res });
}

describe('Engagement preview response identity', () => {
  beforeEach(() => {
    window.sessionStorage.clear();
  });

  test('accepts the exact engagement-api service identity on a marked request', () => {
    expect(() => assertEngagementPreviewResponseIdentity(response())).not.toThrow();
  });

  test.each([undefined, 'main-api', 'ENGAGEMENT-API'])(
    'rejects a marked response whose service identity is %s',
    (service) => {
      const headers = service ? { 'x-capiro-service': service } : {};
      try {
        assertEngagementPreviewResponseIdentity(response({ headers }));
        throw new Error('expected identity assertion to fail');
      } catch (error) {
        expect((error as { code?: string }).code).toBe(ENGAGEMENT_PREVIEW_ROUTE_MISS);
        expect(String((error as Error).message)).not.toContain('tenant');
      }
    },
  );

  test('does not require a service identity in normal/main mode', () => {
    expect(() =>
      assertEngagementPreviewResponseIdentity(response({ headers: {} }, false)),
    ).not.toThrow();
  });

  test('the dispatch-time marker survives independently of later mode changes', () => {
    const config = { headers: {} } as AxiosRequestConfig;
    markEngagementPreviewRequest(config);
    expect(wasEngagementPreviewRequest(config)).toBe(true);
  });
});

describe('Engagement request-mode freshness', () => {
  beforeEach(() => {
    window.sessionStorage.clear();
  });

  test('accepts main response while main remains current', () => {
    expect(() => assertEngagementRequestModeCurrent(response({}, false))).not.toThrow();
  });

  test('accepts preview response while preview remains current', () => {
    activateEngagementPreview();
    expect(() => assertEngagementRequestModeCurrent(response())).not.toThrow();
  });

  test('negative control: preview response after toggle-off is discarded', () => {
    activateEngagementPreview();
    const res = response();
    clearEngagementPreview();
    expect(() => assertEngagementRequestModeCurrent(res)).toThrowError(
      expect.objectContaining({ code: ENGAGEMENT_PREVIEW_STALE_RESPONSE }),
    );
  });

  test('negative control: main response after toggle-on is discarded', () => {
    const res = response({}, false);
    activateEngagementPreview();
    expect(() => assertEngagementRequestModeCurrent(res)).toThrowError(
      expect.objectContaining({ code: ENGAGEMENT_PREVIEW_STALE_RESPONSE }),
    );
  });
});

describe('Engagement preview denial normalization', () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    activateEngagementPreview();
  });

  test('translates only the exact external-action denial code', () => {
    const res = response({
      status: 503,
      statusText: 'Service Unavailable',
      data: {
        statusCode: 503,
        code: ENGAGEMENT_EXTERNAL_ACTION_DISABLED,
        action: 'send',
        message: 'server shadow wording',
      },
    });
    const error = axiosError(res);

    expect(normalizeEngagementPreviewError(error)).toBe(error);
    expect(error.code).toBe(ENGAGEMENT_EXTERNAL_ACTION_DISABLED);
    expect(error.message).toBe(ENGAGEMENT_PREVIEW_EXTERNAL_ACTION_MESSAGE);
    expect(res.data).toEqual({
      statusCode: 503,
      code: ENGAGEMENT_EXTERNAL_ACTION_DISABLED,
      message: ENGAGEMENT_PREVIEW_EXTERNAL_ACTION_MESSAGE,
    });
    expect(JSON.stringify(res.data)).not.toContain('action');
  });

  test('does not translate a generic 503', () => {
    const res = response({ status: 503, data: { message: 'upstream unavailable' } });
    const error = axiosError(res);
    expect(normalizeEngagementPreviewError(error)).toBe(error);
    expect(error.message).toBe('request failed');
    expect(res.data).toEqual({ message: 'upstream unavailable' });
  });

  test('does not translate the sibling callbacks-disabled denial', () => {
    const res = response({
      status: 503,
      data: {
        code: 'ENGAGEMENT_CALLBACKS_DISABLED',
        message: 'callbacks disabled',
      },
    });
    const error = axiosError(res);
    expect(normalizeEngagementPreviewError(error)).toBe(error);
    expect(error.message).toBe('request failed');
    expect((res.data as { code: string }).code).toBe('ENGAGEMENT_CALLBACKS_DISABLED');
  });

  test('enforces service identity on the error path before accepting a denial', () => {
    const res = response({
      status: 503,
      headers: {},
      data: { code: ENGAGEMENT_EXTERNAL_ACTION_DISABLED },
    });
    const error = axiosError(res);
    expect(() => normalizeEngagementPreviewError(error)).toThrowError(
      expect.objectContaining({ code: ENGAGEMENT_PREVIEW_ROUTE_MISS }),
    );
  });

  test('leaves a transport error with no response unchanged', () => {
    const error = new Error('network reset');
    expect(normalizeEngagementPreviewError(error)).toBe(error);
  });
});
