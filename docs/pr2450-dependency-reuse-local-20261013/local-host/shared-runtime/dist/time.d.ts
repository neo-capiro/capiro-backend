/** Sample wall time at the owning operation's boundary, in epoch milliseconds. */
export type WallClock = () => number;
/** Sample the same [0, 1) uniform source used by the system default. */
export type RandomSource = () => number;
export type Delay = (milliseconds: number) => Promise<void>;
/** Defaults are lazy: importing this module samples no time or randomness. */
export declare function systemWallClock(): number;
export declare function systemRandom(): number;
export declare function systemDelay(milliseconds: number): Promise<void>;
//# sourceMappingURL=time.d.ts.map