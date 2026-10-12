import { sample } from './hidden.cjs';
function withContextRetry(source: string, fn: () => unknown, runtime: unknown) { return fn(); }
class C {
  constructor(private readonly retryRuntime: unknown) {}
  run() { withContextRetry('x', () => 1, this.retryRuntime); return sample(); }
}
export { C };
