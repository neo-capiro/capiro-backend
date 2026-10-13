const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const base = '/workspace/capirov2/apps/api/package.json';
const resolver = createRequire(base);
const names = ['@nestjs/common', '@nestjs/core', '@nestjs/platform-express', '@nestjs/testing', '@nestjs/config', '@nestjs/cli', '@nestjs/schematics', '@clerk/backend', '@prisma/client', 'prisma', 'typescript', 'jest', 'ts-jest', 'tsx', 'ts-node', 'supertest', 'reflect-metadata', 'class-transformer', 'class-validator', 'rxjs', 'express', 'pg'];
const packages = names.map((name) => {
  try {
    const entry = resolver.resolve(name);
    let directory = path.dirname(entry);
    while (directory !== path.dirname(directory)) {
      const file = path.join(directory, 'package.json');
      if (fs.existsSync(file)) {
        const bytes = fs.readFileSync(file);
        const metadata = JSON.parse(bytes);
        if (metadata.name === name) return { name, version: metadata.version, entry, resolvedEntry: fs.realpathSync(entry), packageFile: file, packageSha256: crypto.createHash('sha256').update(bytes).digest('hex') };
      }
      directory = path.dirname(directory);
    }
    return { name, entry, error: 'matching-package-metadata-not-found' };
  } catch (error) {
    const file = path.join(path.dirname(base), 'node_modules', name, 'package.json');
    if (fs.existsSync(file)) {
      const bytes = fs.readFileSync(file);
      const metadata = JSON.parse(bytes);
      return { name, version: metadata.version, packageFile: file, resolvedPackageFile: fs.realpathSync(file), packageSha256: crypto.createHash('sha256').update(bytes).digest('hex'), noModuleEntry: true, bin: metadata.bin, binFilesPresent: Object.values(metadata.bin || {}).every((bin) => fs.existsSync(path.join(path.dirname(file), bin))) };
    }
    return { name, error: error.code };
  }
});
console.log(JSON.stringify({ schemaVersion: 1, base, nodeVersion: process.version, platform: process.platform, architecture: process.arch, packageCodeImported: false, clientConstructed: false, packages }, null, 2));
