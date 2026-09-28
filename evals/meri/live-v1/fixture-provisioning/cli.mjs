#!/usr/bin/env node
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  APPLY_CONFIRMATION,
  FIXTURE_NAMESPACE,
  RESET_CONFIRMATION,
  FixtureProvisioningError,
} from './contract.mjs';
import { buildFixtureManifest } from './manifest.mjs';
import {
  applyFixture,
  applyOwnedReset,
  planFixture,
  planOwnedReset,
  verifyFixture,
} from './provisioner.mjs';

function parseArgs(argv) {
  const args = { command: 'plan' };
  let index = 0;
  if (argv[0] && !argv[0].startsWith('--')) {
    args.command = argv[0];
    index = 1;
  }
  while (index < argv.length) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key.startsWith('--') || value === undefined || value.startsWith('--')) {
      throw new FixtureProvisioningError('ARGUMENT_INVALID', `expected --name value at ${key}`);
    }
    args[key.slice(2)] = value;
    index += 2;
  }
  return args;
}

function requireAbsolute(args, name) {
  const value = args[name];
  if (!value || !isAbsolute(value)) {
    throw new FixtureProvisioningError('ABSOLUTE_PATH_REQUIRED', `--${name} must be absolute`);
  }
  return resolve(value);
}

function rejectSensitiveConfig(value, path = 'config') {
  if (!value || typeof value !== 'object') return;
  for (const [key, nested] of Object.entries(value)) {
    if (/(?:secret|password|credential|token|cookie|databaseUrl|apiKey)/iu.test(key)) {
      throw new FixtureProvisioningError(
        'SENSITIVE_CONFIG_REFUSED',
        `${path}.${key} is forbidden; adapter credentials must remain in the existing runtime owner`,
      );
    }
    rejectSensitiveConfig(nested, `${path}.${key}`);
  }
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function writeReceipt(path, value) {
  await mkdir(resolve(path, '..'), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
  });
  await rename(temporary, path);
}

async function loadAdapter(args, config) {
  if (!args.adapter) {
    return {
      authority: 'offline_unverified',
      inspect: async () => null,
      createOwned: async () => {
        throw new FixtureProvisioningError('OFFLINE_PLAN_ONLY', 'offline plan cannot write');
      },
      replaceOwned: async () => {
        throw new FixtureProvisioningError('OFFLINE_PLAN_ONLY', 'offline plan cannot write');
      },
      deleteOwned: async () => {
        throw new FixtureProvisioningError('OFFLINE_PLAN_ONLY', 'offline plan cannot write');
      },
    };
  }
  const path = requireAbsolute(args, 'adapter');
  const module = await import(pathToFileURL(path).href);
  if (typeof module.createAdapter !== 'function') {
    throw new FixtureProvisioningError(
      'ADAPTER_INVALID',
      'adapter module must export createAdapter',
    );
  }
  const adapter = await module.createAdapter({ config });
  if (adapter?.authority !== 'canonical_readback') {
    throw new FixtureProvisioningError(
      'ADAPTER_AUTHORITY_INVALID',
      'release adapter must declare canonical_readback authority',
    );
  }
  return adapter;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const configPath = requireAbsolute(args, 'config');
  const outputPath = requireAbsolute(args, 'out');
  const config = await readJson(configPath);
  rejectSensitiveConfig(config);
  if (config.target !== 'capiro-dev' || config.fixtureNamespace !== FIXTURE_NAMESPACE) {
    throw new FixtureProvisioningError(
      'TARGET_MISMATCH',
      'config must bind exact target capiro-dev and approved fixture namespace',
    );
  }
  const manifest = await buildFixtureManifest({
    tenants: config.tenants,
    clients: config.clients,
    actors: config.actors,
    availableOwners: config.availableOwners,
  });

  if (args.command === 'source-map') {
    await writeReceipt(outputPath, manifest);
    return { kind: 'source-map', contentSha256: manifest.contentSha256, outputPath };
  }

  const adapter = await loadAdapter(args, config);
  let receipt;
  if (args.command === 'plan') {
    receipt = await planFixture({ manifest, adapter });
  } else if (args.command === 'apply') {
    const plan = await readJson(requireAbsolute(args, 'plan'));
    receipt = await applyFixture({
      manifest,
      plan,
      adapter,
      confirmation: args.confirm,
    });
  } else if (args.command === 'verify') {
    receipt = await verifyFixture({ manifest, adapter });
  } else if (args.command === 'reset-plan') {
    const seedReceipt = await readJson(requireAbsolute(args, 'seed-receipt'));
    receipt = await planOwnedReset({ manifest, seedReceipt, adapter });
  } else if (args.command === 'owned-reset') {
    const seedReceipt = await readJson(requireAbsolute(args, 'seed-receipt'));
    const resetPlan = await readJson(requireAbsolute(args, 'reset-plan'));
    receipt = await applyOwnedReset({
      manifest,
      seedReceipt,
      resetPlan,
      adapter,
      confirmation: args.confirm,
    });
  } else {
    throw new FixtureProvisioningError('COMMAND_INVALID', `unsupported command ${args.command}`);
  }
  await writeReceipt(outputPath, receipt);
  return {
    kind: receipt.kind,
    status: receipt.status ?? 'planned',
    contentSha256: receipt.contentSha256,
    outputPath,
  };
}

main()
  .then((summary) => {
    process.stdout.write(`${JSON.stringify(summary)}\n`);
  })
  .catch((error) => {
    process.stderr.write(
      `${JSON.stringify({
        status: 'failed',
        code: error?.code ?? 'FIXTURE_PROVISIONING_FAILED',
        message: error?.message ?? 'fixture provisioning failed',
      })}\n`,
    );
    process.exitCode = 1;
  });

export { APPLY_CONFIRMATION, RESET_CONFIRMATION };
