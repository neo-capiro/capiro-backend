/**
 * Provider-neutral, per-call AI credential resolution.
 *
 * This service intentionally lives outside Engagement so Meri, Engagement,
 * and Outreach V3 can share one tenant-first credential policy without
 * importing the broad Engagement module.
 */
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { TenantContext } from '@capiro/shared';
import type { AppConfig } from '../config/config.schema.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { decryptSecret, parseAesKey } from '../common/secret-crypto.js';
import { EngagementRuntimePolicyService } from '../engagement/runtime/engagement-runtime-policy.service.js';

export type AiProvider = 'openai' | 'anthropic';

export interface ResolvedAiCredential {
  provider: AiProvider;
  apiKey: string;
  model: string;
  usedTenantKey: boolean;
  modelOverridden: boolean;
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
    private readonly runtimePolicy?: EngagementRuntimePolicyService,
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

  /** Startup advisory. It is background-owned and never runs in shadow mode. */
  async onModuleInit(): Promise<void> {
    if (this.runtimePolicy && !this.runtimePolicy.backgroundWorkersEnabled()) {
      const snapshot = this.runtimePolicy.snapshot();
      this.logger.log(
        `AI credential advisory disabled by engagement runtime policy ` +
          `(service=${snapshot.serviceName} owner=${snapshot.backgroundOwner} mode=${snapshot.processMode})`,
      );
      return;
    }
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
      // Boot must not depend on this advisory check.
    }
  }

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

  async resolveOrder(ctx: TenantContext | null | undefined): Promise<ResolvedAiCredential[]> {
    this.assertCredentialAccess();
    const providers: AiProvider[] = [];
    const add = (provider: AiProvider) => {
      if (!providers.includes(provider)) providers.push(provider);
    };
    if (this.preferredProvider) add(this.preferredProvider);
    add('openai');
    add('anthropic');

    const resolved: ResolvedAiCredential[] = [];
    for (const provider of providers) {
      const credential = await this.resolveForProvider(ctx, provider);
      if (credential) resolved.push(credential);
    }
    return resolved;
  }

  async resolveProvider(
    ctx: TenantContext | null | undefined,
    provider: AiProvider,
  ): Promise<ResolvedAiCredential | null> {
    this.assertCredentialAccess();
    return this.resolveForProvider(ctx, provider);
  }

  /**
   * Outreach V3 Phase 3 gets one narrow shadow-runtime exception. This does not
   * enable generation/send/OAuth/etc.; the runtime policy independently checks
   * only the `outreach_reasoning` action before tenant/global credential lookup.
   */
  async resolveProviderForOutreachReasoning(
    ctx: TenantContext,
    provider: AiProvider,
  ): Promise<ResolvedAiCredential | null> {
    this.runtimePolicy?.assertExternalAction('outreach_reasoning');
    return this.resolveForProvider(ctx, provider);
  }

  async resolveProviderByTenantId(
    tenantId: string,
    provider: AiProvider,
  ): Promise<ResolvedAiCredential | null> {
    this.assertCredentialAccess();
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
            modelOverridden: row.modelOverride != null,
          };
        }
      } catch (err) {
        this.logger.warn(
          `Tenant AI credential resolve failed for ${provider}; falling back to the platform key`,
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
        modelOverridden: false,
      };
    }
    return null;
  }

  async validateKey(
    provider: AiProvider,
    apiKey: string,
    model?: string | null,
  ): Promise<{ ok: boolean; error?: string }> {
    this.assertCredentialAccess();
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
      return { ok: false, error: `Provider rejected the credential (HTTP ${response.status})` };
    } catch (err) {
      const message =
        (err as Error).name === 'AbortError'
          ? `validation request timed out after ${VALIDATE_TIMEOUT_MS / 1000}s`
          : 'Provider credential validation was unavailable';
      return { ok: false, error: message };
    } finally {
      clearTimeout(timer);
    }
  }

  private assertCredentialAccess(): void {
    this.runtimePolicy?.assertExternalAction('internal_ai_credential_resolve');
  }
}
