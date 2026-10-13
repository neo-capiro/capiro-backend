export type ScheduleIssueCode = 'deadline_passed' | 'milestone_after_deadline' | 'milestone_before_as_of' | 'order_conflict' | 'insufficient_runway';
export interface ScheduleIssue {
    code: ScheduleIssueCode;
    milestoneId?: string;
    deadlineId?: string;
    detail: string;
}
interface NamedDate {
    id: string;
    label: string;
    date: string;
}
export declare function validateSchedule(input: {
    asOf: string;
    deadlines: NamedDate[];
    milestones: Array<NamedDate & {
        dependsOn?: string[];
    }>;
}): {
    ok: boolean;
    issues: ScheduleIssue[];
};
export declare function proposeFeasibleSchedule(input: {
    asOf: string;
    deadline: string;
    offsets: Array<{
        id: string;
        label: string;
        daysBefore: number;
    }>;
}): {
    milestones: Array<{
        id: string;
        label: string;
        date: string;
        daysBefore: number;
    }>;
    feasible: boolean;
    reason: string | null;
};
export {};
//# sourceMappingURL=validate.d.ts.map