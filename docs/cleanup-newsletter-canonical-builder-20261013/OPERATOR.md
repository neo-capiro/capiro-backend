This operator assembles already-built frontend output into the existing opt-in Docker consumer's directory. It never installs, builds or executes a frontend/app, calls a provider, builds/pushes an image, or changes deployment defaults. The accepted source is neo-capiro/capiro-frontend@7c87678730538958ace9762f824dc3e588bf445b. Node24/Linux and an explicitly producer-declared amd64/arm64 musl target are required. A glibc declaration is refused; nothing retags an existing glibc build as musl. Equality of declarations does not establish native compatibility or prove a source revision was used by a build.

Supply three existing directories matching the frontend Docker's layout:

- `apps/web/.next/standalone`: maps to the artifact rootfs root.
- `apps/web/public`: maps to `rootfs/apps/web/public`.
- `apps/web/.next/static`: maps to `rootfs/apps/web/.next/static`.

The frontend owner supplies a complete inventory manifest and its SHA256. The manifest is UTF8 JSON, with exactly these top-level fields: `schemaVersion:1`, `artifactType:"capiro-frontend-next-standalone"`, `source:{repository,commit}`, `runtimeTarget:{os:"linux",arch:"amd64"|"arm64",libc:"musl",nodeMajor:24}`, `serverEntrypoint:"apps/web/server.js"`, and `entries`. Every regular file entry has exactly `{path,type:"file",bytes,sha256}`; every symlink entry has exactly `{path,type:"symlink",target}`. Paths are rootfs-relative and targets are raw relative POSIX link text. Include every file/link supplied by all three inputs, all required server/static/trace files, and all179 newsletter assets. The actual assets retain the existing canonical486014-byte floor. Empty model buffers or metadata cannot qualify actual assets. Manifest entries do not authenticate Unix permission modes.

For example, a regular entry is `{"path":"apps/web/server.js","type":"file","bytes":1234,"sha256":"<actual 64-hex digest>"}` and a link entry is `{"path":"node_modules/alias","type":"symlink","target":"./actual-module"}`. These examples are incomplete documentation, not an acceptable manifest or byte receipt. Do not replace a producer's measured source/runtime declaration with this example. The operator refuses missing/incomplete manifests before publishing any output.

The following owner-side inventory recipe produces the actual file entries and raw manifest digest from already-built inputs. It performs no install/build/app execution and does not authenticate a source/ABI declaration. Use the source and runtime declaration supported by the frontend producer's separate evidence. Do not run it on a glibc tree and assert musl. It is a preparation command, not a shipping gate:

```sh
# Existing owned inputs; the manifest must be outside all three input roots.
/usr/bin/env -i PATH=/usr/bin:/bin "$TRUSTED_NODE24" --no-addons --input-type=module - "$STANDALONE" "$PUBLIC" "$STATIC" "$MANIFEST" "$ARCH" "$LIBC" <<'JS'
import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { inspectFrontendStandalonePath, inspectFrontendStandaloneManifest } from './scripts/lib/frontend-standalone-artifact-contract.mjs';
const [standalone, publicDir, staticDir, manifestPath, arch, libc] = process.argv.slice(2);
if (process.versions.node.split('.')[0] !== '24' || !['amd64','arm64'].includes(arch) || !['musl','glibc'].includes(libc)) throw Error('producer runtime declaration required');
for (const value of [standalone,publicDir,staticDir,manifestPath]) {
  if (!value?.startsWith('/') || value==='/' || path.posix.normalize(value)!==value) throw Error('canonical absolute input required');
  inspectFrontendStandalonePath(value.slice(1));
}
async function directory(value) {
  const parts=value.split('/').filter(Boolean);
  for(let i=0;i<=parts.length;i++) {
    const file='/' + parts.slice(0,i).join('/'), stat=await fs.lstat(file);
    if(!stat.isDirectory()||stat.isSymbolicLink()||await fs.realpath(file)!==file)throw Error('nonregular ancestor');
  }
}
async function bounded(file, stat) {
  if(stat.size>64*1024*1024||await fs.realpath(file)!==file)throw Error('input budget/realpath');
  const handle=await fs.open(file,constants.O_RDONLY|constants.O_NOFOLLOW), chunks=[];
  let count=0;
  try {
    while(count<=64*1024*1024) {
      const buffer=Buffer.alloc(Math.min(65536,64*1024*1024+1-count));
      const {bytesRead}=await handle.read(buffer,0,buffer.length,count);
      if(bytesRead===0)break;
      count+=bytesRead;if(count>64*1024*1024)throw Error('input budget');
      chunks.push(buffer.subarray(0,bytesRead));
    }
    if(count!==stat.size)throw Error('snapshot changed');
    return Buffer.concat(chunks,count);
  } finally {await handle.close();}
}
const entries = new Map();let total=0;
async function walk(root, prefix) {
  await directory(root);
  for (const name of (await fs.readdir(root)).sort()) {
    const file = root + '/' + name, relative = prefix + name;
    inspectFrontendStandalonePath(relative);
    const stat = await fs.lstat(file);
    if (stat.isDirectory() && !stat.isSymbolicLink()) await walk(file, relative + '/');
    else {
      let entry;
      if (stat.isSymbolicLink()) entry = {path:relative,type:'symlink',target:await fs.readlink(file)};
      else if (stat.isFile()) {
        const bytes = await bounded(file,stat);
        entry = {path:relative,type:'file',bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};
      } else throw Error('nonregular input');
      if (entries.has(relative) && JSON.stringify(entries.get(relative)) !== JSON.stringify(entry)) throw Error('conflicting overlays');
      if(!entries.has(relative))total+=entry.type==='file'?entry.bytes:0;
      entries.set(relative, entry);
      if(entries.size>20000||total>512*1024*1024)throw Error('inventory budget');
    }
  }
}
await walk(standalone,''); await walk(publicDir,'apps/web/public/'); await walk(staticDir,'apps/web/.next/static/');
const manifest = {schemaVersion:1,artifactType:'capiro-frontend-next-standalone',
  source:{repository:'neo-capiro/capiro-frontend',commit:'7c87678730538958ace9762f824dc3e588bf445b'},
  runtimeTarget:{os:'linux',arch,libc,nodeMajor:24},serverEntrypoint:'apps/web/server.js',
  entries:[...entries].sort(([a],[b])=>a.localeCompare(b)).map(([,entry])=>entry)};
const bytes = Buffer.from(JSON.stringify(manifest)), manifestSha256=createHash('sha256').update(bytes).digest('hex');
if(bytes.length>16*1024*1024)throw Error('manifest budget');
inspectFrontendStandaloneManifest({manifestBytes:bytes,pins:{sourceRepository:manifest.source.repository,
  sourceCommit:manifest.source.commit,manifestSha256,runtimeTarget:manifest.runtimeTarget}});
await directory(path.dirname(manifestPath));
await fs.writeFile(manifestPath,bytes,{flag:'wx'});
console.log(manifestSha256);
JS
```

The builder's parser has no environment/default source, target, manifest or directory fallback. Its default workflow action should be `--plan`. The complete executable local operator is:

```sh
/bin/sh scripts/build-newsletter-release.sh --node-bin "$TRUSTED_NODE24" --plan \
  --standalone-dir "$STANDALONE" --public-dir "$PUBLIC" --static-dir "$STATIC" \
  --manifest "$MANIFEST" --manifest-sha256 "$PRODUCER_MANIFEST_SHA256" \
  --source-repository neo-capiro/capiro-frontend \
  --source-commit 7c87678730538958ace9762f824dc3e588bf445b \
  --target-platform "linux/$ARCH" --target-libc musl --target-node-major 24 \
  --backend-source-commit "$DECLARED_BACKEND_COMMIT" --output-dir "$NEW_OUTPUT"
```

Review the plan, then replace only `--plan` with `--run` for explicit assembly. The executable Node path is caller-selected trusted tooling; the launcher quotes it and clears all inherited variables before Node, including NODE_OPTIONS/loaders/proxies/provider credentials. It does not authenticate a hostile substitute Node executable. No app payload is executed. The production CLI has no synthetic identity/filesystem port option.

The parent directory must already exist and resolve without symlink ancestors. Output must be absent and must not overlap input. Limits are20000 entries,512MiB total regular bytes,64MiB per file and16MiB manifest. Bounded positional FD reads consume at most the selected limit+1 bytes even under growth; they never call whole-file readFile. Snapshots, symlink targets, exhaustive mapped inventory and declared traces are verified by the existing canonical owner before output writes. Publication stages the whole output under the same parent, uses an exclusive same-builder lock, syncs files/directories and publishes by a directory rename. The lock serializes cooperating calls; this is not a hostile namespace-race or universal filesystem proof.

The output contains `manifest.json`, `rootfs/**` and `build-receipt.json`. The receipt has schemaVersion1 and kind newsletter-release-assembly, declared frontend/backend source, manifest SHA, target, canonical artifact receipt, counts, normalized file-mode ledger, host Node/platform/arch and separate effect/provenance flags. Regular files normalize to0644 plus observed0111 execute bits; privileged permission bits are stripped. Modes are not authenticated by the input manifest and directory mode/runtime permissions are not admitted. Backend commit is declared, not independently verified. Builtin filesystem completion is self-observed; `filesystemEffectsIndependentlyAttested` remains false. Custom filesystem ports require an explicit fixture label and cannot attest builtin atomic/durable effects. Cryptographic asset byte identity is a distinct canonical-owner result.

Place the successful output at `release-artifacts/capiro-frontend` in the existing opt-in consumer context. Its seven validator flags remain explicit, including manifest/source/target/platform pins, and its three Docker provenance arguments are not defaulted. A failed build/identity/target check cannot be replaced with a metadata-only PASS. The existing default Web image/operator and deployment workflow are unchanged.

Actual approved standalone output and producer manifest are not available in the two explicitly checked backend artifact locations. No broad cache scan or frontend rebuild was performed. Synthetic physical inputs qualify assembly mechanics and independent owner revalidation only. The donor's3054files/5208trace references, actual image/health/ABI/application/runtime dependency closure,179 actual serving bytes, historical four-header parity, public edge/deployed routing and shipping remain separate acceptance holds.
