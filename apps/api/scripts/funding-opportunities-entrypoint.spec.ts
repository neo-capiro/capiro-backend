import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const dispatcher = readFileSync(join(__dirname, 'entrypoint-dispatcher.inc'), 'utf8');

describe('Funding Opportunities container commands', () => {
  test.each([
    ['generate-funding-grant-candidates', 'generate-funding-grant-candidates.ts'],
    ['generate-sam-opportunity-candidates', 'generate-sam-opportunity-candidates.ts'],
    ['process-funding-opportunity-lifecycle', 'process-funding-opportunity-lifecycle.ts'],
    ['backfill-sam-opportunity-fields', 'backfill-sam-opportunity-fields.ts'],
    ['backfill-funding-mapping-review', 'backfill-funding-mapping-review.ts'],
    ['match-contractor-identifiers', 'match-contractor-identifiers.ts'],
    ['sync-sam-opportunities-all-federal', 'sync-sam-opportunities.ts'],
    // P47. Forwarding ALL arguments matters more than usual here: --commit,
    // --endpoint-id and --confirm-callback are the safety interlocks, and a
    // dispatcher that dropped them would silently downgrade a commit to a dry
    // run — or, far worse, drop --confirm-callback from a real commit.
    ['reconcile-tango-webhook-alerts', 'reconcile-tango-webhook-alerts.ts'],
  ])('%s dispatches to %s and forwards all arguments', (verb, script) => {
    if (verb === 'sync-sam-opportunities-all-federal') {
      expect(dispatcher).toContain(
        `${verb}) shift; exec ./node_modules/.bin/tsx scripts/${script} --all-federal --commit "$@" ;;`,
      );
      return;
    }
    expect(dispatcher).toContain(
      `${verb}) shift; exec ./node_modules/.bin/tsx scripts/${script} "$@" ;;`,
    );
  });
});
