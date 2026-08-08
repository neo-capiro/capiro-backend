/**
 * Crash-safe restore journal for the negative-control runners.
 *
 * Every `verify-pe-budget-phase-*-negative-controls` script deliberately writes
 * a defect into real production source, runs a focused test that must fail, and
 * restores the file in `finally`. That is correct right up until the process is
 * *killed* — an external timeout, a cancelled CI job, Ctrl-C — because `finally`
 * does not run and the only copy of the original bytes is an in-memory Buffer
 * that dies with the process. The mutated file stays on disk.
 *
 * That is not hypothetical. Session 7's run of the Phase 6 runner was killed by
 * a 200s timeout during NC06, leaving NC06's injected defect — an
 * identity-conflation bug that binds an accountless procurement reference at
 * confidence 1.0 across account and base/advance-procurement boundaries — in
 * `line-reference-resolver.ts`. Nothing in the ordinary suite catches it,
 * because its detector lives in the runner's own focused spec, which never ran.
 * It surfaced only as an unattributed one-line diff and came within one
 * `git add` of being committed to a financial-truth pipeline.
 *
 * The fix is that originals reach disk *before* the first mutation and are
 * deleted only after a restore has been verified byte-for-byte. A killed run
 * then leaves a journal instead of a silent defect, and the next run restores
 * from it and says so loudly.
 *
 * The journal directory is deliberately inside the package (not a temp dir) so
 * that an abandoned one is visible to `git status` as well as to the next run.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface SourceMutationJournalOptions {
  /** Package root every relative file path is resolved against. */
  root: string;
  /** Directory name for the journal, e.g. `.p6-nc-restore`. */
  directoryName: string;
  /** Where recovery notices go. Defaults to stderr. */
  log?: (message: string) => void;
}

export class SourceMutationJournal {
  private readonly dir: string;
  private readonly log: (message: string) => void;

  constructor(private readonly options: SourceMutationJournalOptions) {
    this.dir = path.join(options.root, options.directoryName);
    this.log = options.log ?? ((message) => process.stderr.write(`${message}\n`));
  }

  private slotFor(relativeFile: string): string {
    return path.join(this.dir, relativeFile.replace(/[\\/]/g, '__'));
  }

  /**
   * Restore anything a previous killed run abandoned. Call once, before the
   * first mutation. Returns the files it restored.
   */
  recoverAbandoned(): string[] {
    if (!fs.existsSync(this.dir)) return [];
    const manifests = fs.readdirSync(this.dir).filter((name) => name.endsWith('.json'));
    if (manifests.length === 0) {
      fs.rmSync(this.dir, { recursive: true, force: true });
      return [];
    }

    this.log('');
    this.log(
      `!! A previous run did not restore its mutations (${manifests.length} file(s)). A killed`,
    );
    this.log('!! negative-control run leaves injected DEFECTS in production source. Restoring.');

    const restored: string[] = [];
    for (const manifest of manifests) {
      const parsed = JSON.parse(fs.readFileSync(path.join(this.dir, manifest), 'utf8')) as {
        file: string;
        controlId: string;
      };
      fs.writeFileSync(
        path.join(this.options.root, parsed.file),
        fs.readFileSync(this.slotFor(parsed.file)),
      );
      this.log(`!! restored ${parsed.file} (abandoned by ${parsed.controlId})`);
      restored.push(parsed.file);
    }

    fs.rmSync(this.dir, { recursive: true, force: true });
    this.log('!! Recovery complete.');
    this.log('');
    return restored;
  }

  /** Record a file's original bytes. Call BEFORE the first write to it. */
  record(controlId: string, relativeFile: string, original: Buffer): void {
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(this.slotFor(relativeFile), original);
    fs.writeFileSync(
      `${this.slotFor(relativeFile)}.json`,
      JSON.stringify({ file: relativeFile, controlId }),
    );
  }

  /** Drop the journal. Call ONLY after every restore is verified byte-for-byte. */
  clear(): void {
    fs.rmSync(this.dir, { recursive: true, force: true });
  }
}
