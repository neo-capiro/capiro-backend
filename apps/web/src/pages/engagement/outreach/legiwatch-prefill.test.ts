import { beforeEach, describe, expect, it } from 'vitest';
import { clearLegiWatchHandoff, LW_OUTREACH_CONTEXT_KEY, prefillToWizardState, readLegiWatchHandoff } from './legiwatch-prefill.js';

const PREFILL = {
  clientId: 'client-1', clientName: 'Anduril', status: 'staged', autoSend: false,
  context: {
    hearing: { id: 'hearing-1', title: 'Shipbuilding readiness', committeeName: 'Seapower', calendarDate: '2026-09-01' },
    finding: { id: 'ins-1', title: 'Procurement gap', summary: 'Funding shortfall noted.' },
  },
};
function stage(prefill: unknown = PREFILL, createdAt = Date.now()) {
  sessionStorage.setItem(LW_OUTREACH_CONTEXT_KEY, JSON.stringify({ id: 'handoff-1', prefill, createdAt }));
}
beforeEach(() => sessionStorage.clear());
describe('LegiWatch handoff identities and wizard data', () => {
  it('retains a validated handoff for reload, and maps into real V2 generation fields', () => {
    stage();
    const result = readLegiWatchHandoff('client-1', 'hearing-1', 'handoff-1');
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('Unexpected rejection');
    expect(sessionStorage.getItem(LW_OUTREACH_CONTEXT_KEY)).not.toBeNull();
    const state = prefillToWizardState(result.handoff.prefill);
    expect(state.clientId).toBe('client-1');
    expect(state.campaignName).toBe('Procurement gap');
    const item = state.contextItems[0];
    if (!item) throw new Error('Expected hearing context in the wizard');
    expect(item.note).toContain('Shipbuilding readiness');
    expect(item.note).toContain('\n\nFinding: Procurement gap');
    expect(item.note).toContain('/legiwatch/hearings/hearing-1');
    expect(item).toMatchObject({ kind: 'note', scope: 'all', noteUse: 'fact' });
    clearLegiWatchHandoff(result.handoff.id);
    expect(sessionStorage.getItem(LW_OUTREACH_CONTEXT_KEY)).toBeNull();
  });
  it.each([
    ['client-2', 'hearing-1', 'client-mismatch'],
    ['client-1', 'hearing-2', 'hearing-mismatch'],
    [null, 'hearing-1', 'malformed'],
    ['client-1', null, 'malformed'],
  ])('rejects route identity %s / %s', (client, hearing, reason) => {
    stage();
    expect(readLegiWatchHandoff(client, hearing, 'handoff-1')).toMatchObject({ ok: false, reason });
  });
  it.each([-7_200_000, 7_200_000])('rejects expired/future timestamps', (offset) => {
    stage(PREFILL, Date.now() + offset);
    expect(readLegiWatchHandoff('client-1', 'hearing-1', 'handoff-1')).toMatchObject({ ok: false, reason: 'stale' });
  });
  it.each([{}, null, { ...PREFILL, autoSend: true }, { ...PREFILL, context: { ...PREFILL.context, finding: { id: 'x', title: {} } } }])('rejects malformed fields without rendering them', (prefill) => {
    stage(prefill);
    expect(readLegiWatchHandoff('client-1', 'hearing-1', 'handoff-1').ok).toBe(false);
  });
  it('bounds hearing notes to the generation contract and retains their source', () => {
    stage({ ...PREFILL, context: { ...PREFILL.context, finding: { ...PREFILL.context.finding, summary: 'evidence '.repeat(2000) } } });
    const result = readLegiWatchHandoff('client-1', 'hearing-1', 'handoff-1');
    if (!result.ok) throw new Error('Unexpected rejection');
    const item = prefillToWizardState(result.handoff.prefill).contextItems[0];
    if (!item) throw new Error('Expected the bounded hearing context note');
    expect(item.note.length).toBeLessThanOrEqual(8000);
    expect(item.note).toContain('Excerpt; open the hearing');
    expect(item.note).toContain('/legiwatch/hearings/hearing-1');
  });
  it('rejects an earlier launch after a different moment in the same hearing is staged', () => {
    stage();
    expect(readLegiWatchHandoff('client-1', 'hearing-1', 'earlier-handoff')).toMatchObject({ ok: false, reason: 'handoff-mismatch' });
  });
  it('does not clear a newer hearing when an earlier one is saved', () => {
    stage(PREFILL, 123);
    clearLegiWatchHandoff('older-handoff');
    expect(sessionStorage.getItem(LW_OUTREACH_CONTEXT_KEY)).not.toBeNull();
  });
});
