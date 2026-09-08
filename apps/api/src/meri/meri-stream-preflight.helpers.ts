import { HttpException } from '@nestjs/common';

export const MERI_PROVIDER_CONFIGURATION_ERROR = 'MERI_PROVIDER_CONFIGURATION_ERROR';
export const MERI_CONVERSATION_STORE_ERROR = 'MERI_CONVERSATION_STORE_ERROR';
export const MERI_STREAM_SETUP_ERROR = 'MERI_STREAM_SETUP_ERROR';

export interface MeriStreamSetupError {
  status: number;
  code: string;
  message: string;
}

const PROVIDER_RE =
  /anthropic_api_key|openai_api_key|ai_credential|not configured|credential|provider configuration/i;
const STORE_RE =
  /column .* does not exist|unknown column|summary_up_to_message_id|invalid.*prisma|the table .* does not exist/i;

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : 'Meri could not start this turn.';
}

function codeOf(err: unknown): string | null {
  if (!err || typeof err !== 'object') return null;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' && code.trim() ? code : null;
}

export function classifyMeriStreamSetupError(err: unknown): MeriStreamSetupError {
  if (err instanceof HttpException) {
    const status = err.getStatus();
    const response = err.getResponse();
    if (typeof response === 'string') {
      return { status, code: MERI_STREAM_SETUP_ERROR, message: response };
    }
    if (response && typeof response === 'object') {
      const body = response as Record<string, unknown>;
      const message = Array.isArray(body.message)
        ? body.message.filter((item): item is string => typeof item === 'string').join('; ')
        : typeof body.message === 'string'
          ? body.message
          : err.message;
      return {
        status,
        code: typeof body.code === 'string' ? body.code : MERI_STREAM_SETUP_ERROR,
        message,
      };
    }
  }

  const message = messageOf(err);
  const code = codeOf(err);
  if (code === MERI_PROVIDER_CONFIGURATION_ERROR || PROVIDER_RE.test(message)) {
    return {
      status: 503,
      code: MERI_PROVIDER_CONFIGURATION_ERROR,
      message: 'Meri is missing a usable AI provider configuration for this tenant.',
    };
  }
  if ((code && /^P\d{4}$/.test(code)) || STORE_RE.test(message)) {
    return {
      status: 500,
      code: MERI_CONVERSATION_STORE_ERROR,
      message: 'Meri could not load this conversation. The conversation store may be out of date.',
    };
  }
  return { status: 500, code: MERI_STREAM_SETUP_ERROR, message };
}

export function meriProviderConfigurationError(cause?: unknown): Error {
  const err = new Error('Meri is missing a usable AI provider configuration for this tenant.');
  (err as Error & { code: string }).code = MERI_PROVIDER_CONFIGURATION_ERROR;
  if (cause instanceof Error) err.cause = cause;
  return err;
}

export interface DeferredSseResponse {
  write(data: string): void;
  status(code: number): { json(body: unknown): void; end(): void };
  json?(body: unknown): void;
  setHeader(name: string, value: string): void;
  end(): void;
}

export function createDeferredMeriSseWriter(res: DeferredSseResponse): {
  started: () => boolean;
  accepted: () => boolean;
  write: (data: string) => void;
} {
  let started = false;
  let accepted = false;
  return {
    started: () => started,
    accepted: () => accepted,
    write(data: string) {
      for (const line of data.split('\n')) {
        if (!line.startsWith('data: ')) continue;
        try {
          const type = JSON.parse(line.slice(6))?.type;
          if (type === 'start' || type === 'turn_accepted') accepted = true;
        } catch {
          /* SSE comments and incomplete frames cannot accept a turn. */
        }
      }
      if (!started) {
        started = true;
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');
      }
      res.write(data);
    },
  };
}

export function writeMeriStreamErrorFrame(
  write: (data: string) => void,
  classified: MeriStreamSetupError,
  accepted?: boolean,
): void {
  write(
    `data: ${JSON.stringify({
      type: 'error',
      code: classified.code,
      message: classified.message,
      ...(accepted === false ? { accepted: false } : {}),
    })}\n\n`,
  );
  write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
}

export async function runMeriStreamWithSetupGuard(args: {
  res: DeferredSseResponse & { headersSent?: boolean; writableEnded?: boolean };
  stream: (sse: { write: (data: string) => void }) => Promise<void>;
  onError?: (classified: MeriStreamSetupError, err: unknown) => void;
}): Promise<void> {
  const sse = createDeferredMeriSseWriter(args.res);
  try {
    await args.stream(sse);
  } catch (err) {
    const classified = classifyMeriStreamSetupError(err);
    args.onError?.(classified, err);
    if (sse.started()) {
      writeMeriStreamErrorFrame(sse.write, classified, sse.accepted());
    } else if (!args.res.headersSent) {
      args.res.status(classified.status).json({
        statusCode: classified.status,
        code: classified.code,
        message: classified.message,
      });
    }
  }
  if (!args.res.writableEnded) args.res.end();
}
