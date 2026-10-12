// Owned adversarial fixture: attempts to write next to itself on the read-only
// staged tree, SWALLOWS the EROFS error, and exits 0 with no diagnostic. The
// denied-syscall audit must still record the denied write (attempt-audit.mjs).
import { writeFileSync } from 'node:fs';
try {
  writeFileSync(new URL('./attack-caught.txt', import.meta.url), 'owned-fixture');
} catch {
  /* suppressed on purpose */
}
process.exit(0);
