import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test, { describe } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'marketing');
const read = (...parts) => readFileSync(join(here, ...parts), 'utf8');
const lf = (value) => value.replace(/\r\n/g, '\n');
const PAGES = ['index', 'platform', 'solutions', 'insights', 'pricing', 'privacy', 'support', 'terms'];

describe('marketing container build recipe', () => {
  test('the Dockerfile build stage invokes the generator with its required --write flag', () => {
    const dockerfile = lf(read('Dockerfile'));
    const buildStage = dockerfile.slice(dockerfile.indexOf('AS build'), dockerfile.indexOf('AS runtime'));
    assert.match(buildStage, /OUT_DIR=\/out node build\.mjs --write\b/);
    assert.doesNotMatch(buildStage, /node build\.mjs\s*$/m);
    // Runtime contract of the deployed consumer is unchanged.
    assert.match(dockerfile, /FROM nginxinc\/nginx-unprivileged:\$\{NGINX_VERSION\} AS runtime/);
    assert.match(dockerfile, /^USER nginx$/m);
    assert.match(dockerfile, /^EXPOSE 8080$/m);
  });

  test('the generated site is byte-identical to the committed pages, so the recipe fix changes no content', () => {
    const out = mkdtempSync(join(tmpdir(), 'marketing-out-'));
    mkdirSync(out, { recursive: true });
    const stdout = execFileSync(process.execPath, [join(here, 'build.mjs'), '--write'], {
      cwd: here, encoding: 'utf8', env: { ...process.env, OUT_DIR: out },
    });
    assert.match(stdout, /Built 8 pages \+ sitemap\.xml/);
    for (const page of [...PAGES.map((page) => `${page}.html`), 'sitemap.xml']) {
      assert.equal(lf(readFileSync(join(out, page), 'utf8')), lf(read(page)), page);
    }
  });

  test('the generator still refuses an invocation without exactly --write', () => {
    const empty = spawnSync(process.execPath, [join(here, 'build.mjs')], { cwd: here, encoding: 'utf8' });
    assert.equal(empty.status, 2);
    assert.match(empty.stderr, /Usage: node marketing\/build\.mjs --write/);
    const other = spawnSync(process.execPath, [join(here, 'build.mjs'), '--out'], { cwd: here, encoding: 'utf8' });
    assert.equal(other.status, 2);
    const help = spawnSync(process.execPath, [join(here, 'build.mjs'), '--help'], { cwd: here, encoding: 'utf8' });
    assert.equal(help.status, 0);
  });

  test('the existing deploy operator exposes a build-only mode and keeps push/deploy off that path', () => {
    const script = lf(read('deploy.sh'));
    const buildOnly = script.slice(script.indexOf('if [[ "$BUILD_ONLY" == 1 ]]'), script.indexOf('echo "==> ECR login"'));
    assert.match(buildOnly, /--platform linux\/arm64/);
    assert.match(buildOnly, /--load/);
    assert.match(buildOnly, /bash marketing\/smoke-8080\.sh/);
    assert.doesNotMatch(buildOnly, /--push|aws ecr|update-service|services-stable/);
    const release = script.slice(script.indexOf('echo "==> ECR login"'));
    assert.match(release, /--push/);
    assert.match(release, /update-service/);
    const rejected = spawnSync('bash', [join(here, 'deploy.sh'), '--unknown'], { cwd: here, encoding: 'utf8' });
    assert.equal(rejected.status, 2);
  });

  test('the runtime keeps the 8080 contract the legacy consumer uses', () => {
    const nginx = lf(read('nginx', 'nginx.conf'));
    assert.match(nginx, /^ {4}listen 8080 default_server;$/m);
    assert.match(nginx, /location = \/healthz \{[\s\S]*return 200 "ok\\n";/);
    assert.match(nginx, /try_files \$uri \$uri\.html \$uri\/ =404;/);
    assert.match(nginx, /add_header X-Content-Type-Options "nosniff" always;/);
  });
});
