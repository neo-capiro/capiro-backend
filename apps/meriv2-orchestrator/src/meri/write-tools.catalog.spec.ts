import { WRITE_DELEGATED_TOOLS } from './write-tools.catalog';

/**
 * Drift guard: the write catalog must match apps/api's SIDE_EFFECTING_TOOLS
 * exactly (meri-tools.service.ts). Kept as an explicit expected set because
 * apps/api is not importable from the orchestrator package.
 */
const EXPECTED_WRITE_TOOLS = [
  'create_meeting_brief',
  'draft_policy_memo',
  'save_note',
  'send_email',
  'reply_email',
  'save_memory',
  'confirm_memory',
  'correct_memory',
  'forget_memory',
  'create_word',
  'create_excel',
  'create_powerpoint',
  'schedule_task',
  'cancel_scheduled_task',
  'create_client',
  'create_task',
  'update_task',
  'update_client_profile',
].sort();

describe('WRITE_DELEGATED_TOOLS catalog', () => {
  it('matches apps/api SIDE_EFFECTING_TOOLS exactly (18 tools)', () => {
    const names = WRITE_DELEGATED_TOOLS.map((t) => t.name).sort();
    expect(names).toEqual(EXPECTED_WRITE_TOOLS);
    expect(WRITE_DELEGATED_TOOLS).toHaveLength(18);
  });

  it('is ALL write (readOnly:false) — the gate must fire for every one', () => {
    expect(WRITE_DELEGATED_TOOLS.every((t) => t.readOnly === false)).toBe(true);
  });

  it('has unique names and non-empty descriptions', () => {
    const names = WRITE_DELEGATED_TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    expect(WRITE_DELEGATED_TOOLS.every((t) => t.description.trim().length > 0)).toBe(true);
  });
});
