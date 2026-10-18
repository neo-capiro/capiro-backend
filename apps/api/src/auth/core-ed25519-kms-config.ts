import { KMSClient, SignCommand } from '@aws-sdk/client-kms';
import { createKmsEd25519Signer, type CoreEd25519Signer } from './core-ed25519-signer.js';
import type { CoreEd25519KeyConfig } from './core-ed25519-key-config.js';

export * from './core-ed25519-key-config.js';

/** The KMS signer for a configured purpose (no AWS call until it signs). */
export function createCoreKmsSigner(config: CoreEd25519KeyConfig, client?: KMSClient): CoreEd25519Signer {
  const kms = client ?? new KMSClient({ region: config.region, maxAttempts: 1 });
  return createKmsEd25519Signer({
    issuer: config.issuer, kid: config.kid, keyArn: config.keyArn, publicKey: config.publicKey,
    client: {
      sign: (input, options) => kms.send(new SignCommand(input as ConstructorParameters<typeof SignCommand>[0]), { abortSignal: options.abortSignal }) as never,
    },
  });
}
