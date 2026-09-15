import 'reflect-metadata';
import { describe, expect, jest, test } from '@jest/globals';
import { HttpStatus, type ArgumentsHost } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaClientExceptionFilter } from './prisma-exception.filter.js';

function makeRes(headersSent = false) {
  const res = {
    headersSent,
    status: jest.fn(),
    setHeader: jest.fn(),
    json: jest.fn(),
    end: jest.fn(),
  };
  res.status.mockReturnValue(res as never);
  // The 503 branch chains .status().setHeader().json() — without a chainable
  // stub the filter would throw inside the test rather than assert.
  res.setHeader.mockReturnValue(res as never);
  return res;
}

function makeHost(res: ReturnType<typeof makeRes>): ArgumentsHost {
  return {
    switchToHttp: () => ({ getResponse: () => res }),
  } as never;
}

function prismaError(code: string, message = `engine says no\nthe human-readable cause`) {
  return new Prisma.PrismaClientKnownRequestError(message, {
    code,
    clientVersion: '0.0.0-test',
  });
}

describe('PrismaClientExceptionFilter', () => {
  const filter = new PrismaClientExceptionFilter();

  test.each(['P2023', 'P2000'])('%s maps to 400 with a generic, non-leaking body', (code) => {
    const res = makeRes();

    filter.catch(prismaError(code), makeHost(res));

    expect(res.status).toHaveBeenCalledWith(HttpStatus.BAD_REQUEST);
    expect(res.json).toHaveBeenCalledWith({
      statusCode: HttpStatus.BAD_REQUEST,
      message: 'Invalid request parameter',
    });
  });

  test('P2025 maps to 404', () => {
    const res = makeRes();

    filter.catch(prismaError('P2025'), makeHost(res));

    expect(res.status).toHaveBeenCalledWith(HttpStatus.NOT_FOUND);
    expect(res.json).toHaveBeenCalledWith({
      statusCode: HttpStatus.NOT_FOUND,
      message: 'Not found',
    });
  });

  test('P2010 with Postgres 22P02 (malformed UUID in a raw CAST) maps to 400', () => {
    const res = makeRes();
    const err = new Prisma.PrismaClientKnownRequestError('Raw query failed', {
      code: 'P2010',
      clientVersion: '0.0.0-test',
      meta: { code: '22P02', message: 'invalid input syntax for type uuid: "not-a-uuid"' },
    });

    filter.catch(err, makeHost(res));

    expect(res.status).toHaveBeenCalledWith(HttpStatus.BAD_REQUEST);
    expect(res.json).toHaveBeenCalledWith({
      statusCode: HttpStatus.BAD_REQUEST,
      message: 'Invalid request parameter',
    });
  });

  test('P2010 with any other Postgres error keeps the 500 (a real server fault must stay visible)', () => {
    const res = makeRes();
    const err = new Prisma.PrismaClientKnownRequestError('Raw query failed', {
      code: 'P2010',
      clientVersion: '0.0.0-test',
      meta: { code: '42P01', message: 'relation "nope" does not exist' },
    });

    filter.catch(err, makeHost(res));

    expect(res.status).toHaveBeenCalledWith(HttpStatus.INTERNAL_SERVER_ERROR);
  });

  // Pool exhaustion: a burst of background Graph syncs starved the Prisma pool
  // and made unrelated user writes fail. As a 500 that read as a bug in
  // whatever the user was saving, with no hint that retrying would work.
  test.each(['P2024', 'P2028'])('%s maps to 503 with Retry-After, not 500', (code) => {
    const res = makeRes();

    filter.catch(prismaError(code), makeHost(res));

    expect(res.status).toHaveBeenCalledWith(HttpStatus.SERVICE_UNAVAILABLE);
    expect(res.setHeader).toHaveBeenCalledWith('Retry-After', '2');
    expect(res.json).toHaveBeenCalledWith({
      statusCode: HttpStatus.SERVICE_UNAVAILABLE,
      message: 'The database is temporarily busy. Please retry.',
    });
  });

  test('a 503 does not leak the engine message to the caller', () => {
    const res = makeRes();

    filter.catch(
      prismaError(
        'P2028',
        'Transaction API error\nUnable to start a transaction in the given time.',
      ),
      makeHost(res),
    );

    const body = res.json.mock.calls[0]?.[0] as { message: string };
    expect(body.message).not.toContain('Transaction API error');
    expect(body.message).not.toContain('Unable to start a transaction');
  });

  test('unmapped codes preserve the prior 500 with a generic body', () => {
    const res = makeRes();

    filter.catch(prismaError('P2002'), makeHost(res));

    expect(res.status).toHaveBeenCalledWith(HttpStatus.INTERNAL_SERVER_ERROR);
    expect(res.json).toHaveBeenCalledWith({
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      message: 'Internal server error',
    });
  });

  test('after headers are sent (mid-stream error) it ends the response without writing status/json', () => {
    // Writing status/JSON after a stream has started would throw
    // ERR_HTTP_HEADERS_SENT inside the filter — the case the guard prevents.
    const res = makeRes(true);

    filter.catch(prismaError('P2025'), makeHost(res));

    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
    expect(res.end).toHaveBeenCalled();
  });
});
