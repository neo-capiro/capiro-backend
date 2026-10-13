"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.systemWallClock = systemWallClock;
exports.systemRandom = systemRandom;
exports.systemDelay = systemDelay;
/** Defaults are lazy: importing this module samples no time or randomness. */
function systemWallClock() {
    return Date.now();
}
function systemRandom() {
    return Math.random();
}
function systemDelay(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
//# sourceMappingURL=time.js.map