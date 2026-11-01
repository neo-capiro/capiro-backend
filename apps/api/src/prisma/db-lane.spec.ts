import type { NextFunction, Request, Response } from 'express';
import {
  DB_LANE_DEFAULTS,
  DB_LANE_ENV,
  currentDbLane,
  isAuthorityRequestPath,
  laneDatabaseUrl,
  readDbLaneSettings,
  runInDbLane,
} from './db-lane.js';
import { DbLaneMiddleware } from './db-lane.middleware.js';

describe('isAuthorityRequestPath', () => {
  it.each([
    '/api/clio/application-authority/identity',
    '/api/clio/application-authority/current',
    '/api/clio/application-authority/membership',
    '/api/clio/application-authority/context',
    '/api/clio/application-authority/artifact',
    '/api/clio/conversations/management/metadata',
    '/api/clio/conversations/management/summaries',
    '/api/clio/conversations/management/read',
    '/api/clio/conversations/management/apply',
    '/clio/application-authority/identity',
    '/api/clio/conversations/management',
  ])('routes %s to the authority lane', (path) => {
    expect(isAuthorityRequestPath(path)).toBe(true);
  });

  it.each([
    '/api/clio/conversations',
    '/api/clio/conversations/abc/messages',
    '/api/clio/application-authority-extra',
    '/api/clio/runtime/turn',
    '/api/intelligence/clients/abc/profile-v1',
    '/api/clients/abc/activity',
    '/api/engagement/integrations/microsoft/notifications',
    '/health',
  ])('keeps %s on the request lane', (path) => {
    expect(isAuthorityRequestPath(path)).toBe(false);
  });
});

describe('laneDatabaseUrl', () => {
  const pool = { connectionLimit: 3, poolTimeoutSeconds: 2 };

  it('replaces the pool parameters and keeps every other parameter', () => {
    expect(
      laneDatabaseUrl('postgresql://u:p@db.internal:5432/core?schema=public&sslmode=require&connection_limit=10', pool),
    ).toBe('postgresql://u:p@db.internal:5432/core?schema=public&sslmode=require&connection_limit=3&pool_timeout=2');
  });

  it('adds the parameters to a URL without a query string', () => {
    expect(laneDatabaseUrl('postgresql://u:p@db.internal:5432/core', pool)).toBe(
      'postgresql://u:p@db.internal:5432/core?connection_limit=3&pool_timeout=2',
    );
  });

  it('passes the credential bytes through untouched', () => {
    const encoded = 'postgresql://capiro_app:p%40ss%2Fw%25rd%3F@db.internal:5432/core?schema=public&connection_limit=10';
    expect(laneDatabaseUrl(encoded, pool).startsWith('postgresql://capiro_app:p%40ss%2Fw%25rd%3F@db.internal:5432/core?')).toBe(true);
  });

  it('overrides an existing pool_timeout', () => {
    expect(laneDatabaseUrl('postgresql://u:p@h/db?pool_timeout=30&connection_limit=10', { connectionLimit: 4, poolTimeoutSeconds: 10 })).toBe(
      'postgresql://u:p@h/db?pool_timeout=10&connection_limit=4',
    );
  });
});

describe('readDbLaneSettings', () => {
  it('defaults every value with no environment', () => {
    expect(readDbLaneSettings({})).toEqual(DB_LANE_DEFAULTS);
    expect(DB_LANE_DEFAULTS.authority.statementTimeoutMs).toBe(2_000);
  });

  it('reads bounded pool overrides without a lane switch', () => {
    const settings = readDbLaneSettings({
      [DB_LANE_ENV.authorityConnectionLimit]: '5',
      [DB_LANE_ENV.authorityPoolTimeoutSeconds]: '3',
      [DB_LANE_ENV.authorityStatementTimeoutMs]: '1500',
      [DB_LANE_ENV.backgroundConnectionLimit]: '6',
      [DB_LANE_ENV.backgroundPoolTimeoutSeconds]: '20',
    });
    expect(settings).toEqual({
      authority: { connectionLimit: 5, poolTimeoutSeconds: 3, statementTimeoutMs: 1500 },
      background: { connectionLimit: 6, poolTimeoutSeconds: 20, statementTimeoutMs: null },
    });
  });

  it.each(['off', 'on', 'OFF', '', 'maybe'])('rejects retired CORE_DB_LANES=%s explicitly', (value) => {
    expect(() => readDbLaneSettings({ CORE_DB_LANES: value })).toThrow(
      'CORE_DB_LANES is no longer supported; remove it from configuration. Database lanes are always enabled.',
    );
  });

  it('rejects a malformed value instead of silently defaulting', () => {
    expect(() => readDbLaneSettings({ [DB_LANE_ENV.authorityConnectionLimit]: '0' })).toThrow(RangeError);
    expect(() => readDbLaneSettings({ [DB_LANE_ENV.authorityStatementTimeoutMs]: '5' })).toThrow(RangeError);
    expect(() => readDbLaneSettings({ [DB_LANE_ENV.backgroundConnectionLimit]: 'four' })).toThrow(RangeError);
  });
});

describe('runInDbLane', () => {
  it('is request outside any lane and nests per async context', async () => {
    expect(currentDbLane()).toBe('request');
    const seen = await runInDbLane('authority', async () => {
      const outer = currentDbLane();
      await Promise.resolve();
      const inner = await runInDbLane('background', async () => currentDbLane());
      return [outer, currentDbLane(), inner];
    });
    expect(seen).toEqual(['authority', 'authority', 'background']);
    expect(currentDbLane()).toBe('request');
  });
});

describe('DbLaneMiddleware', () => {
  function request(path: string): Request {
    return { baseUrl: '', path } as unknown as Request;
  }

  it('runs the rest of the chain in the authority lane for authority routes', () => {
    const middleware = new DbLaneMiddleware();
    const next: NextFunction = jest.fn(() => {
      expect(currentDbLane()).toBe('authority');
    });
    middleware.use(request('/api/clio/application-authority/current'), {} as Response, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(currentDbLane()).toBe('request');
  });

  it('leaves every other route on the request lane', () => {
    const middleware = new DbLaneMiddleware();
    const next: NextFunction = jest.fn(() => {
      expect(currentDbLane()).toBe('request');
    });
    middleware.use(request('/api/intelligence/clients/x/profile-v1'), {} as Response, next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('honours a mounted base path', () => {
    const middleware = new DbLaneMiddleware();
    const next: NextFunction = jest.fn(() => {
      expect(currentDbLane()).toBe('authority');
    });
    middleware.use({ baseUrl: '/api/clio/conversations/management', path: '/metadata' } as unknown as Request, {} as Response, next);
    expect(next).toHaveBeenCalledTimes(1);
  });
});
