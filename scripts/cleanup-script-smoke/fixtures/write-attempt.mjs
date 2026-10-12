// Owned adversarial fixture: attempts to write next to itself. The staged repo
// is bind-mounted READ-ONLY, so this must fail with EROFS and be surfaced as a
// WRITE DENIAL — never a pass.
import { writeFileSync } from 'node:fs';
try {
  writeFileSync(new URL('./attack.txt', import.meta.url), 'owned-fixture');
  console.log('WROTE');
  process.exit(0);
} catch (e) {
  console.log('WRITE_ERR', e.code);
  process.exit(5);
}
