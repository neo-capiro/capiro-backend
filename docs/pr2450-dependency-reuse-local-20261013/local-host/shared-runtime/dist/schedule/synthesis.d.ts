import { type ScheduleIssue } from './validate';
export interface ScheduleDeadlineFact {
    id: string;
    title: string;
    at: string | null;
    dateOnly: string | null;
    timeZone: string | null;
    daysRemaining: number | null;
    status: 'open' | 'closed' | 'unknown';
    rawText?: string;
}
export interface ExtractedScheduleDate {
    id: string;
    label: string;
    date: string;
    rawDate: string;
}
export declare function collectScheduleDeadlines(value: unknown): ScheduleDeadlineFact[];
export declare function renderScheduleConstraints(asOf: string, deadlines: readonly ScheduleDeadlineFact[]): string;
export declare function extractScheduleDates(text: string): ExtractedScheduleDate[];
export declare function appendScheduleCorrections(input: {
    text: string;
    asOf: string;
    deadlines: readonly ScheduleDeadlineFact[];
}): {
    text: string;
    issues: ScheduleIssue[];
};
//# sourceMappingURL=synthesis.d.ts.map