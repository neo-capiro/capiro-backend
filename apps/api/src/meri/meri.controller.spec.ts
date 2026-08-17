import { BadRequestException } from '@nestjs/common';
import {
  MERI_PROVIDER_CONFIGURATION_ERROR,
  runMeriStreamWithSetupGuard,
} from './meri-stream-preflight.helpers.js';

function makeRes() {
  const res = {
    headersSent: false,
    writableEnded: false,
    setHeader: jest.fn(),
    write: jest.fn(),
    end: jest.fn(),
    json: jest.fn(),
    status: jest.fn(),
  };
  res.status.mockImplementation(() => res);
  res.end.mockImplementation(() => {
    res.writableEnded = true;
    return res;
  });
  return res;
}

describe('Meri stream pre-flight guard', () => {
  test('returns classified JSON when provider setup fails before any SSE frame', async () => {
    const res = makeRes();
    await runMeriStreamWithSetupGuard({
      res,
      stream: async () => {
        throw new Error('ANTHROPIC_API_KEY not configured');
      },
    });

    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: 503,
        code: MERI_PROVIDER_CONFIGURATION_ERROR,
      }),
    );
    expect(res.end).toHaveBeenCalled();
    expect(res.write).not.toHaveBeenCalled();
  });

  test('keeps a validation HttpException as a JSON 400 instead of a generic 500', async () => {
    const res = makeRes();
    await runMeriStreamWithSetupGuard({
      res,
      stream: async () => {
        throw new BadRequestException('Message body is empty');
      },
    });

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: 400,
        message: 'Message body is empty',
      }),
    );
  });

  test('writes an in-stream error when the response already started as SSE', async () => {
    const res = makeRes();
    await runMeriStreamWithSetupGuard({
      res,
      stream: async (sse) => {
        sse.write('data: {"type":"start","intent":"general"}\n\n');
        throw new Error('ANTHROPIC_API_KEY not configured');
      },
    });

    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
    const frames = res.write.mock.calls.map((call) => String(call[0])).join('');
    expect(frames).toContain('"type":"start"');
    expect(frames).toContain(MERI_PROVIDER_CONFIGURATION_ERROR);
    expect(frames).toContain('"type":"done"');
    expect(res.end).toHaveBeenCalled();
  });
});
