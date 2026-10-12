import { OPENAI_TEXT_MODEL, upgradeTextModel } from '@capiro/shared/ai-model-policy';
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
  private readonly globalOpenai?: string;
  private readonly newsletterImageModel: string;
  private readonly newsletterAltTextModel: string;

  constructor(
    config: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    this.globalAnthropic = config.get<string>('ANTHROPIC_API_KEY');
    this.globalOpenai = config.get<string>('OPENAI_API_KEY');
    this.newsletterImageModel = config.get<string>('NEWSLETTER_IMAGE_MODEL') || 'gpt-image-2.5-sunburst';
    this.newsletterAltTextModel = upgradeTextModel(
      config.get<string>('NEWSLETTER_ALT_TEXT_MODEL') || OPENAI_TEXT_MODEL,
    );
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

  async resolveNewsletterImage(tenantId: string): Promise<ResolvedAiCredential | null> {
    const tenantCred = await this.tryNewsletterTenantCredential(tenantId);
    if (tenantCred) return tenantCred;
    return this.globalOpenai
      ? {
          provider: 'openai',
          secret: this.globalOpenai,
          model: this.newsletterImageModel,
          usedTenantKey: false,
        }
      : null;
  }

  async resolveNewsletterAltText(tenantId: string): Promise<ResolvedAiCredential | null> {
    const credential = await this.resolveNewsletterImage(tenantId);
    return credential ? { ...credential, model: this.newsletterAltTextModel } : null;
  }

  private async tryNewsletterTenantCredential(tenantId: string): Promise<ResolvedAiCredential | null> {
    const provider: AiProvider = 'openai';
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
          AND provider = ${provider}
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
        provider,
        secret: decrypted,
        model:
          provider === 'openai'
            ? this.newsletterImageModel
            : upgradeTextModel(row.model_override ?? this.workspaceModel),
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
