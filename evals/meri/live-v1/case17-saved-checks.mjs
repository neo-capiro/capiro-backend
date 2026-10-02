import { inspectPendingUiPage } from './case17-memory-ui.mjs';
import { sha256Stable } from './lib/stable.mjs';
import { inspectCase17WriteAccounting } from './case17-readonly-guard.mjs';

const need = (ok, code) => {
  if (!ok) throw new Error(`CASE17_SAVED_${code}`);
};
const HASH = /^[a-f0-9]{64}$/u;

/** Pure joins only. Caller JSON cannot confer live/browser/storage authority. */
export function inspectCase17SavedEvidence({
  selection,
  before,
  after,
  rounds,
  synthesisSubmissionCount,
  applicationWrites,
  blockedWrites,
  blockedPreferenceWrites,
  blockedWriteRequests,
}) {
  need(synthesisSubmissionCount === 0 && applicationWrites === 0, 'READ_ONLY');
  inspectCase17WriteAccounting({ blockedWrites, blockedPreferenceWrites, blockedWriteRequests });
  need(sha256Stable(before) === sha256Stable(after), 'CURRENT_OWNER_CHANGED');
  need(
    Array.isArray(rounds) &&
      rounds.length === 2 &&
      rounds[0].phase === 'initial' &&
      rounds[1].phase === 'afterReload',
    'RELOAD_REQUIRED',
  );
  const refs = new Set();
  for (const round of rounds) {
    const joined = inspectPendingUiPage({ selection, owner: before, pages: round.pages });
    need(
      Number.isInteger(round.uiLoadMoreCount) &&
        round.uiLoadMoreCount >= 0 &&
        round.uiLoadMoreCount <= 9,
      'UI_PAGE_BOUND',
    );
    need(
      round.apiPageCount === round.pages.length &&
        sha256Stable(round.pageHashes) === sha256Stable(round.pages.map(sha256Stable)),
      'PAGE_BYTES',
    );
    need(
      round.pages.every((page) => sha256Stable(page.fixtureEvidence) === sha256Stable(before)),
      'PAGE_OWNER',
    );
    need(
      Array.isArray(round.cards) &&
        round.cards.length === 6 &&
        new Set(round.cards.map((card) => card.physicalId)).size === 6,
      'SIX_CARDS',
    );
    for (const row of joined) {
      const card = round.cards.find((item) => item.physicalId === row.physicalId);
      need(
        card?.logicalSourceId === row.logicalSourceId &&
          card.scope === row.scope &&
          card.visible === true &&
          card.actionable === true &&
          HASH.test(card.textSha256 ?? ''),
        'CARD_BINDING',
      );
      const descriptor = card.screenshot;
      need(
        descriptor?.ref === `case17/${round.phase}/${row.logicalSourceId}.png` &&
          !refs.has(descriptor.ref) &&
          HASH.test(descriptor.sha256 ?? '') &&
          Number.isSafeInteger(descriptor.bytes) &&
          descriptor.bytes > 0,
        'SCREENSHOT_BINDING',
      );
      refs.add(descriptor.ref);
    }
  }
  return {
    status: 'SAVED_CHECKS_ONLY',
    caseId: '17',
    independentProposalCount: 6,
    reloadVerified: true,
  };
}
