import { describe, expect, jest, test } from '@jest/globals';
import { IntelligenceController } from '../intelligence/intelligence.controller.js';
import { manifestKey } from './boundary-artifact.util.js';

/**
 * WS-D D2 — the manifest/artifact endpoints. These pin the two behaviours a
 * client depends on and that are easy to regress: the ETag/304 contract (a
 * client holding the ~5 MB national artifact must be able to revalidate for
 * free) and the fact that the response stays gzipped end to end.
 */

type ResponseStub = {
  headers: Record<string, string>;
  statusCode: number | null;
  body: Buffer | null;
  ended: boolean;
  setHeader: (k: string, v: string) => void;
  status: (c: number) => ResponseStub;
  end: () => void;
  send: (b: Buffer) => void;
};

function makeRes(): ResponseStub {
  const res: ResponseStub = {
    headers: {},
    statusCode: null,
    body: null,
    ended: false,
    setHeader(k, v) {
      this.headers[k] = v;
    },
    status(c) {
      this.statusCode = c;
      return this;
    },
    end() {
      this.ended = true;
    },
    send(b) {
      this.body = b;
    },
  };
  return res;
}

const GZIPPED = Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0x00]);

function makeController(directory: unknown) {
  return new IntelligenceController(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    directory as never,
    { get: () => 'off' } as never,
  );
}

describe('GET district-nexus/boundaries (manifest)', () => {
  test('defaults to the current rail and forwards F when asked', async () => {
    const getBoundaryManifest = jest.fn(async () => ({ status: 'current' }) as never);
    const controller = makeController({ getBoundaryManifest });

    await controller.getBoundaryManifest(undefined);
    expect(getBoundaryManifest).toHaveBeenLastCalledWith('C');

    await controller.getBoundaryManifest('F');
    expect(getBoundaryManifest).toHaveBeenLastCalledWith('F');

    // Anything unrecognized must not be passed through as a status.
    await controller.getBoundaryManifest('banana');
    expect(getBoundaryManifest).toHaveBeenLastCalledWith('C');
  });
});

describe('GET district-nexus/boundaries/:status/geojson', () => {
  const artifact = { gzipped: GZIPPED, hash: 'deadbeef', districtCount: 441 };

  test('serves the artifact gzipped with a strong ETag', async () => {
    const controller = makeController({ getBoundaryArtifact: jest.fn(async () => artifact) });
    const res = makeRes();

    await controller.getBoundaryGeoJson('C', undefined, res as never);

    expect(res.headers['Content-Type']).toBe('application/geo+json');
    // Must stay gzipped — decompressing a 5 MB artifact just to recompress it
    // on the wire is the regression this guards.
    expect(res.headers['Content-Encoding']).toBe('gzip');
    expect(res.headers['ETag']).toBe('"deadbeef"');
    expect(res.headers['X-District-Count']).toBe('441');
    expect(res.body).toBe(GZIPPED);
  });

  test('a matching If-None-Match yields 304 with no body', async () => {
    const controller = makeController({ getBoundaryArtifact: jest.fn(async () => artifact) });
    const res = makeRes();

    await controller.getBoundaryGeoJson('C', '"deadbeef"', res as never);

    expect(res.statusCode).toBe(304);
    expect(res.ended).toBe(true);
    expect(res.body).toBeNull();
  });

  test('a stale If-None-Match still gets the full artifact', async () => {
    const controller = makeController({ getBoundaryArtifact: jest.fn(async () => artifact) });
    const res = makeRes();

    await controller.getBoundaryGeoJson('C', '"anoldhash"', res as never);

    expect(res.statusCode).toBeNull();
    expect(res.body).toBe(GZIPPED);
  });

  test('the artifact URL revalidates rather than caching hard', () => {
    // Only the content-addressed S3 object may be immutable; this URL follows
    // the manifest, so a hard cache would pin clients to a stale map.
    const controller = makeController({ getBoundaryArtifact: jest.fn(async () => artifact) });
    const res = makeRes();
    return controller.getBoundaryGeoJson('C', undefined, res as never).then(() => {
      expect(res.headers['Cache-Control']).toBe('public, max-age=0, must-revalidate');
      expect(res.headers['Cache-Control']).not.toMatch(/immutable/);
    });
  });

  test('status is narrowed to C/F before it reaches storage', async () => {
    const getBoundaryArtifact = jest.fn(async () => artifact);
    const controller = makeController({ getBoundaryArtifact });

    await controller.getBoundaryGeoJson('F', undefined, makeRes() as never);
    expect(getBoundaryArtifact).toHaveBeenLastCalledWith('F');

    // A path param is attacker-controlled; it must never become an S3 key part.
    await controller.getBoundaryGeoJson('../../etc/passwd', undefined, makeRes() as never);
    expect(getBoundaryArtifact).toHaveBeenLastCalledWith('C');
  });
});

describe('manifest key layout', () => {
  test('is a fixed, predictable pointer per rail', () => {
    expect(manifestKey('C')).toBe('district-boundaries/congress/current/manifest.json');
    expect(manifestKey('F')).toBe('district-boundaries/congress/future/manifest.json');
  });
});
