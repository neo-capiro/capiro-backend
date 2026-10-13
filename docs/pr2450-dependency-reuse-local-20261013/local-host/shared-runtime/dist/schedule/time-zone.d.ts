/** The YYYY-MM-DD calendar date of an instant in an IANA timezone. */
export declare function ymdInZone(date: Date, timeZone: string): string;
/** Adds calendar days without treating a DST transition as a 24-hour interval. */
export declare function addDaysInZone(ymd: string, days: number, timeZone: string): string;
/** UTC instants bounding the named calendar day containing `now`. */
export declare function dayBoundsInZone(now: Date, timeZone: string): {
    start: Date;
    end: Date;
};
/** Converts the end of a named calendar date in a zone to an instant. */
export declare function endOfDayInZone(ymd: string, timeZone: string): Date;
//# sourceMappingURL=time-zone.d.ts.map