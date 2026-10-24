import { AsyncLocalStorage } from 'node:async_hooks';
import type { Configuration } from '@azure/msal-node';

export const MAILBOX_CALL_TIMEOUT_MS = 30_000;
export const MAILBOX_RUN_TIMEOUT_MS = 120_000;
type Budget = { signal: AbortSignal; deadline: number };
const budgets = new AsyncLocalStorage<Budget>();

export class MailboxDeadlineError extends Error {
  constructor() {
    super('Mailbox provider request timeout; retry later.');
    this.name = 'TimeoutError';
  }
}

export function assertMailboxBudget(): void {
  const budget = budgets.getStore();
  if (budget && (budget.signal.aborted || Date.now() >= budget.deadline))
    throw new MailboxDeadlineError();
}

/** Leave room for one request and the existing bounded persistence transaction. */
export function mailboxYieldRequested(): boolean {
  const budget = budgets.getStore();
  return !!budget && budget.deadline - Date.now() <= MAILBOX_CALL_TIMEOUT_MS + 20_000;
}

/** Races even a broken transport which ignores AbortSignal; late work is fenced at persistence. */
export async function mailboxProviderRequest<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs = MAILBOX_CALL_TIMEOUT_MS,
): Promise<T> {
  assertMailboxBudget();
  const parent = budgets.getStore();
  const controller = new AbortController();
  const remaining = Math.min(timeoutMs, parent ? parent.deadline - Date.now() : timeoutMs);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancel: () => void = () => {};
  const timeout = new Promise<never>((_resolve, reject) => {
    cancel = () => {
      controller.abort();
      reject(new MailboxDeadlineError());
    };
    timer = setTimeout(cancel, Math.max(0, remaining));
    parent?.signal.addEventListener('abort', cancel, { once: true });
  });
  try {
    return await Promise.race([
      Promise.resolve().then(() => operation(controller.signal)),
      timeout,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    parent?.signal.removeEventListener('abort', cancel);
    controller.abort();
  }
}

export async function withMailboxProviderBudget<T>(operation: () => Promise<T>): Promise<T> {
  if (budgets.getStore()) {
    assertMailboxBudget();
    return operation();
  }
  return mailboxProviderRequest(
    (signal) => budgets.run({ signal, deadline: Date.now() + MAILBOX_RUN_TIMEOUT_MS }, operation),
    MAILBOX_RUN_TIMEOUT_MS,
  );
}

export async function mailboxRetryDelay(ms: number): Promise<void> {
  await mailboxProviderRequest(
    (signal) =>
      new Promise<void>((resolve, reject) => {
        const abort = () => {
          clearTimeout(timer);
          reject(new MailboxDeadlineError());
        };
        const timer = setTimeout(() => {
          signal.removeEventListener('abort', abort);
          resolve();
        }, ms);
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      }),
  );
}

// MSAL keeps its protocol, validation, cache and refresh behavior. Only its documented
// networkClient hook supplies the same bounded fetch/body transport as resource reads.
type MsalNetwork = NonNullable<NonNullable<Configuration['system']>['networkClient']>;
export const mailboxMsalNetwork: MsalNetwork = {
  sendGetRequestAsync: (url, options) => msalRequest('GET', url, options),
  sendPostRequestAsync: (url, options) => msalRequest('POST', url, options),
};
async function msalRequest<T>(
  method: 'GET' | 'POST',
  url: string,
  options?: { headers?: Record<string, string>; body?: string },
) {
  return mailboxProviderRequest(async (signal) => {
    const response = await fetch(url, {
      method,
      headers: options?.headers,
      body: options?.body,
      signal,
    });
    const body = (await response.json()) as T;
    return {
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      body,
    };
  });
}
