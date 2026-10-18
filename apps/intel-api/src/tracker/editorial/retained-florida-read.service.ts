import {
  ConflictException,
  HttpException,
  Inject,
  Injectable,
  RequestTimeoutException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import type {
  CoreRetainedPrincipalCanonicalizer,
  CoreRetainedPrincipalCryptographicVerifier,
} from '@capiro/shared/core-retained-principal';
import {
  parseCoreRetainedAuthorityProbeBody,
  type CoreRetainedAuthorityProbeCryptographicVerifier,
} from '@capiro/shared/core-retained-authority-probe';
import { parseRetainedReadBody } from '@capiro/shared/core-retained-read-request';
import type { createIntelCoreAuthorityClient } from '@capiro/shared/core-retained-authority-http';
import { Phase8EvidenceService } from './evidence.service.js';
import {
  FloridaCurrentAuthorityService,
  type FloridaCurrentAuthorityControl,
  type FloridaCurrentAuthorityFacts,
} from './florida-current-authority.service.js';

export const RETAINED_FLORIDA_PORTS = Symbol('retained-florida-ports');
export interface RetainedFloridaPorts {
  canonicalize: CoreRetainedPrincipalCanonicalizer;
  probeVerifier: CoreRetainedAuthorityProbeCryptographicVerifier;
  dataVerifier: CoreRetainedPrincipalCryptographicVerifier;
  current: ReturnType<typeof createIntelCoreAuthorityClient>;
}
const unavailable = () =>
  new ServiceUnavailableException('Retained Florida authority unavailable');
const changed = () =>
  new ConflictException('Retained Florida authority changed; reload');

/** Fixed read-only source. No user bearer, service-secret or agent-loop fallback. */
@Injectable()
export class RetainedFloridaReadService {
  constructor(
    private readonly facts: FloridaCurrentAuthorityService,
    private readonly evidence: Phase8EvidenceService,
    @Inject(RETAINED_FLORIDA_PORTS)
    private readonly ports: RetainedFloridaPorts | null,
  ) {}

  async authority(
    authorization: unknown,
    body: unknown,
    control: FloridaCurrentAuthorityControl,
  ) {
    control.assertActive();
    const ports = this.configured();
    const parsed = this.port(() => parseCoreRetainedAuthorityProbeBody(body));
    const envelope = this.port(() =>
      ports.probeVerifier.verifyCryptographically(authorization, {
        nowMs: Date.now(),
        deadlineMs: control.deadlineMs,
        selector: parsed.selector,
      }),
    );
    control = this.bounded(control, envelope.originalExpiresAtMs);
    control.assertActive();
    const first = await this.read(control, () =>
      ports.current.verifyProbeCurrent(authorization, parsed.selector, control),
    );
    this.correlate(first, envelope, ports);
    const facts = await this.read(control, () =>
      this.facts.read(envelope.principal, parsed.selector, control),
    );
    const last = await this.read(control, () =>
      ports.current.verifyProbeCurrent(authorization, parsed.selector, control),
    );
    this.correlate(last, envelope, ports);
    control.assertActive();
    return {
      schemaVersion: 1,
      principal: envelope.principal,
      identityRevision: envelope.identityRevision,
      resourceRevision: facts.resourceRevision,
      effectiveScope: facts.effectiveScope,
      clientResolution: facts.clientResolution,
      checkedAtMs: Date.now(),
      originalExpiresAtMs: Math.min(
        envelope.originalExpiresAtMs,
        first.originalExpiresAtMs,
        last.originalExpiresAtMs,
      ),
    };
  }

  async budget(
    authorization: unknown,
    body: unknown,
    control: FloridaCurrentAuthorityControl,
  ) {
    control.assertActive();
    const ports = this.configured();
    const parsed = this.port(() =>
      parseRetainedReadBody(
        'get_florida_budget_project',
        body,
        { issuer: false },
        ports.canonicalize,
      ),
    );
    const envelope = this.port(() =>
      ports.dataVerifier.verifyCryptographically(authorization, {
        nowMs: Date.now(),
        deadlineMs: control.deadlineMs,
        expectedDigests: parsed.digests,
      }),
    );
    if (
      envelope.operation !== 'get_florida_budget_project' ||
      envelope.recipientPath !==
        '/intel-api/internal/legiwatch/retained-florida-budget'
    ) {
      throw new UnauthorizedException('Invalid retained Florida recipient');
    }
    control = this.bounded(control, envelope.originalExpiresAtMs);
    control.assertActive();
    const first = await this.read(control, () =>
      ports.current.verifyFloridaDataCurrent(
        authorization,
        parsed.request,
        parsed.context,
        control,
      ),
    );
    this.correlate(first, envelope, ports);
    if (first.resourceRevision !== envelope.resourceRevision) throw changed();
    const before = await this.read(control, () =>
      this.facts.read(envelope.principal, parsed.selector, control),
    );
    this.correlateFacts(
      before,
      parsed.context,
      envelope.resourceRevision,
      ports,
    );
    // Null supplies no administrative bypass. Current membership and client walls
    // are independently checked by the canonical business owner and current facts.
    const result = await this.read(control, () =>
      this.evidence.budget(
        {
          tenantId: envelope.principal.tenantId,
          clerkUserId: envelope.principal.clerkUserId,
          role: null,
        },
        parsed.normalizedArgs,
      ),
    );
    const after = await this.read(control, () =>
      this.facts.read(envelope.principal, parsed.selector, control),
    );
    this.correlateFacts(
      after,
      parsed.context,
      envelope.resourceRevision,
      ports,
    );
    const last = await this.read(control, () =>
      ports.current.verifyFloridaDataCurrent(
        authorization,
        parsed.request,
        parsed.context,
        control,
      ),
    );
    this.correlate(last, envelope, ports);
    if (last.resourceRevision !== envelope.resourceRevision) throw changed();
    control.assertActive();
    return result;
  }

  private configured(): RetainedFloridaPorts {
    if (
      !this.ports ||
      typeof this.ports.canonicalize !== 'function' ||
      typeof this.ports.probeVerifier?.verifyCryptographically !== 'function' ||
      typeof this.ports.dataVerifier?.verifyCryptographically !== 'function' ||
      typeof this.ports.current?.verifyProbeCurrent !== 'function' ||
      typeof this.ports.current?.verifyFloridaDataCurrent !== 'function'
    )
      throw unavailable();
    return this.ports;
  }

  private bounded(
    caller: FloridaCurrentAuthorityControl,
    cutoff: number,
  ): FloridaCurrentAuthorityControl {
    const deadlineMs = Math.min(caller.deadlineMs, cutoff);
    const control = {
      deadlineMs,
      assertActive() {
        caller.assertActive();
        if (!Number.isSafeInteger(deadlineMs) || Date.now() >= deadlineMs)
          throw new RequestTimeoutException(
            'Retained Florida request no longer active',
          );
      },
    };
    control.assertActive();
    return control;
  }

  private correlate(
    receipt: {
      principal: unknown;
      identityRevision: string;
      originalExpiresAtMs: number;
    },
    envelope: {
      principal: unknown;
      identityRevision: string;
      originalExpiresAtMs: number;
    },
    ports: RetainedFloridaPorts,
  ) {
    if (
      ports.canonicalize(receipt.principal) !==
        ports.canonicalize(envelope.principal) ||
      receipt.identityRevision !== envelope.identityRevision ||
      receipt.originalExpiresAtMs > envelope.originalExpiresAtMs ||
      receipt.originalExpiresAtMs <= Date.now()
    )
      throw changed();
  }

  private correlateFacts(
    facts: FloridaCurrentAuthorityFacts,
    context: Readonly<Record<string, unknown>>,
    revision: string,
    ports: RetainedFloridaPorts,
  ) {
    if (
      facts.resourceRevision !== revision ||
      ports.canonicalize(facts.effectiveScope) !==
        ports.canonicalize(context.effectiveScope) ||
      ports.canonicalize(facts.clientResolution) !==
        ports.canonicalize(context.clientResolution)
    )
      throw changed();
  }

  private port<T>(read: () => T): T {
    try {
      return read();
    } catch (error) {
      if (error instanceof HttpException) throw error;
      if (
        error &&
        typeof error === 'object' &&
        'status' in error &&
        typeof error.status === 'number' &&
        [400, 401, 403, 404, 408, 409, 503].includes(error.status)
      ) {
        throw new HttpException(
          'Retained Florida authority unavailable',
          error.status,
        );
      }
      throw unavailable();
    }
  }

  private async read<T>(
    control: FloridaCurrentAuthorityControl,
    source: () => Promise<T>,
  ): Promise<T> {
    control.assertActive();
    try {
      const result = await source();
      control.assertActive();
      return result;
    } catch (error) {
      control.assertActive();
      return this.port(() => {
        throw error;
      });
    }
  }
}
