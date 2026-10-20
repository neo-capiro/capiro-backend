export const TENANT = '22222222-2222-2222-2222-222222222222';
export const CLIENT = '11111111-1111-1111-1111-111111111111';
export const USER = 'user-owner';
export const WATCHLIST = `wl:${CLIENT}`;

export function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

export interface IoCall {
  name: string;
  args: unknown;
  scope: number | null;
}
export class IoTape {
  readonly calls: IoCall[] = [];
  readonly failures = new Map<string, Error>();
  readonly pauses = new Map<
    string,
    { release: ReturnType<typeof deferred<void>>; started: ReturnType<typeof deferred<void>> }
  >();
  activeScope: number | null = null;
  scopeCount = 0;

  note(name: string, args: unknown = null): void {
    this.calls.push({ name, args, scope: this.activeScope });
  }
  pause(name: string) {
    const gate = { release: deferred<void>(), started: deferred<void>() };
    this.pauses.set(name, gate);
    return gate;
  }
  async run<T>(name: string, args: unknown, response: T): Promise<T> {
    this.note(name, args);
    const failure = this.failures.get(name);
    if (failure) throw failure;
    const gate = this.pauses.get(name);
    if (gate) {
      gate.started.resolve();
      await gate.release.promise;
    }
    return response;
  }
  names(): string[] {
    return this.calls.map((call) => call.name);
  }
}

export function scoped<T>(tape: IoTape, tx: T) {
  return async (tenant: string, callback: (tx: T) => unknown) => {
    const scope = ++tape.scopeCount;
    tape.activeScope = scope;
    tape.note('tenant.begin', tenant);
    try {
      const response = await callback(tx);
      tape.note('tenant.commit');
      return response;
    } catch (error) {
      tape.note('tenant.rollback');
      throw error;
    } finally {
      tape.activeScope = null;
    }
  };
}

export function namesWithoutScopes(tape: IoTape): string[] {
  return tape.names().filter((name) => !name.startsWith('tenant.'));
}

export function replacePrivate(target: object, name: string, value: unknown): void {
  Object.defineProperty(target, name, { configurable: true, writable: true, value });
}
