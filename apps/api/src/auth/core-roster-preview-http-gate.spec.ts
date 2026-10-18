import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from '@jest/globals';
import type { Request, Response, NextFunction } from 'express';
import { coreRosterPreviewHttpGate } from './core-roster-preview-http-gate.js';

const rosterHost = 'core-roster-preview.capiro.ai';

describe('Core roster process gate', () => {
  it('is registered immediately after Nest construction and before shared HTTP setup', () => {
    const source = readFileSync(join(__dirname, '..', 'main.ts'), 'utf8');
    const create = source.indexOf('await NestFactory.create(AppModule');
    const gate = source.indexOf('app.use(coreRosterPreviewHttpGate(');
    const setup = source.indexOf('configureApiHttpApp(app,');
    expect(create).toBeGreaterThanOrEqual(0);
    expect(gate).toBeGreaterThan(create);
    expect(setup).toBeGreaterThan(gate);
  });

  it('denies a second Host header even if Node would retain the reserved one', () => {
    const request = {
      method: 'GET', path: '/api/clients', originalUrl: '/api/clients',
      headers: { host: rosterHost },
      rawHeaders: ['Host', rosterHost, 'Host', 'portfolio-preview.app.capiro.ai'],
    } as unknown as Request;
    const headers = new Map<string, string>();
    let status = 0;
    const response = {
      setHeader(name: string, value: string) { headers.set(name.toLowerCase(), value); },
      status(code: number) { status = code; return this; },
      json() { return this; },
    } as unknown as Response;
    let proceeded = false;
    coreRosterPreviewHttpGate(true, true)(request, response,
      (() => { proceeded = true; }) as NextFunction);
    expect(status).toBe(404);
    expect(headers.get('cache-control')).toBe('no-store');
    expect(proceeded).toBe(false);
  });

  it.each([
    ['POST', '/api/clio/conversations/bootstrap'],
    ['POST', '/api/clio/application-authority/membership'],
  ])('leaves existing first-chat %s %s routing untouched', (method, target) => {
    const request = {
      method, path: target, originalUrl: target,
      headers: { host: 'first-chat-preview.app-dev.capiro.ai' },
      rawHeaders: ['Host', 'first-chat-preview.app-dev.capiro.ai'],
    } as unknown as Request;
    let proceeded = false;
    coreRosterPreviewHttpGate(true, true)(request, {} as Response,
      (() => { proceeded = true; }) as NextFunction);
    expect(proceeded).toBe(true);
  });
});
