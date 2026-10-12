/** Sample wall time at the owning operation's boundary, in epoch milliseconds. */
export type WallClock = () => number;

/** Sample the same [0, 1) uniform source used by the system default. */
export type RandomSource = () => number;

export type Delay = (milliseconds: number) => Promise<void>;

/** Defaults are lazy: importing this module samples no time or randomness. */
export function systemWallClock(): number {
  return Date.now();
}

export function systemRandom(): number {
  return Math.random();
}

export function systemDelay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
