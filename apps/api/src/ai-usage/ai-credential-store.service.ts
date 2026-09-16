/**
 * Write/read store for tenant AI credentials (tenant_ai_credentials).
 *
 * WRITE-ONLY contract: the plaintext key goes in, is validated against the
 * provider (1-token test call), encrypted with AI_CREDENTIAL_ENCRYPTION_KEY,
 * and only `last4` ever comes back out — list/upsert/remove all return the
 * masked shape. Shared by the tenant settings endpoints (caller's own
 * tenantId) and the capiro-admin console (arbitrary tenantId behind the
 * capiro_admin guard); writes run through withTenant(tenantId) so RLS sees a
 * matching GUC either way.
 */
import { BadRequestException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { upgradeTextModel } from '@capiro/shared/ai-model-policy';
import { PrismaService } from '../prisma/prisma.service.js';
import { encryptSecret } from '../common/secret-crypto.js';
import {
  AiCredentialResolverService,
  type AiProvider,
} from '../engagement/ai-credential-resolver.service.js';

export const AI_PROVIDERS: readonly AiProvider[] = ['openai', 'anthropic'];

export interface MaskedAiCredential {
  provider: string;
  last4: string;
  modelOverride: string | null;
  status: string;
  lastValidatedAt: Date | null;
  updatedAt: Date | null;
}

export interface UpsertAiCredentialInput {
  provider: AiProvider;
  apiKey: string;
  modelOverride?: string | null;
  createdByUserId?: string | null;
}

@Injectable()
export class AiCredentialStoreService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly resolver: AiCredentialResolverService,
  ) {}

  async list(tenantId: string): Promise<MaskedAiCredential[]> {
    const rows = await this.prisma.withTenant(tenantId, (tx) =>
      tx.tenantAiCredential.findMany({ where: { tenantId } }),
    );
    return rows.map((row) => masked(row));
  }

  async upsert(tenantId: string, input: UpsertAiCredentialInput): Promise<MaskedAiCredential> {
    if (!AI_PROVIDERS.includes(input.provider)) {
      throw new BadRequestException(`provider must be one of: ${AI_PROVIDERS.join(', ')}`);
    }
    if (!this.resolver.tenantKeysEnabled) {
      throw new ServiceUnavailableException(
        'Tenant AI keys are not enabled on this environment (AI_CREDENTIAL_ENCRYPTION_KEY unset)',
      );
    }

    const modelOverride = input.modelOverride?.trim() ? upgradeTextModel(input.modelOverride) : null;
    const validation = await this.resolver.validateKey(input.provider, input.apiKey, modelOverride);
    if (!validation.ok) {
      throw new BadRequestException(
        `API key validation failed: ${validation.error ?? 'provider rejected the key'}`,
      );
    }

    const envelope = encryptSecret(this.resolver.encryptionKeyBuffer(), input.apiKey);
    const now = new Date();
    const row = await this.prisma.withTenant(tenantId, (tx) =>
      tx.tenantAiCredential.upsert({
        where: { tenantId_provider: { tenantId, provider: input.provider } },
        create: {
          tenantId,
          provider: input.provider,
          keyCiphertext: envelope.ciphertext,
          keyIv: envelope.iv,
          keyAuthTag: envelope.authTag,
          keyLast4: input.apiKey.slice(-4),
          modelOverride,
          status: 'active',
          lastValidatedAt: now,
          createdByUserId: input.createdByUserId ?? null,
        },
        update: {
          keyCiphertext: envelope.ciphertext,
          keyIv: envelope.iv,
          keyAuthTag: envelope.authTag,
          keyLast4: input.apiKey.slice(-4),
          modelOverride,
          status: 'active',
          lastValidatedAt: now,
        },
      }),
    );
    return masked(row);
  }

  async remove(tenantId: string, provider: AiProvider): Promise<{ removed: boolean }> {
    const result = await this.prisma.withTenant(tenantId, (tx) =>
      tx.tenantAiCredential.deleteMany({ where: { tenantId, provider } }),
    );
    return { removed: result.count > 0 };
  }
}

function masked(row: {
  provider: string;
  keyLast4: string;
  modelOverride: string | null;
  status: string;
  lastValidatedAt: Date | null;
  updatedAt?: Date | null;
}): MaskedAiCredential {
  return {
    provider: row.provider,
    last4: row.keyLast4,
    modelOverride: row.modelOverride ? upgradeTextModel(row.modelOverride) : null,
    status: row.status,
    lastValidatedAt: row.lastValidatedAt ?? null,
    updatedAt: row.updatedAt ?? null,
  };
}
