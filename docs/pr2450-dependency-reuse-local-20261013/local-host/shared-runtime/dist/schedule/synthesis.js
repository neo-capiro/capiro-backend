"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.collectScheduleDeadlines = collectScheduleDeadlines;
exports.renderScheduleConstraints = renderScheduleConstraints;
exports.extractScheduleDates = extractScheduleDates;
exports.appendScheduleCorrections = appendScheduleCorrections;
const validate_1 = require("./validate");
const STANDARD_OFFSETS = [
    { id: 'capture-plan', label: 'Capture plan complete', daysBefore: 21 },
    { id: 'compliance-review', label: 'Compliance review', daysBefore: 14 },
    { id: 'draft-complete', label: 'Draft complete', daysBefore: 10 },
    { id: 'final-review', label: 'Final review', daysBefore: 5 },
];
const MONTHS = {
    january: '01',
    february: '02',
    march: '03',
    april: '04',
    may: '05',
    june: '06',
    july: '07',
    august: '08',
    september: '09',
    october: '10',
    november: '11',
    december: '12',
    jan: '01',
    feb: '02',
    mar: '03',
    apr: '04',
    jun: '06',
    jul: '07',
    aug: '08',
    sep: '09',
    sept: '09',
    oct: '10',
    nov: '11',
    dec: '12',
};
const MONTH_PATTERN = 'January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec';
const SECTION_RE = /(?:^|\n)(#{1,6}\s+[^\n]*(?:capture plan|timeline|roadmap|schedule)[^\n]*\n)([\s\S]*?)(?=\n#{1,6}\s|$)/gi;
function collectScheduleDeadlines(value) {
    const found = [];
    const seen = new Set();
    const visit = (current, inheritedTitle) => {
        if (!current || typeof current !== 'object' || seen.has(current))
            return;
        seen.add(current);
        if (Array.isArray(current)) {
            current.forEach((item) => visit(item, inheritedTitle));
            return;
        }
        const row = current;
        const title = typeof row.title === 'string' && row.title.trim() ? row.title.trim() : inheritedTitle;
        const deadline = row.deadline;
        if (deadline && typeof deadline === 'object') {
            const d = deadline;
            const status = d.status;
            if (title && (status === 'open' || status === 'closed' || status === 'unknown')) {
                const at = typeof d.at === 'string' ? d.at : null;
                const dateOnly = typeof d.dateOnly === 'string' ? d.dateOnly : null;
                found.push({
                    id: `${title}:${at ?? dateOnly ?? String(d.rawText ?? 'unknown')}`,
                    title,
                    at,
                    dateOnly,
                    timeZone: typeof d.timeZone === 'string' ? d.timeZone : null,
                    daysRemaining: typeof d.daysRemaining === 'number' ? d.daysRemaining : null,
                    status,
                    ...(typeof d.rawText === 'string' ? { rawText: d.rawText } : {}),
                });
            }
        }
        for (const child of Object.values(row))
            visit(child, title);
    };
    visit(value);
    return [...new Map(found.map((fact) => [fact.id, fact])).values()].sort((a, b) => a.id.localeCompare(b.id));
}
function renderScheduleConstraints(asOf, deadlines) {
    if (!deadlines.length)
        return '';
    const today = asOf.slice(0, 10);
    const rows = deadlines.map((deadline) => {
        const when = deadline.at ?? deadline.dateOnly ?? deadline.rawText ?? 'unknown';
        const zone = deadline.timeZone ?? 'zone not stated';
        const days = deadline.daysRemaining == null
            ? 'unknown days remaining'
            : `${deadline.daysRemaining} days remaining`;
        const proposal = deadline.status === 'open' && deadline.at
            ? (0, validate_1.proposeFeasibleSchedule)({ asOf, deadline: deadline.at, offsets: STANDARD_OFFSETS })
            : null;
        const suggested = proposal?.milestones.length
            ? `; suggested dates: ${proposal.milestones.map((item) => `${item.label} ${item.date}`).join(', ')}`
            : '';
        return `${deadline.title}: deadline ${when} ${zone}, ${days}, status ${deadline.status}${suggested}`;
    });
    return `Schedule constraints (computed): today=${today} UTC; ${rows.join('; ')}; every proposed milestone must fall on or before its deadline; deadlines already passed cannot be planned against — say so and propose the next actionable step.`;
}
function extractScheduleDates(text) {
    const extracted = [];
    for (const section of text.matchAll(SECTION_RE)) {
        const body = section[2] ?? '';
        for (const [index, line] of body.split(/\r?\n/).entries()) {
            const iso = line.match(/\b(\d{4}-\d{2}-\d{2})\b/);
            const named = line.match(new RegExp(`\\b(${MONTH_PATTERN})\\.?\\s+(\\d{1,2}),\\s+(\\d{4})\\b`, 'i'));
            const rawDate = iso?.[1] ?? named?.[0];
            if (!rawDate)
                continue;
            const date = iso?.[1] ??
                `${named[3]}-${MONTHS[named[1].toLowerCase()]}-${named[2].padStart(2, '0')}`;
            const label = line
                .replace(rawDate, '')
                .replace(/^\s*[-*#\d.)]+\s*/, '')
                .replace(/[—–:\s-]+$/, '')
                .trim() || `Milestone ${index + 1}`;
            extracted.push({
                id: `milestone-${extracted.length + 1}`,
                label: `${label} — ${rawDate}`,
                date,
                rawDate,
            });
        }
    }
    return extracted;
}
function appendScheduleCorrections(input) {
    const milestones = extractScheduleDates(input.text);
    const usable = input.deadlines.filter((deadline) => deadline.at != null);
    if (!milestones.length || !usable.length)
        return { text: input.text, issues: [] };
    const validation = (0, validate_1.validateSchedule)({
        asOf: input.asOf,
        deadlines: usable.map((deadline) => ({
            id: deadline.id,
            label: deadline.title,
            date: deadline.at,
        })),
        milestones,
    });
    const relevant = validation.issues.filter((issue) => issue.code === 'milestone_after_deadline' || issue.code === 'deadline_passed');
    if (!relevant.length)
        return { text: input.text, issues: [] };
    const notes = relevant.map((issue) => {
        const deadline = usable.find((item) => item.id === issue.deadlineId) ?? usable[0];
        if (issue.code === 'deadline_passed') {
            return `Correction: the ${deadline.title} deadline of ${deadline.dateOnly ?? deadline.at} (${deadline.timeZone ?? 'zone not stated'}) has passed; do not plan against it. Confirm the next actionable opportunity.`;
        }
        const milestone = milestones.find((item) => item.id === issue.milestoneId);
        return `Correction: '${milestone.label}' falls after the ${deadline.title} deadline of ${deadline.dateOnly ?? deadline.at} (${deadline.timeZone ?? 'zone not stated'}); the feasible submission date is on or before ${deadline.dateOnly ?? deadline.at}.`;
    });
    return { text: `${input.text.trimEnd()}\n\n${notes.join('\n')}`, issues: relevant };
}
//# sourceMappingURL=synthesis.js.map