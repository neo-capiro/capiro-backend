"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.FEDERAL_DEADLINE_TIME_ZONE = void 0;
exports.normalizeDeadline = normalizeDeadline;
exports.daysUntil = daysUntil;
exports.deadlineStatus = deadlineStatus;
const time_zone_1 = require("./time-zone");
const DAY_MS = 86_400_000;
exports.FEDERAL_DEADLINE_TIME_ZONE = 'America/New_York';
function normalizeDeadline(input) {
    if (input.value == null)
        return unknownDeadline();
    if (input.kind === 'date') {
        const dateOnly = input.value instanceof Date
            ? (0, time_zone_1.ymdInZone)(input.value, 'UTC')
            : /^\d{4}-\d{2}-\d{2}/.test(input.value)
                ? input.value.slice(0, 10)
                : null;
        if (dateOnly == null)
            return unknownDeadline();
        const timeZone = input.timeZone ?? exports.FEDERAL_DEADLINE_TIME_ZONE;
        try {
            return {
                at: (0, time_zone_1.endOfDayInZone)(dateOnly, timeZone).toISOString(),
                dateOnly,
                timeZone,
                basis: 'date_only_end_of_day',
            };
        }
        catch {
            return unknownDeadline();
        }
    }
    const parsed = input.value instanceof Date ? input.value : new Date(input.value);
    if (Number.isNaN(parsed.getTime()))
        return unknownDeadline();
    const timeZone = input.timeZone ?? null;
    return {
        at: parsed.toISOString(),
        dateOnly: timeZone ? (0, time_zone_1.ymdInZone)(parsed, timeZone) : parsed.toISOString().slice(0, 10),
        timeZone,
        basis: 'explicit_datetime',
    };
}
function daysUntil(asOfIso, deadline) {
    if (deadline.at == null)
        return null;
    const asOf = new Date(asOfIso);
    const at = new Date(deadline.at);
    if (Number.isNaN(asOf.getTime()) || Number.isNaN(at.getTime()))
        return null;
    return Math.ceil((at.getTime() - asOf.getTime()) / DAY_MS);
}
function deadlineStatus(asOfIso, deadline) {
    if (deadline.at == null)
        return 'unknown';
    const asOf = new Date(asOfIso).getTime();
    const at = new Date(deadline.at).getTime();
    if (Number.isNaN(asOf) || Number.isNaN(at))
        return 'unknown';
    return asOf <= at ? 'open' : 'closed';
}
function unknownDeadline() {
    return { at: null, dateOnly: null, timeZone: null, basis: 'unknown' };
}
//# sourceMappingURL=deadline.js.map