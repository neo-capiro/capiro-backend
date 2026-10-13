export declare const FEDERAL_DEADLINE_TIME_ZONE = "America/New_York";
export interface NormalizedDeadline {
    at: string | null;
    dateOnly: string | null;
    timeZone: string | null;
    basis: 'explicit_datetime' | 'date_only_end_of_day' | 'unknown';
}
export declare function normalizeDeadline(input: {
    value: string | Date | null;
    kind: 'date' | 'datetime';
    timeZone?: string;
    source: string;
}): NormalizedDeadline;
export declare function daysUntil(asOfIso: string, deadline: NormalizedDeadline): number | null;
export declare function deadlineStatus(asOfIso: string, deadline: NormalizedDeadline): 'open' | 'closed' | 'unknown';
//# sourceMappingURL=deadline.d.ts.map