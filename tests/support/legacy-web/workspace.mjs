import { existsSync } from 'node:fs';
import path from 'node:path';

/** Retired local UI runners must refuse before starting disposable resources. */
export function requireLegacyWebWorkspace(root, exists = existsSync) {
  if (!exists(path.join(root, 'apps/web/package.json')) ||
      !exists(path.join(root, 'apps/web/src'))) {
    throw new Error('Legacy main-Web source is retired from this backend checkout. This mixed browser/local runner requires an explicitly supplied clean historical full-source checkout; use the recorded source commit and historical-source-replay command in tests/support/legacy-web/README.md. No browser acceptance or resource proof was performed.');
  }
}
