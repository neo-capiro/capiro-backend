/**
 * @cleanup-smoke noArgsExit=2 helpExit=0
 *
 * Bounded build-request generator for the two legacy maintenance images. This is
 * a *request* tool: it never starts a build, never creates a project, never
 * changes IAM, never pushes an image and never deploys.
 *
 * It uses the existing ARM builder `capiro-build-web-dev` with a per-build source
 * override (sourceTypeOverride/sourceLocationOverride/sourceVersion + inline
 * buildspec) — the same method as the accepted frontend build — so no stored
 * project state changes.
 *
 * Source identity uses ONE canonical algorithm on both sides (generator and the
 * emitted verifier):
 *
 *   record  := "F\t<path>\t<sha256hex of file bytes>\n"
 *            | "L\t<path>\t<raw symlink target text>\n"
 *   digest  := sha256 over the records sorted bytewise by <path>, concatenated
 *
 * Paths are POSIX, relative to the source root, `.git` excluded. Absolute or
 * root-escaping symlink targets, tab/newline/NUL in a path and newline/NUL in a
 * link target are refused on both sides. File modes are not authenticated.
 *
 * web:  pulls the qualified frontend image digest, extracts its /app tree, runs
 *       the unchanged Linux/Node24 gates in the pinned Node24.21 musl image,
 *       assembles release-artifacts/capiro-frontend with the existing owner,
 *       builds+smokes the 8080 consumer recipe, pushes the exact commit tag to
 *       both 8080 repositories and verifies the captured immutable digest and a
 *       clean exact-digest scan for each.
 * marketing: builds+smokes marketing/Dockerfile and does the same for its single
 *       repository.
 *
 * Usage:
 *   node scripts/legacy-consumer-build-request.mjs --service web --source-kind github \
 *     --source-checkout ABS --source-commit 40HEX --out-dir ABS
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { NEWSLETTER_ACCEPTED_SOURCE_PROFILE } from './lib/frontend-standalone-artifact-contract.mjs';

export const ACCOUNT = '967807252336';
export const REGION = 'us-east-1';
export const PROJECT = 'capiro-build-web-dev';
export const SOURCE_BUCKET = 'capiro-portfolio-preview-source-967807252336-us-east-1';
export const SOURCE_PREFIX = 'inputs/';
export const NODE_IMAGE = 'public.ecr.aws/docker/library/node:24.21.0-alpine3.23@sha256:9ec4a2e289874ed0d722e1772ec2de45d2801541db8612f3638b26f128c69ac2';
export const FRONTEND_IMAGE_DIGEST = 'sha256:983eb6d99feb25e664a0a2f14244d60e906f12f88a3a262b27519ffbed53f930';
export const FRONTEND_SOURCE_COMMIT = 'ee470d7d44b811dc84d147c62a3eab7c9b5be09f';
export const CONSUMER_REPOSITORIES = Object.freeze({ web: 'capiro/dev/web', marketing: 'capiro/dev/marketing' });
export const WEB_REPOSITORIES = Object.freeze(['capiro/dev/web', 'capiro/dev/web-vnext']);
export const USAGE = 'Usage: node scripts/legacy-consumer-build-request.mjs --service web|marketing --source-kind github|s3 --source-checkout ABS --source-commit 40HEX --out-dir ABS';

export const SOURCE_DIGEST = Object.freeze({
  version: 1,
  records: 'F\\t<posix-path>\\t<sha256(content)>\\n and L\\t<posix-path>\\t<symlink target text>\\n',
  sort: 'bytewise ascending by posix-path',
  digest: 'sha256 over concatenated records',
  excludes: Object.freeze(['.git']),
  refuses: Object.freeze(['tab/newline/NUL in path', 'newline/NUL in symlink target',
    'absolute or drive/UNC-prefixed symlink target', 'symlink target escaping the source root',
    'non-regular file']),
  authenticates: Object.freeze(['relative path', 'file content bytes', 'symlink target text']),
  doesNotAuthenticate: Object.freeze(['unix mode/executable bit', 'directories', 'git object ids']),
});

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const fail = (reason) => { throw new Error('Legacy consumer build request refused: ' + reason); };
const flags = Object.freeze(['--service', '--source-kind', '--source-checkout', '--source-commit', '--out-dir']);
const MAX_ENTRIES = 60_000;
const MAX_FILE_BYTES = 64 * 1024 * 1024;

export function parseInvocation(argv) {
  if (argv.length === 1 && ['--help', '-h'].includes(argv[0])) return Object.freeze({ mode: 'help' });
  const args = argv.filter((value) => value !== '--stage');
  if (![flags.length * 2, (flags.length - 1) * 2].includes(args.length))
    fail('explicit service/source-kind/paths/commit flags required');
  // Uploading a new S3 key would need a task-specific exact-key read grant in
  // the builder role, so staging is not offered here.
  if (argv.includes('--stage'))
    fail('staging is not offered: a new S3 key needs an exact-key grant; use the github source override');
  const values = new Map();
  for (let index = 0; index < args.length; index += 2) {
    if (!flags.includes(args[index]) || values.has(args[index]) || !args[index + 1]) fail('unknown or duplicate flag');
    values.set(args[index], args[index + 1]);
  }
  const options = Object.freeze({
    service: values.get('--service'),
    sourceKind: values.get('--source-kind') ?? 'github',
    sourceCheckout: values.get('--source-checkout'),
    sourceCommit: values.get('--source-commit'),
    outDir: values.get('--out-dir'),
  });
  if (!Object.hasOwn(CONSUMER_REPOSITORIES, options.service)) fail('service must be web or marketing');
  if (!['github', 's3'].includes(options.sourceKind)) fail('source kind must be github or s3');
  if (!/^[a-f0-9]{40}$/.test(options.sourceCommit)) fail('40-hex source commit required');
  for (const value of [options.sourceCheckout, options.outDir])
    if (!value || !path.isAbsolute(value)) fail('absolute source-checkout and out-dir required');
  return Object.freeze({ mode: 'plan', options });
}

// ---------------------------------------------------------------------------
// Canonical source manifest (must stay identical to the emitted verifier below)
// ---------------------------------------------------------------------------

function recordSafePath(relative) {
  if (!relative || relative.startsWith('/') || relative.includes('\\')) fail('non-posix source path: ' + relative);
  if (/[\t\n\r\0]/.test(relative)) fail('control character in source path: ' + JSON.stringify(relative));
  if (relative.split('/').some((part) => part === '' || part === '.' || part === '..'))
    fail('non-canonical source path: ' + relative);
  return relative;
}
function recordSafeTarget(linkPath, target) {
  if (!target) fail('empty symlink target: ' + linkPath);
  if (/[\n\r\0]/.test(target)) fail('control character in symlink target: ' + linkPath);
  if (target.startsWith('/') || target.startsWith(String.fromCharCode(92)) || /^[A-Za-z]:/.test(target))
    fail('absolute symlink target: ' + linkPath);
  const normalizedTarget = target.split(String.fromCharCode(92)).join('/');
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(linkPath), normalizedTarget));
  if (resolved === '..' || resolved.startsWith('../')) fail('escaping symlink target: ' + linkPath);
  return target;
}
/** Records for already-collected entries, sorted bytewise by path. */
export function canonicalRecordBytes(entries) {
  const rows = entries.map((entry) => {
    const relative = recordSafePath(entry.path);
    if (entry.type === 'file') {
      if (!/^[a-f0-9]{64}$/.test(entry.value ?? '')) fail('file entry needs a sha256 value: ' + relative);
      return `F\t${relative}\t${entry.value}\n`;
    }
    if (entry.type === 'symlink') return `L\t${relative}\t${recordSafeTarget(relative, entry.value)}\n`;
    fail('entry type must be file or symlink: ' + relative);
  });
  // Canonical order is by path only (UTF-8 bytes). Sorting whole records would
  // order by the F/L prefix first and put a file before an interleaved symlink.
  const ordered = rows
    .map((record) => ({ path: record.slice(2, record.indexOf('\t', 2)), record }))
    .sort((left, right) => Buffer.compare(Buffer.from(left.path, 'utf8'), Buffer.from(right.path, 'utf8')));
  return Buffer.from(ordered.map((entry) => entry.record).join(''), 'utf8');
}
export function sourceDigest(entries) {
  return { digest: sha256(canonicalRecordBytes(entries)), entries: entries.length };
}
/** Walk a materialised source tree with the canonical rules. */
export function collectSourceEntries(root) {
  const entries = [];
  const walk = (absolute, prefix) => {
    for (const name of readdirSync(absolute).filter((item) => item !== '.git').sort()) {
      const local = path.join(absolute, name);
      const relative = recordSafePath(prefix ? `${prefix}/${name}` : name);
      const stat = lstatSync(local);
      if (stat.isSymbolicLink()) {
        entries.push({ path: relative, type: 'symlink', value: readlinkSync(local) });
      } else if (stat.isDirectory()) {
        walk(local, relative);
      } else if (stat.isFile()) {
        if (stat.size > MAX_FILE_BYTES) fail('source file over the size budget: ' + relative);
        entries.push({ path: relative, type: 'file', value: sha256(readFileSync(local)) });
      } else fail('non-regular source entry: ' + relative);
      if (entries.length > MAX_ENTRIES) fail('source entry budget');
    }
  };
  walk(root, '');
  return entries;
}

/**
 * Materialise the exact commit in a throw-away worktree with line-ending
 * conversion disabled, so the bytes hashed here are the bytes a Linux checkout
 * of the same commit yields. Callers must release it with
 * releaseMaterializedSource().
 */
export function materializeSource(sourceCheckout, sourceCommit) {
  const root = mkdtempSync(path.join(tmpdir(), 'legacy-source-'));
  const worktree = path.join(root, 'tree');
  const git = (...args) => execFileSync('git',
    ['-c', 'core.autocrlf=false', '-c', 'core.eol=lf', '-c', 'core.safecrlf=false', ...args],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  try {
    git('-C', sourceCheckout, 'worktree', 'add', '--detach', worktree, sourceCommit);
    const head = execFileSync('git', ['-C', worktree, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    if (head !== sourceCommit) fail('materialised worktree is not at the declared commit');
    return worktree;
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}
export function releaseMaterializedSource(sourceCheckout, worktree) {
  const root = path.dirname(worktree);
  try {
    execFileSync('git', ['-C', sourceCheckout, 'worktree', 'remove', '--force', worktree], { stdio: 'ignore' });
  } catch { /* fall through to the directory removal below */ }
  rmSync(root, { recursive: true, force: true });
}
/** Entries straight from git objects (one batched read; no worktree checkout). */
export function collectSourceEntriesFromGit(sourceCheckout, sourceCommit) {
  const listing = execFileSync('git', ['-C', sourceCheckout, 'ls-tree', '-r', '-z', sourceCommit],
    { encoding: 'buffer', maxBuffer: 256 * 1024 * 1024 }).toString('utf8').split('\u0000').filter(Boolean);
  const rows = [];
  for (const line of listing) {
    const match = /^(\d+) blob ([a-f0-9]{40})\t(.+)$/.exec(line);
    if (!match) fail('non-blob or unparsable tree entry: ' + line.slice(0, 120));
    const [, mode, object, name] = match;
    recordSafePath(name);
    if (!['100644', '100755', '120000'].includes(mode)) fail('unsupported mode for source entry: ' + name);
    rows.push({ mode, object, name });
  }
  if (rows.length > MAX_ENTRIES) fail('source entry budget');
  const input = Buffer.from(rows.map((row) => row.object + '\n').join(''), 'utf8');
  const body = execFileSync('git', ['-C', sourceCheckout, 'cat-file', '--batch', '--buffer'],
    { input, maxBuffer: 1024 * 1024 * 1024 });
  const entries = [];
  let offset = 0;
  for (const row of rows) {
    const headerEnd = body.indexOf(10, offset);
    if (headerEnd < 0) fail('truncated cat-file header');
    const header = body.subarray(offset, headerEnd).toString('utf8');
    const headerMatch = /^([a-f0-9]{40}) blob (\d+)$/.exec(header);
    if (!headerMatch || headerMatch[1] !== row.object) fail('unexpected cat-file object for ' + row.name);
    const size = Number(headerMatch[2]);
    const start = headerEnd + 1;
    const end = start + size;
    if (!Number.isSafeInteger(size) || end > body.length) fail('truncated cat-file body for ' + row.name);
    const bytes = body.subarray(start, end);
    offset = end + 1; // one LF terminator follows each body
    if (row.mode === '120000') {
      entries.push({ path: row.name, type: 'symlink', value: bytes.toString('utf8') });
      continue;
    }
    if (size > MAX_FILE_BYTES) fail('source file over the size budget: ' + row.name);
    entries.push({ path: row.name, type: 'file', value: sha256(bytes) });
  }
  return entries;
}
/**
 * Canonical digest of an exact commit's content (git objects; no 27k-file
 * worktree is materialised). The job's verifier recomputes the same records over
 * its checkout and fails closed on any byte difference, so a checkout that
 * converted line endings or applied a filter cannot pass silently.
 */
export function treeDigest(sourceCheckout, sourceCommit) {
  return sourceDigest(collectSourceEntriesFromGit(sourceCheckout, sourceCommit));
}

// ---------------------------------------------------------------------------
// Emitted job script: identical digest verifier + image identity/scan checks
// ---------------------------------------------------------------------------

const BUILDSPEC_DIGEST_STEP = `# BEGIN SOURCE-DIGEST-VERIFIER
python3 - <<'PY'
import hashlib, os, posixpath, stat, sys

MAX_BYTES = 64 * 1024 * 1024
MAX_ENTRIES = 60000

def refuse(reason):
    sys.stderr.write('SOURCE_TREE_REFUSED ' + reason + '\\n')
    raise SystemExit(1)

def safe_path(relative):
    if not relative or relative.startswith('/') or '\\\\' in relative:
        refuse('non-posix source path ' + repr(relative))
    if any(ch in relative for ch in '\\t\\n\\r\\x00'):
        refuse('control character in source path ' + repr(relative))
    if any(part in ('', '.', '..') for part in relative.split('/')):
        refuse('non-canonical source path ' + repr(relative))
    return relative

def safe_target(link_path, target):
    if not target:
        refuse('empty symlink target ' + link_path)
    if any(ch in target for ch in '\\n\\r\\x00'):
        refuse('control character in symlink target ' + link_path)
    if target.startswith('/') or target.startswith(chr(92)) or (len(target) > 1 and target[1] == ':'):
        refuse('absolute symlink target ' + link_path)
    normalized = target.replace(chr(92), '/')
    parent = posixpath.dirname(link_path)
    resolved = posixpath.normpath(posixpath.join(parent, normalized)) if parent else posixpath.normpath(normalized)
    if resolved == '..' or resolved.startswith('../') or resolved.startswith('/'):
        refuse('escaping symlink target ' + link_path)
    return target

rows = []
count = 0
for base, dirs, files in os.walk('.'):
    dirs[:] = sorted(d for d in dirs if d != '.git')
    names = sorted(files)
    for name in list(dirs):
        full = os.path.join(base, name)
        if os.path.islink(full):
            dirs.remove(name)
            names.append(name)
    for name in sorted(names):
        if name == '.git':
            continue
        full = os.path.join(base, name)
        relative = safe_path(os.path.relpath(full, '.').replace(os.sep, '/'))
        info = os.lstat(full)
        if stat.S_ISLNK(info.st_mode):
            rows.append((relative, 'L\\t%s\\t%s\\n' % (relative, safe_target(relative, os.readlink(full)))))
        elif stat.S_ISREG(info.st_mode):
            if info.st_size > MAX_BYTES:
                refuse('source file over the size budget ' + relative)
            digest = hashlib.sha256()
            with open(full, 'rb') as handle:
                for chunk in iter(lambda: handle.read(1024 * 1024), b''):
                    digest.update(chunk)
            rows.append((relative, 'F\\t%s\\t%s\\n' % (relative, digest.hexdigest())))
        else:
            refuse('non-regular source entry ' + relative)
        count += 1
        if count > MAX_ENTRIES:
            refuse('source entry budget')
# Canonical order is by path only (UTF-8 bytes); sorting whole records would
# order by the F/L prefix first and disagree with a symlink that sorts earlier.
rows.sort(key=lambda entry: entry[0].encode('utf-8'))
digest = hashlib.sha256(''.join(record for _, record in rows).encode('utf-8')).hexdigest()
expected = os.environ['EXPECTED_TREE_SHA256']
if digest != expected:
    print('SOURCE_TREE_DIGEST_MISMATCH', digest, expected)
    raise SystemExit(1)
print('SOURCE_TREE_DIGEST_PASS', digest, count)
PY
# END SOURCE-DIGEST-VERIFIER
`;

// Pushed-digest capture + per-repository immutable identity/scan verification.
// Both web repositories must end up holding the same admitted image digest.
const ADMITTED_IMAGE_CHECK = `# BEGIN ADMITTED-IMAGE-CHECK
pushed_digest() {
  image_ref="$1"
  repository="$2"
  case "$repository" in
    ${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com/*) ;;
    *) echo "PUSH_DIGEST_REFUSED $repository: capture requires the exact fully-qualified ECR repository URI" >&2; exit 1 ;;
  esac
  slug="$(printf '%s' "$repository" | tr '/' '-')"
  docker image inspect "$image_ref" --format '{{json .RepoDigests}}' > "pushed-repo-digests-$slug.json"
  python3 - "$repository" "pushed-repo-digests-$slug.json" <<'PY'
import json, re, sys
repository, source = sys.argv[1], sys.argv[2]
rows = json.load(open(source))
prefix = repository + '@'
matches = [row for row in rows if row.startswith(prefix)]
if len(matches) != 1:
    raise SystemExit('PUSH_DIGEST_REFUSED %s: expected one pushed reference, found %d' % (repository, len(matches)))
digest = matches[0][len(prefix):]
if not re.fullmatch(r'sha256:[0-9a-f]{64}', digest):
    raise SystemExit('PUSH_DIGEST_REFUSED %s: malformed %r' % (repository, digest))
print(digest)
PY
}

verify_admitted_image() {
  repository="$1"
  captured="$2"
  slug="$(printf '%s' "$repository" | tr '/' '-')"
  case "$captured" in sha256:*) ;; *) echo "ADMITTED_IMAGE_REFUSED $repository: no captured digest" >&2; exit 1 ;; esac
  # The exact commit tag must resolve to the digest the build pushed.
  tagged="$(aws ecr describe-images --region ${REGION} --repository-name "$repository" \
    --image-ids "imageTag=$EXPECTED_SHA" --query 'imageDetails[0].imageDigest' --output text)"
  test "$tagged" = "$captured" || { echo "ADMITTED_IMAGE_REFUSED $slug: tag resolves to $tagged not $captured" >&2; exit 1; }
  aws ecr describe-images --region ${REGION} --repository-name "$repository" \
    --image-ids "imageDigest=$captured" --output json > "evidence-image-$slug.json"
  python3 - "$slug" "$captured" "$EXPECTED_SHA" "evidence-image-$slug.json" <<'PY'
import json, sys
slug, captured, tag, source = sys.argv[1:5]
detail = json.load(open(source))['imageDetails'][0]
if detail.get('imageDigest') != captured:
    raise SystemExit('ADMITTED_IMAGE_REFUSED %s: describe-images returned %r' % (slug, detail.get('imageDigest')))
if tag not in (detail.get('imageTags') or []):
    raise SystemExit('ADMITTED_IMAGE_REFUSED %s: exact tag missing on the captured digest' % slug)
if detail.get('imageStatus') != 'ACTIVE':
    raise SystemExit('ADMITTED_IMAGE_REFUSED %s: status %r' % (slug, detail.get('imageStatus')))
print('ADMITTED_IMAGE_IDENTITY_PASS', slug, captured)
PY
  # Scan status, image identity and severities all come from the same response.
  SCAN_ATTEMPTS="\${SCAN_ATTEMPTS:-30}"
  SCAN_INTERVAL="\${SCAN_INTERVAL:-10}"
  attempt=0
  while :; do
    attempt=$((attempt + 1))
    aws ecr describe-image-scan-findings --region ${REGION} --repository-name "$repository" \
      --image-id "imageDigest=$captured" --output json > "evidence-scan-$slug.json" 2>/dev/null || true
    if python3 - "$slug" "$captured" "evidence-scan-$slug.json" <<'PY'
import json, sys
slug, captured, source = sys.argv[1:4]
try:
    document = json.load(open(source))
except Exception:
    print('SCAN_PENDING', slug); raise SystemExit(3)
if document.get('imageId', {}).get('imageDigest') != captured:
    raise SystemExit('SCAN_REFUSED %s: response image identity %r' % (slug, document.get('imageId', {}).get('imageDigest')))
status = document.get('imageScanStatus', {}).get('status')
if status != 'COMPLETE':
    print('SCAN_PENDING', slug, status); raise SystemExit(3)
print('SCAN_STATUS_PASS', slug, status)
PY
    then break; fi
    test "$attempt" -lt "$SCAN_ATTEMPTS" || { echo "SCAN_REFUSED $slug: no COMPLETE scan for $captured" >&2; exit 1; }
    sleep "$SCAN_INTERVAL"
  done
  python3 - "$slug" "$captured" "evidence-scan-$slug.json" <<'PY'
import json, sys
slug, captured, source = sys.argv[1:4]
document = json.load(open(source))
if document.get('imageId', {}).get('imageDigest') != captured:
    raise SystemExit('SCAN_REFUSED %s: response image identity drifted' % slug)
if document.get('imageScanStatus', {}).get('status') != 'COMPLETE':
    raise SystemExit('SCAN_REFUSED %s: status %r' % (slug, document.get('imageScanStatus')))
findings = document.get('imageScanFindings', {}).get('findingSeverityCounts', {})
blocking = int(findings.get('HIGH', 0)) + int(findings.get('CRITICAL', 0))
print('SCAN_SEVERITY', slug, json.dumps(findings, sort_keys=True))
if blocking:
    raise SystemExit('SCAN_REFUSED %s: blocking findings %d' % (slug, blocking))
print('SCAN_CLEAN_PASS', slug, captured)
PY
}
# END ADMITTED-IMAGE-CHECK
`;

const SOURCE_KINDS = Object.freeze({
  github: Object.freeze({ type: 'GITHUB', location: 'https://github.com/neo-capiro/capiro-backend.git' }),
  s3: Object.freeze({ type: 'S3' }),
});

const PRELUDE_COMMON = `set -euo pipefail
: "\${EXPECTED_SHA:?exact source commit required}"
: "\${EXPECTED_TREE_SHA256:?exact source tree digest required}"
test "$(uname -m)" = aarch64
test "$(aws sts get-caller-identity --query Account --output text)" = ${ACCOUNT}
case "$(docker info --format '{{.Architecture}}')" in aarch64|arm64) ;; *) echo 'container engine is not arm64' >&2; exit 1 ;; esac
${BUILDSPEC_DIGEST_STEP}
aws ecr get-login-password --region ${REGION} \\\
  | docker login --username AWS --password-stdin ${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com
`;
const PRELUDE_GITHUB = `${PRELUDE_COMMON}test "\${CODEBUILD_RESOLVED_SOURCE_VERSION:-}" = "$EXPECTED_SHA"
test "$(git rev-parse HEAD)" = "$EXPECTED_SHA"
test -z "$(git status --porcelain --untracked-files=no)"
`;
const PRELUDE_S3 = `: "\${EXPECTED_S3_VERSION:?immutable S3 source version required}"
test "\${CODEBUILD_SOURCE_VERSION:-}" = "$EXPECTED_S3_VERSION"
${PRELUDE_COMMON}`;

const webBuildspec = (kind) => `set -euo pipefail
FE_IMAGE=${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com/capiro/portfolio-preview@${FRONTEND_IMAGE_DIGEST}
NODE_IMAGE=${NODE_IMAGE}
CONSUMER_IMAGE=${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com/${CONSUMER_REPOSITORIES.web}:$EXPECTED_SHA
${kind === 'github' ? PRELUDE_GITHUB : PRELUDE_S3}
${ADMITTED_IMAGE_CHECK}
docker pull "$FE_IMAGE"
test "$(docker image inspect "$FE_IMAGE" --format '{{.Os}}/{{.Architecture}}')" = linux/arm64
test "$(docker image inspect "$FE_IMAGE" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')" = ${FRONTEND_SOURCE_COMMIT}
test "$(docker run --rm --network none --entrypoint /usr/local/bin/node "$FE_IMAGE" -v)" = v24.21.0
docker run --rm --network none --entrypoint sh "$FE_IMAGE" -ec 'grep -q "^3.23" /etc/alpine-release'
docker pull "$NODE_IMAGE"
test "$(docker image inspect "$NODE_IMAGE" --format '{{.Os}}/{{.Architecture}}')" = linux/arm64
# Extract the qualified producer's /app root (the accepted standalone bytes).
container="$(docker create "$FE_IMAGE")"
trap 'docker rm -f "$container" >/dev/null 2>&1 || true' EXIT
mkdir -p work/app
docker cp "$container:/app/." work/app
docker rm -f "$container" >/dev/null
# Unchanged Linux/Node24 gates run in the pinned musl Node24.21 image.
docker run --rm -v "$PWD:/src" -w /src "$NODE_IMAGE" node --test \\\
  scripts/ci/legacy-web-release.spec.mjs \\\
  scripts/ci/newsletter-accepted-source-profile.spec.mjs \\\
  scripts/ci/frontend-standalone-artifact.contract.spec.mjs
docker run --rm -v "$PWD:/src" -v "$PWD/work:/work" -w /src "$NODE_IMAGE" \\\
  node scripts/legacy-web-release.mjs artifact \\\
  --extracted-app-dir /work/app \\\
  --frontend-commit ${FRONTEND_SOURCE_COMMIT} \\\
  --image-digest ${FRONTEND_IMAGE_DIGEST} \\\
  --manifest /work/artifact.manifest.json \\\
  --output-dir /src/release-artifacts/capiro-frontend \\\
  --backend-commit "$EXPECTED_SHA" \\\
  --arch arm64 | tee work/assembly.json
MANIFEST_SHA256="$(sha256sum release-artifacts/capiro-frontend/manifest.json | cut -d' ' -f1)"
test -s release-artifacts/capiro-frontend/build-receipt.json
docker build --platform linux/arm64 -f apps/web/Dockerfile \\\
  --build-arg FRONTEND_ARTIFACT_MANIFEST_SHA256="$MANIFEST_SHA256" \\\
  --build-arg FRONTEND_ARTIFACT_SOURCE_REPOSITORY=neo-capiro/capiro-frontend \\\
  --build-arg FRONTEND_ARTIFACT_SOURCE_COMMIT=${FRONTEND_SOURCE_COMMIT} \\\
  --build-arg TARGETPLATFORM=linux/arm64 \\\
  --label "org.opencontainers.image.revision=$EXPECTED_SHA" \\\
  --label "org.opencontainers.image.source=https://github.com/neo-capiro/capiro-backend" \\\
  -t "$CONSUMER_IMAGE" .
test "$(docker image inspect "$CONSUMER_IMAGE" --format '{{.Architecture}}')" = arm64
test "$(docker image inspect "$CONSUMER_IMAGE" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')" = "$EXPECTED_SHA"
LOCAL_IMAGE_ID="$(docker image inspect "$CONSUMER_IMAGE" --format '{{.Id}}')"
case "$LOCAL_IMAGE_ID" in sha256:*) ;; *) echo 'local image id is not immutable' >&2; exit 1 ;; esac
bash apps/web/smoke-8080.sh "$CONSUMER_IMAGE"
test "$(docker image inspect "$CONSUMER_IMAGE" --format '{{.Id}}')" = "$LOCAL_IMAGE_ID"
# The same admitted image serves both 8080 consumers; publish the exact commit tag
# to both repositories, then verify each tag resolves to the digest the local
# build+smoke used and that each digest has a clean scan.
for repository in ${WEB_REPOSITORIES.join(' ')}; do
  target=${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com/$repository:$EXPECTED_SHA
  if [ "$target" != "$CONSUMER_IMAGE" ]; then
    docker tag "$CONSUMER_IMAGE" "$target"
  fi
  docker push "$target"
done
test "$(docker image inspect "$CONSUMER_IMAGE" --format '{{.Id}}')" = "$LOCAL_IMAGE_ID"
REGISTRY_URI=${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com
DIGEST_PRIMARY="$(pushed_digest "$CONSUMER_IMAGE" "$REGISTRY_URI"/${CONSUMER_REPOSITORIES.web})"
DIGEST_VNEXT="$(pushed_digest "$CONSUMER_IMAGE" "$REGISTRY_URI"/capiro/dev/web-vnext)"
test "$DIGEST_PRIMARY" = "$DIGEST_VNEXT" || { echo "ADMITTED_IMAGE_REFUSED cross-repository digest disagreement" >&2; exit 1; }
verify_admitted_image ${CONSUMER_REPOSITORIES.web} "$DIGEST_PRIMARY"
verify_admitted_image capiro/dev/web-vnext "$DIGEST_VNEXT"`;

const marketingBuildspec = (kind) => `set -euo pipefail
IMAGE=${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com/${CONSUMER_REPOSITORIES.marketing}:$EXPECTED_SHA
${kind === 'github' ? PRELUDE_GITHUB : PRELUDE_S3}
${ADMITTED_IMAGE_CHECK}
docker build --platform linux/arm64 -f marketing/Dockerfile \\\
  --label "org.opencontainers.image.revision=$EXPECTED_SHA" \\\
  --label "org.opencontainers.image.source=https://github.com/neo-capiro/capiro-backend" \\\
  -t "$IMAGE" .
test "$(docker image inspect "$IMAGE" --format '{{.Architecture}}')" = arm64
test "$(docker image inspect "$IMAGE" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')" = "$EXPECTED_SHA"
LOCAL_IMAGE_ID="$(docker image inspect "$IMAGE" --format '{{.Id}}')"
bash marketing/smoke-8080.sh "$IMAGE"
test "$(docker image inspect "$IMAGE" --format '{{.Id}}')" = "$LOCAL_IMAGE_ID"
docker push "$IMAGE"
test "$(docker image inspect "$IMAGE" --format '{{.Id}}')" = "$LOCAL_IMAGE_ID"
REGISTRY_URI=${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com
DIGEST="$(pushed_digest "$IMAGE" "$REGISTRY_URI"/${CONSUMER_REPOSITORIES.marketing})"
verify_admitted_image ${CONSUMER_REPOSITORIES.marketing} "$DIGEST"`;

export function buildspecFor(service, sourceKind = 'github') {
  if (!Object.hasOwn(SOURCE_KINDS, sourceKind)) fail('source kind must be github or s3');
  const script = service === 'web' ? webBuildspec(sourceKind) : marketingBuildspec(sourceKind);
  const encoded = gzipSync(Buffer.from(script, 'utf8')).toString('base64');
  return {
    version: 0.2,
    env: { shell: 'bash' },
    phases: {
      build: {
        'on-failure': 'ABORT',
        commands: [`set -euo pipefail\nprintf '%s' '${encoded}' | base64 -d | gzip -dc | bash`],
      },
    },
  };
}

/** Source admission: the consumer's declared frontend source must be active. */
export function assertSourceSelection(service) {
  if (service !== 'web') return null;
  const active = NEWSLETTER_ACCEPTED_SOURCE_PROFILE.activeCommit;
  if (active !== FRONTEND_SOURCE_COMMIT) fail('generator pin does not match the reviewed active artifact source');
  return active;
}

export function createPlan(options) {
  if (!options || typeof options !== 'object') fail('explicit options required');
  const checkoutHead = execFileSync('git', ['-C', options.sourceCheckout, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  if (checkoutHead !== options.sourceCommit) fail('source checkout is not at the declared commit');
  if (execFileSync('git', ['-C', options.sourceCheckout, 'status', '--porcelain', '--untracked-files=no'],
    { encoding: 'utf8' }).trim() !== '') fail('source checkout has tracked modifications');
  assertSourceSelection(options.service);
  const kind = options.sourceKind ?? 'github';
  const buildspec = buildspecFor(options.service, kind);
  const buildspecOverride = JSON.stringify(buildspec);
  if (buildspecOverride.length > 25_600) fail(`BUILDSPEC_TOO_LONG_${buildspecOverride.length}`);
  const measured = treeDigest(options.sourceCheckout, options.sourceCommit);
  const key = `${SOURCE_PREFIX}${options.service}-${options.sourceCommit}.zip`;
  const source = kind === 'github'
    ? Object.freeze({ type: 'GITHUB', location: SOURCE_KINDS.github.location,
      sourceVersion: options.sourceCommit, sourceCommit: options.sourceCommit,
      treeDigestSha256: measured.digest, treeDigestEntries: measured.entries, treeDigestAlgorithm: SOURCE_DIGEST,
      requiredGrant: null })
    : Object.freeze({ type: 'S3', bucket: SOURCE_BUCKET, key, prefix: SOURCE_PREFIX,
      sourceVersion: null, sourceCommit: options.sourceCommit,
      treeDigestSha256: measured.digest, treeDigestEntries: measured.entries, treeDigestAlgorithm: SOURCE_DIGEST,
      requiredGrant: Object.freeze({ actions: Object.freeze(['s3:GetObject', 's3:GetObjectVersion']),
        resource: `arn:aws:s3:::${SOURCE_BUCKET}/${key}`,
        note: 'existing role grants are exact-key; a new key needs this grant before start-build' }) });
  return Object.freeze({
    schemaVersion: 1, kind: 'legacy-consumer-build-request', generatedAt: new Date().toISOString(),
    service: options.service, sourceKind: kind, project: PROJECT, region: REGION, account: ACCOUNT,
    source,
    frontend: options.service === 'web' ? Object.freeze({ imageDigest: FRONTEND_IMAGE_DIGEST,
      sourceCommit: FRONTEND_SOURCE_COMMIT,
      activeAcceptedSource: NEWSLETTER_ACCEPTED_SOURCE_PROFILE.activeCommit }) : null,
    consumerRepository: CONSUMER_REPOSITORIES[options.service],
    admittedRepositories: options.service === 'web' ? WEB_REPOSITORIES : [CONSUMER_REPOSITORIES.marketing],
    imageTagPolicy: 'exact-40-hex source commit only; no latest, no mutable-tag scan',
    buildspecSha256: sha256(Buffer.from(buildspecOverride, 'utf8')), buildspecCharacters: buildspecOverride.length,
    environmentVariables: [
      { name: 'EXPECTED_SHA', value: options.sourceCommit, type: 'PLAINTEXT' },
      { name: 'EXPECTED_TREE_SHA256', value: measured.digest, type: 'PLAINTEXT' },
      ...(kind === 's3' ? [{ name: 'EXPECTED_S3_VERSION', value: '<S3_VERSION_ID>', type: 'PLAINTEXT' }] : []),
    ],
    stages: Object.freeze([
      'verify caller/account/arm64, git HEAD and the canonical source digest',
      'web: pull the qualified frontend digest, assert arch/label/node/libc, extract /app',
      'run the unchanged Linux/Node24 gate specs in the pinned Node24.21 musl image',
      'web: assemble release-artifacts/capiro-frontend through the existing owner',
      'build+smoke the consumer image, push the exact-SHA tag, bind and verify the captured digest and a clean scan',
    ]),
    startBuildPerformed: false, projectMutated: false, iamChanged: false, deployed: false,
    imagePushed: false, scanPerformed: false,
  });
}

export function startBuildRequest(plan, sourceVersion, idempotencyToken) {
  const kind = plan.sourceKind ?? 'github';
  const version = kind === 'github' ? plan.source.sourceVersion : sourceVersion;
  if (!/^[A-Za-z0-9+/=_.:-]{8,120}$/.test(version ?? ''))
    fail('immutable source version (commit or S3 VersionId) required');
  return {
    projectName: plan.project,
    sourceTypeOverride: SOURCE_KINDS[kind].type,
    sourceLocationOverride: kind === 'github' ? SOURCE_KINDS.github.location
      : `${plan.source.bucket}/${plan.source.key}`,
    sourceVersion: version,
    buildspecOverride: JSON.stringify(buildspecFor(plan.service, kind)),
    environmentVariablesOverride: plan.environmentVariables.map((item) =>
      item.name === 'EXPECTED_S3_VERSION' ? { ...item, value: version } : item),
    idempotencyToken,
    timeoutInMinutesOverride: 60,
  };
}

function main(argv) {
  try {
    const invocation = parseInvocation(argv);
    if (invocation.mode === 'help') { console.log(USAGE); return; }
    mkdirSync(invocation.options.outDir, { recursive: true });
    const plan = createPlan(invocation.options);
    const sourceVersion = plan.sourceKind === 'github' ? plan.source.sourceVersion : null;
    const request = sourceVersion ? startBuildRequest(plan, sourceVersion,
      `legacy-${plan.service}-${plan.source.sourceCommit.slice(0, 12)}`) : null;
    writeFileSync(path.join(invocation.options.outDir, 'build-request-plan.json'),
      `${JSON.stringify(plan, null, 2)}\n`);
    if (request) writeFileSync(path.join(invocation.options.outDir, 'start-build.request.json'),
      `${JSON.stringify(request, null, 2)}\n`);
    console.log(JSON.stringify({ mode: invocation.mode, service: plan.service, project: plan.project,
      buildspecSha256: plan.buildspecSha256, buildspecCharacters: plan.buildspecCharacters,
      treeDigestSha256: plan.source.treeDigestSha256, treeDigestEntries: plan.source.treeDigestEntries,
      sourceKey: plan.source.key ?? null, sourceVersion, outDir: invocation.options.outDir,
      startBuildPerformed: false, imagePushed: false, scanPerformed: false, deployed: false }, null, 2));
  } catch (error) {
    console.error(JSON.stringify({ status: 'FAIL', startBuildPerformed: false, imagePushed: false,
      scanPerformed: false, deployed: false, usage: USAGE, error: String(error.message).slice(0, 300) }));
    process.exitCode = 2;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
