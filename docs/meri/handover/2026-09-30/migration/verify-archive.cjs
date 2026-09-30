'use strict';
// Safe portable archive check: file reads, hashes and syntax parsing only.
// Never imports/evaluates the archived sources and never calls a process/network API.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const root = __dirname;
const hash = (b) => crypto.createHash('sha256').update(b).digest('hex');
const read = (name) => JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'));
function check(condition, code) { if (!condition) throw new Error(code); }
const manifest = read('source-byte-manifest.json');
check(manifest.archiveOnly === true && manifest.allOriginalBytesUnmodified === true, 'ARCHIVE_SCOPE');
check(manifest.referenceSources.length === 10, 'REFERENCE_SOURCE_COUNT');
for (const entry of manifest.referenceSources) {
  check(/^reference-source\/[a-z0-9-]+\.cjs\.txt$/.test(entry.archivePath), 'REFERENCE_PATH');
  const bytes = fs.readFileSync(path.join(root, entry.archivePath));
  check(bytes.length === entry.bytes && hash(bytes) === entry.sha256, 'REFERENCE_BYTES');
  new vm.Script(bytes.toString('utf8'), { filename: entry.originalName });
}
const result = read('result-summary.json');
check(result.archiveOnly === true && result.portableProof === false && result.liveAuthorized === false, 'RESULT_AUTHORITY');
check(result.currentVerdict === 'BLOCKED' && result.originalAttempt.actualProcessExit === 1, 'ORIGINAL_FAILURE_PRESERVED');
check(result.originalAttempt.recordedCommandReceipts === 60, 'COMMAND_RECEIPT_COUNT');
const exits = result.originalAttempt.recordedCommandExitCounts;
check(exits.exit0 === 58 && exits.expectedDiagnosticExit1 === 2 && exits.appliedResolutions === 56 && exits.rollbackMarkers === 2 && exits.normalStep61CountedSeparately === true, 'ACTUAL_COMMAND_EXIT_DISTINCTION');
check(result.originalAttempt.normalMigrationDeploy.actualExit === 0, 'NORMAL_DEPLOY_EXIT');
check(result.originalAttempt.terminalChecks.run === 0 && result.originalAttempt.terminalChecks.total === 8, 'TERMINAL_NOT_RUN');
check(result.supplement.executionVerdict === 'NOT RUN', 'SUPPLEMENT_NOT_RUN');
const decisions = read('historical-clone-decisions.json');
check(decisions.archiveOnly === true && decisions.executionAllowed === false && decisions.decisions.length === 60, 'HISTORICAL_DECISIONS');
check(new Set(decisions.decisions.map((d) => d.decisionId)).size === 60, 'DECISION_UNIQUENESS');
check(decisions.decisions.filter((d) => d.historicalCloneAction === 'INDIVIDUAL_PRISMA_RESOLVE_APPLIED').length === 56, 'HISTORICAL_RESOLUTIONS');
check(decisions.decisions.filter((d) => d.historicalCloneAction === 'LEAVE_PENDING_FOR_NORMAL_API_MIGRATE_DEPLOY').length === 4, 'HISTORICAL_NORMAL_MIGRATIONS');
check(Array.isArray(read('excluded-private-evidence.json').excluded), 'EXCLUSIONS');
console.log(JSON.stringify({ verdict: 'PASS', meaning: 'ARCHIVE_INTEGRITY_ONLY', exactSources: 10, syntaxParsedWithoutExecution: 10, historicalDecisionRecords: 60, archivedSourceExecution: false, cloudCalls: 0, databaseCalls: 0, migrationProofReproduced: false }));
