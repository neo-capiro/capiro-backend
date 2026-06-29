/**
 * Per-call AI credential resolution (per-tenant AI keys, phase 2).
 *
 * resolveOrder(ctx) returns the provider attempt order for one generation:
 * for each provider (preferred first), the tenant's own decrypted key when an
 * active TenantAiCredential exists, else the global env key. A tenant key
 * also carries its optional model override and usedTenantKey=true, which the
 * usage recorder persists. Anything that can go wrong on the tenant path
 * (encryption key unset, decrypt failure, DB error) degrades to the global
 * key — a misconfigured BYO key must never break generation.
 *
 * validateKey() is the save-time gate: a minimal real call against the
 * provider so invalid keys are rejected before they're stored.
 */
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { TenantContext } from '@capiro/shared';
import type { AppConfig } from '../config/config.schema.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { decryptSecret, parseAesKey } from '../common/secret-crypto.js';

export type AiProvider = 'openai' | 'anthropic';

export interface ResolvedAiCredential {
  provider: AiProvider;
  apiKey: string;
  model: string;
  usedTenantKey: boolean;
}

const VALIDATE_TIMEOUT_MS = 20_000;

@Injectable()
export class AiCredentialResolverService implements OnModuleInit {
  private readonly logger = new Logger(AiCredentialResolverService.name);
  private readonly encryptionKey?: Buffer;
  private readonly globalOpenaiKey?: string;
  private readonly globalAnthropicKey?: string;
  private readonly preferredProvider?: AiProvider;
  private readonly openaiModel: string;
  private readonly anthropicModel: string;

  constructor(
    config: ConfigService<AppConfig, true>,
    private readonly prisma: PrismaService,
  ) {
    this.globalOpenaiKey = config.get('OPENAI_API_KEY', { infer: true });
    this.globalAnthropicKey = config.get('ANTHROPIC_API_KEY', { infer: true });
    this.preferredProvider = config.get('AI_PROVIDER', { infer: true });
    this.openaiModel = config.get('OPENAI_MODEL', { infer: true });
    this.anthropicModel = config.get('ANTHROPIC_MODEL', { infer: true });
    const rawKey = config.get('AI_CREDENTIAL_ENCRYPTION_KEY', { infer: true });
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

  /** Startup guard (plan task 2.2): stored credentials with no decryption key. */
  async onModuleInit(): Promise<void> {
    if (this.encryptionKey) return;
    try {
      const count = await this.prisma.withSystem((tx) => tx.tenantAiCredential.count());
      if (count > 0) {
        this.logger.error(
          `${count} tenant AI credential(s) exist but AI_CREDENTIAL_ENCRYPTION_KEY is not set — ` +
            'they cannot be decrypted and all generations will use the global keys.',
        );
      }
    } catch {
      // Boot must not depend on this advisory check (e.g. DB not up yet in tests).
    }
  }

  /** True when the BYO-key feature can store/decrypt tenant keys. */
  get tenantKeysEnabled(): boolean {
    return Boolean(this.encryptionKey);
  }

  encryptionKeyBuffer(): Buffer {
    if (!this.encryptionKey) {
      throw new Error('AI_CREDENTIAL_ENCRYPTION_KEY is not configured');
    }
    return this.encryptionKey;
  }

  defaultModelFor(provider: AiProvider): string {
    return provider === 'openai' ? this.openaiModel : this.anthropicModel;
  }

  /**
   * Provider attempt order for one generation. Preferred provider first,
   * then the rest; each entry is the tenant credential when available and
   * decryptable, else the global env key. Providers with neither are absent.
   */
  async resolveOrder(ctx: TenantContext | null | undefined): Promise<ResolvedAiCredential[]> {
    const providers: AiProvider[] = [];
    const add = (p: AiProvider) => {
      if (!providers.includes(p)) providers.push(p);
    };
    if (this.preferredProvider) add(this.preferredProvider);
    add('openai');
    add('anthropic');

    const resolved: ResolvedAiCredential[] = [];
    for (const provider of providers) {
      const cred = await this.resolveForProvider(ctx, provider);
      if (cred) resolved.push(cred);
    }
    return resolved;
  }

  /**
   * Resolve a single provider's credential (tenant key first, then global).
   * Meri uses this to run its Anthropic brain on a tenant's own key + model
   * override when present, falling back to the global key — without changing
   * provider. Returns null only when neither a tenant nor a global key exists.
   */
  async resolveProvider(
    ctx: TenantContext | null | undefined,
    provider: AiProvider,
  ): Promise<ResolvedAiCredential | null> {
    return this.resolveForProvider(ctx, provider);
  }

  /**
   * Resolve a provider credential from a bare tenantId, for non-request
   * contexts (scheduled jobs / workers) that don't carry a full TenantContext.
   * Same tenant-key-first-then-global behavior as resolveProvider.
   */
  async resolveProviderByTenantId(
    tenantId: string,
    provider: AiProvider,
  ): Promise<ResolvedAiCredential | null> {
    return this.resolveForProvider({ tenantId }, provider);
  }

  private async resolveForProvider(
    ctx: { tenantId: string } | null | undefined,
    provider: AiProvider,
  ): Promise<ResolvedAiCredential | null> {
    if (ctx && this.encryptionKey) {
      try {
        const row = await this.prisma.withTenant(ctx.tenantId, (tx) =>
          tx.tenantAiCredential.findFirst({
            where: { tenantId: ctx.tenantId, provider, status: 'active' },
          }),
        );
        if (row) {
          const apiKey = decryptSecret(this.encryptionKey, {
            ciphertext: row.keyCiphertext,
            iv: row.keyIv,
            authTag: row.keyAuthTag,
          });
          return {
            provider,
            apiKey,
            model: row.modelOverride ?? this.defaultModelFor(provider),
            usedTenantKey: true,
          };
        }
      } catch (err) {
        this.logger.warn(
          `Tenant AI credential resolve failed for ${provider} (falling back to global key): ${
            (err as Error).message
          }`,
        );
      }
    }

    const globalKey = provider === 'openai' ? this.globalOpenaiKey : this.globalAnthropicKey;
    if (globalKey) {
      return {
        provider,
        apiKey: globalKey,
        model: this.defaultModelFor(provider),
        usedTenantKey: false,
      };
    }
    return null;
  }

  /**
   * Save-time validation (plan task 2.4): a minimal real generation against
   * the provider, so a bad key (or a model the key can't access) is rejected
   * with the provider's own error before anything is stored.
   */
  async validateKey(
    provider: AiProvider,
    apiKey: string,
    model?: string | null,
  ): Promise<{ ok: boolean; error?: string }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), VALIDATE_TIMEOUT_MS);
    try {
      const response =
        provider === 'openai'
          ? await fetch('https://api.openai.com/v1/responses', {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({
                model: model || this.openaiModel,
                input: 'ping',
                // Responses API minimum; the cheapest call that proves the
                // key can actually generate (auth + billing + model access).
                max_output_tokens: 16,
              }),
              signal: controller.signal,
            })
          : await fetch('https://api.anthropic.com/v1/messages', {
              method: 'POST',
              headers: {
                'x-api-key': apiKey,
                'anthropic-version': '2023-06-01',
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({
                model: model || this.anthropicModel,
                max_tokens: 1,
                messages: [{ role: 'user', content: 'ping' }],
              }),
              signal: controller.signal,
            });
      if (response.ok) return { ok: true };
      const body = (await response.json().catch(() => ({}))) as {
        error?: { message?: string };
        message?: string;
      };
      return {
        ok: false,
        error: body.error?.message ?? body.message ?? `HTTP ${response.status}`,
      };
    } catch (err) {
      const message =
        (err as Error).name === 'AbortError'
          ? `validation request timed out after ${VALIDATE_TIMEOUT_MS / 1000}s`
          : (err as Error).message;
      return { ok: false, error: message };
    } finally {
      clearTimeout(timer);
    }
  }
}
