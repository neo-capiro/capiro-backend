const assert = require('node:assert/strict');

// An explicit image-local selection lets the retained ARM64 qualification
// continue unchanged while the preview's AMD64 image exercises the same gates.
const platforms = Object.freeze({
  arm64: Object.freeze({
    cpu: 'arm64', machine: 183, loader: '/lib/ld-musl-aarch64.so.1',
    bannerCpu: 'aarch64', prisma: 'linux-musl-arm64-openssl-3.0.x',
    glibcPrisma: 'linux-arm64-openssl-3.0.x',
    libsql: '@libsql/linux-arm64-musl',
    canvas: '@napi-rs/canvas-linux-arm64-musl',
    swc: '@swc/core-linux-arm64-musl',
    esbuild: '@esbuild/linux-arm64',
    sharp: '@img/sharp-linuxmusl-arm64',
  }),
  x64: Object.freeze({
    cpu: 'x64', machine: 62, loader: '/lib/ld-musl-x86_64.so.1',
    bannerCpu: 'x86_64', prisma: 'linux-musl-openssl-3.0.x',
    glibcPrisma: 'debian-openssl-3.0.x',
    libsql: '@libsql/linux-x64-musl',
    canvas: '@napi-rs/canvas-linux-x64-musl',
    swc: '@swc/core-linux-x64-musl',
    esbuild: '@esbuild/linux-x64',
    sharp: '@img/sharp-linuxmusl-x64',
  }),
});

function selectedPlatform(environment = process.env) {
  const value = environment.CAPIRO_QUALIFICATION_ARCH || 'arm64';
  assert(Object.hasOwn(platforms, value), 'unsupported Alpine qualification architecture');
  return platforms[value];
}

module.exports = { platforms, selectedPlatform };
