import { upgradeTextModel } from '@capiro/shared/ai-model-policy';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service.js';
import { decryptSecret, parseAesKey } from '../common/secret-crypto.js';

export type AiProvider = 'anthropic' | 'openai';

export interface ResolvedAiCredential {
  provider: AiProvider;
  secret: string;
  model: string;
  usedTenantKey: boolean;
}

/**
 * Tenant-scoped AI credential resolution for the workspace engine (Phase 6).
 *
 * Mirrors apps/api's AiCredentialResolverService, but the engine does NOT own
 * the tenant_ai_credentials table, so it reads it via a parameterized raw query
 * on the shared DB (read-only). For a generation it returns the tenant's own
 * decrypted Anthropic key + model override when an active row exists, else the
 * global key with the WORKSPACE_MODEL default (Sonnet).
 *
 * Any failure on the tenant path (no encryption key, decrypt error, DB error)
 * degrades to the global key — a misconfigured BYO key must never break Meri.
 *
 * Provider is fixed to Anthropic: the product runtime model for white-paper /
 * document generation is Claude Sonnet (per the build directive).
 *
 * The resolved `secret` field holds the provider API key (named generically to
 * keep it out of logs/serializers).
 */
@Injectable()
export class AiCredentialService {
  private readonly logger = new Logger(AiCredentialService.name);
  private readonly encryptionKey?: Buffer;
  private readonly globalAnthropic?: string;
  private readonly workspaceModel: string;

  constructor(
    config: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    this.globalAnthropic = config.get<string>('ANTHROPIC_API_KEY');
    // Sonnet is the document-generation runtime model (build directive).
    this.workspaceModel = upgradeTextModel(
      config.get<string>('WORKSPACE_MODEL') ?? 'claude-sonnet-5',
    );
    const rawKey = config.get<string>('AI_CREDENTIAL_ENCRYPTION_KEY');
    if (rawKey) {
      try {
        this.encryptionKey = parseAesKey(rawKey);
      } catch (err) {
        this.logger.error(
          `AI_CREDENTIAL_ENCRYPTION_KEY is set but invalid (${(err as Error).message}); ` +
            'tenant AI keys are DISABLED until it is fixed.',
        );
      }
    }
  }

  get tenantKeysEnabled(): boolean {
    return Boolean(this.encryptionKey);
  }

  defaultModel(): string {
    return this.workspaceModel;
  }

  /**
   * Resolve the Anthropic credential for a generation: tenant BYO key (+ model
   * override) when present & decryptable, else the global key + Sonnet default.
   * Returns null only when neither a tenant nor a global key exists.
   */
  async resolveAnthropic(tenantId: string): Promise<ResolvedAiCredential | null> {
    const tenantCred = await this.tryTenantCredential(tenantId);
    if (tenantCred) return tenantCred;

    const globalSecret = this.globalAnthropic;
    if (globalSecret) {
      return {
        provider: 'anthropic',
        secret: globalSecret,
        model: this.workspaceModel,
        usedTenantKey: false,
      };
    }
    return null;
  }

  private async tryTenantCredential(tenantId: string): Promise<ResolvedAiCredential | null> {
    if (!this.encryptionKey) return null;
    try {
      const rows = await this.prisma.$queryRaw<
        {
          key_ciphertext: string;
          key_iv: string;
          key_auth_tag: string;
          model_override: string | null;
        }[]
      >`
        SELECT key_ciphertext, key_iv, key_auth_tag, model_override
        FROM tenant_ai_credentials
        WHERE tenant_id = ${tenantId}::uuid
          AND provider = 'anthropic'
          AND status = 'active'
        LIMIT 1
      `;
      const row = rows[0];
      if (!row) return null;
      const decrypted = decryptSecret(this.encryptionKey, {
        ciphertext: row.key_ciphertext,
        iv: row.key_iv,
        authTag: row.key_auth_tag,
      });
      return {
        provider: 'anthropic',
        secret: decrypted,
        model: upgradeTextModel(row.model_override ?? this.workspaceModel),
        usedTenantKey: true,
      };
    } catch (err) {
      this.logger.warn(
        `Tenant AI credential resolve failed (falling back to global key): ${(err as Error).message}`,
      );
      return null;
    }
  }
}
