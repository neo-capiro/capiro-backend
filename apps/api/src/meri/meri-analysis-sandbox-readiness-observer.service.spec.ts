import { afterEach, describe, expect, it, jest } from '@jest/globals';
import type { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../config/config.schema.js';
import {
  MeriAnalysisSandboxReadinessObserver,
  parseMeriAnalysisSandboxReadinessReceipt,
} from './meri-analysis-sandbox-readiness-observer.service.js';

const NOW = Date.parse('2026-09-25T12:00:00.000Z');
const readyReceipt = {
  protocolVersion: 1,
  ready: true,
  observedAt: new Date(NOW).toISOString(),
  observation: 'fresh',
};

function config(values: Record<string, unknown>): ConfigService<AppConfig, true> {
  return { get: (key: string) => values[key] } as unknown as ConfigService<AppConfig, true>;
}

function enabledConfig(overrides: Record<string, unknown> = {}) {
  return config({
    MERI_ANALYSIS_SANDBOX_READINESS_OBSERVER_SHADOW: true,
    CLIO_ANALYSIS_SANDBOX_ENABLED: true,
    CLIO_SANDBOX_URL: 'https://private-sandbox.example.test/base/',
    CLIO_SANDBOX_TOKEN: 'private-test-token',
    ...overrides,
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('Meri analysis sandbox readiness receipt v1', () => {
  it('accepts only a canonical recent fixed-shape positive receipt', () => {
    expect(parseMeriAnalysisSandboxReadinessReceipt(readyReceipt, NOW)).toMatchObject({
      ...readyReceipt,
      provenance: 'bearer_authenticated_sandbox_readiness_v1',
    });
    for (const invalid of [
      null,
      { ...readyReceipt, protocolVersion: 2 },
      { ...readyReceipt, ready: false },
      { ...readyReceipt, observation: 'refused' },
      { ...readyReceipt, observation: 'unknown' },
      { ...readyReceipt, observedAt: '2026-09-25' },
      { ...readyReceipt, observedAt: 'not-a-date' },
      { ...readyReceipt, arbitraryCode: 'print(1)' },
    ]) {
      expect(parseMeriAnalysisSandboxReadinessReceipt(invalid, NOW)).toBeNull();
    }
    expect(parseMeriAnalysisSandboxReadinessReceipt(readyReceipt, NOW + 30_001)).toBeNull();
    expect(parseMeriAnalysisSandboxReadinessReceipt(readyReceipt, NOW - 5_001)).toBeNull();
  });

  it('stays off with zero timers or HTTP calls without literal opt-in and all sandbox prerequisites', async () => {
    jest.useFakeTimers({ now: NOW });
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unexpected readiness fetch'));
    for (const values of [
      { MERI_ANALYSIS_SANDBOX_READINESS_OBSERVER_SHADOW: false },
      { CLIO_ANALYSIS_SANDBOX_ENABLED: false },
      { CLIO_SANDBOX_URL: '' },
      { CLIO_SANDBOX_TOKEN: '' },
    ]) {
      const observer = new MeriAnalysisSandboxReadinessObserver(enabledConfig(values));
      observer.noteRunAnalysisOffered();
      expect(observer.currentObservation()).toBeNull();
      observer.onModuleDestroy();
    }
    expect(jest.getTimerCount()).toBe(0);
    await jest.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('delays the bounded bearer-only probe beyond proof exchange, then expires the short-lived observation', async () => {
    jest.useFakeTimers({ now: NOW });
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(readyReceipt));
    const observer = new MeriAnalysisSandboxReadinessObserver(enabledConfig());
    observer.noteRunAnalysisOffered();
    expect(fetchMock).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1_099);
    expect(fetchMock).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://private-sandbox.example.test/base/readiness',
      expect.objectContaining({
        method: 'POST',
        redirect: 'error',
        headers: { authorization: 'Bearer private-test-token', accept: 'application/json' },
      }),
    );
    expect(observer.currentObservation()).toMatchObject({ ready: true, protocolVersion: 1 });
    // The receipt was observed at t=0 and expires at t=30,001. One eligible
    // offer burst causes only one probe, so expiration does not cause a repeat.
    await jest.advanceTimersByTimeAsync(28_901);
    expect(observer.currentObservation()).toBeNull();
    await jest.advanceTimersByTimeAsync(1_099);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    observer.onModuleDestroy();
    expect(observer.currentObservation()).toBeNull();
  });

  it('rejects refusal, authentication failure, redirect, malformed JSON, and oversized receipts', async () => {
    jest.useFakeTimers({ now: NOW });
    const badResponses = [
      jsonResponse({ ...readyReceipt, ready: false, observation: 'refused' }, 503),
      jsonResponse({ error: 'unauthorized' }, 401),
      new Response(null, { status: 302, headers: { location: 'https://attacker.example.test/' } }),
      new Response('{', { status: 200, headers: { 'content-type': 'application/json' } }),
      jsonResponse({ ...readyReceipt, excess: 'x'.repeat(513) }),
    ];
    for (const response of badResponses) {
      const fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValueOnce(response);
      const observer = new MeriAnalysisSandboxReadinessObserver(enabledConfig());
      observer.noteRunAnalysisOffered();
      await jest.advanceTimersByTimeAsync(1_100);
      expect(observer.currentObservation()).toBeNull();
      observer.onModuleDestroy();
      fetchMock.mockRestore();
    }
  });

  it('invalidates a previous positive result on a later refused probe', async () => {
    jest.useFakeTimers({ now: NOW });
    const fetchMock = jest.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse({ ...readyReceipt, observedAt: new Date(NOW + 1_100).toISOString() }))
      .mockResolvedValueOnce(jsonResponse({ ...readyReceipt, ready: false, observation: 'refused' }, 503));
    const observer = new MeriAnalysisSandboxReadinessObserver(enabledConfig());
    observer.noteRunAnalysisOffered();
    observer.noteRunAnalysisOffered();
    await jest.advanceTimersByTimeAsync(1_100);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(observer.currentObservation()).not.toBeNull();
    observer.noteRunAnalysisOffered();
    await jest.advanceTimersByTimeAsync(30_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(observer.currentObservation()).toBeNull();
    observer.onModuleDestroy();
  });

  it('keeps a deferred probe single-flight, throttles a later offer, and stops after demand expires', async () => {
    jest.useFakeTimers({ now: NOW });
    let releaseFirst!: (response: Response) => void;
    const pendingFirst = new Promise<Response>((resolve) => { releaseFirst = resolve; });
    const fetchMock = jest.spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('unexpected extra readiness probe'))
      .mockImplementationOnce(async () => pendingFirst)
      .mockImplementationOnce(async () => jsonResponse({
        ...readyReceipt,
        observedAt: new Date(Date.now()).toISOString(),
      }));
    const observer = new MeriAnalysisSandboxReadinessObserver(enabledConfig());

    observer.noteRunAnalysisOffered();
    await jest.advanceTimersByTimeAsync(1_100);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(observer.currentObservation()).toBeNull();

    // A second eligible offer arrives while the first HTTP request is pending.
    // Holding it for 25 seconds also checks that demand cannot start overlap.
    observer.noteRunAnalysisOffered();
    await jest.advanceTimersByTimeAsync(25_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    releaseFirst(jsonResponse({ ...readyReceipt, observedAt: new Date(Date.now()).toISOString() }));
    await jest.advanceTimersByTimeAsync(0);
    expect(observer.currentObservation()).not.toBeNull();

    // The first start was t=1,100; the queued demand cannot refresh before
    // t=31,100 even though the first request was released at t=26,100.
    await jest.advanceTimersByTimeAsync(4_999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(observer.currentObservation()).not.toBeNull();

    // No further offers: no third probe, even long after the demand window.
    await jest.advanceTimersByTimeAsync(90_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(observer.currentObservation()).toBeNull();
    observer.onModuleDestroy();
  });

  it('cancels an in-flight request on shutdown and publishes no late observation', async () => {
    jest.useFakeTimers({ now: NOW });
    let aborted = false;
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          aborted = true;
          reject(new Error('cancelled'));
        }, { once: true });
      }));
    const observer = new MeriAnalysisSandboxReadinessObserver(enabledConfig());
    observer.noteRunAnalysisOffered();
    await jest.advanceTimersByTimeAsync(1_100);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    observer.onModuleDestroy();
    await Promise.resolve();
    expect(aborted).toBe(true);
    expect(observer.currentObservation()).toBeNull();
  });

  it('times out a stalled readiness response without retrying a quiet offer burst', async () => {
    jest.useFakeTimers({ now: NOW });
    let aborted = false;
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          aborted = true;
          reject(new Error('readiness timeout'));
        }, { once: true });
      }));
    const observer = new MeriAnalysisSandboxReadinessObserver(enabledConfig());
    observer.noteRunAnalysisOffered();
    await jest.advanceTimersByTimeAsync(1_100);
    await jest.advanceTimersByTimeAsync(27_000);
    expect(aborted).toBe(true);
    expect(observer.currentObservation()).toBeNull();
    await jest.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    observer.onModuleDestroy();
  });
});
