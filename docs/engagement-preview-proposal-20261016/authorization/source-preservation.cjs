// OFFLINE PROPOSAL ONLY. This checks source preservation, not runtime authority.
'use strict';

const { createHash } = require('node:crypto');
const { existsSync, readFileSync } = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const PACKET = 'docs/engagement-preview-proposal-20261016/';
const ROOT = path.resolve(__dirname, '../../..');
const PINS = JSON.parse(readFileSync(path.join(__dirname, 'source-pins.json'), 'utf8'));
const normalize = (bytes) => bytes.toString('utf8').replace(/\r\n/g, '\n');
const sha256 = (source) => createHash('sha256').update(source).digest('hex');
const git = (...args) => execFileSync('git', args, {
  cwd: ROOT, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
});

function baselineSources() {
  return new Map(PINS.files.map(({ path: file }) => [file, git('show', `${PINS.baseCommit}:${file}`)]));
}

function currentSources() {
  return new Map(PINS.files.map(({ path: file }) => {
    const absolute = path.join(ROOT, file);
    if (existsSync(absolute)) return [file, normalize(readFileSync(absolute))];
    // A sparse-omitted source is not treated as a deletion or invented copy.
    // Require the index's skip-worktree marker and inspect its actual Git blob.
    if (git('ls-files', '-v', '--', file).trim() !== `S ${file}`) {
      throw new Error(`Missing materialized pinned source: ${file}`);
    }
    return [file, git('show', `:${file}`)];
  }));
}

function preservationFindings(sources) {
  const findings = [];
  for (const pin of PINS.files) {
    const source = sources.get(pin.path);
    if (typeof source !== 'string') findings.push(`Missing source: ${pin.path}`);
    else if (sha256(source) !== pin.sha256) findings.push(`Pinned source drift: ${pin.path}`);
  }
  for (const file of sources.keys()) {
    if (!PINS.files.some((pin) => pin.path === file)) findings.push(`Unpinned source: ${file}`);
  }
  return findings;
}

function nonPacketChanges() {
  const tracked = git('diff', '--name-only', PINS.baseCommit, '--').trim().split('\n').filter(Boolean);
  const untracked = git('ls-files', '--others', '--exclude-standard').trim().split('\n').filter(Boolean);
  return [...new Set([...tracked, ...untracked])].filter((file) => !file.startsWith(PACKET)).sort();
}

module.exports = {
  ROOT, PACKET, PINS, git, sha256, baselineSources, currentSources,
  preservationFindings, nonPacketChanges,
};
