/**
 * Request-a-meeting auto-context, hoisted to the builder shell.
 *
 * This used to live inside `outreach-step-context.tsx` as a render effect, which
 * meant a request-a-meeting campaign only picked up its sponsor overview,
 * capabilities, facilities and target career-background context if the user
 * actually OPENED the Context step. A user who rode the default rail straight
 * from Targets to Review generated drafts with no capability evidence in the
 * packet — and since `about_client` and `why_it_matters` are honest slots, the
 * drafts came out content-free rather than wrong. The fix is placement, not
 * logic: the SAME effect now runs while ANY builder step is mounted, so the
 * context exists by the time the user reaches Review regardless of the path
 * they took.
 *
 * Everything below is the moved logic, unchanged in behaviour:
 *
 *  1. **The sources are the campaign's own.** Each piece is its own
 *     `capiro_record` / `target_profile_fact` selection accepted through the
 *     normal command — never a bundled blob, never a manual marker — so the
 *     Context step's cards keep rendering them and the user can exclude any
 *     single wrong capability without losing the rest.
 *  2. **Idempotent by content.** Each of the four pieces is checked
 *     independently against the refs already on the spec; only missing ones are
 *     sent, and the server dedupes by contextKey anyway.
 *  3. **Retry-once against a failing server.** The `lastAttemptedKeys`
 *     signature ref remembers exactly what the last batch tried, so a deploy
 *     mismatch that rejects every batch cannot re-arm the effect on every
 *     render (the 1,000-identical-batches incident this guard was built for).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { CapabilityRecord } from '../../../pages/clients/client-profile-crm-model.js';
import type { ClientFacility } from '../../../pages/clients/facilities-api.js';
import { useApi } from '../../../lib/use-api.js';
import { acceptContextCommand } from '../../../pages/engagement/outreach/v3/commands.js';
import type {
  OutreachV3Command,
  OutreachV3ContextSelection,
  OutreachV3ResolvedContextRef,
  OutreachV3ResolvedTargetRef,
  OutreachV3SessionEnvelope,
} from '../../../pages/engagement/outreach/v3/contracts.js';
import {
  outreachCampaignTypeFromSpec,
  outreachSelectedTargets,
} from './outreach-builder-model.js';
import {
  clientCapabilityContextSelection,
  clientFacilityContextSelection,
  clientRecordContextSelection,
  outreachTargetHasCareerBackgroundSource,
  targetCareerBackgroundContextSelection,
} from './outreach-v3-guided-workflow.js';

export function soleSponsorClientId(session: OutreachV3SessionEnvelope | null): string | null {
  const sponsor = session?.spec.sponsor;
  if (!sponsor || sponsor.kind !== 'client' || sponsor.clientRefs.length !== 1) return null;
  return sponsor.clientRefs[0]?.clientId ?? null;
}

export function acceptedContextRefs(
  context: OutreachV3SessionEnvelope['spec']['context'] | undefined,
): OutreachV3ResolvedContextRef[] {
  if (!context) return [];
  return [
    ...context.requiredPolicyRefs,
    ...context.writingGuidanceRefs,
    ...context.campaignFactRefs,
    ...context.targetSpecificRefs,
    ...context.groupSafeRefs,
  ];
}

export function contextRefLocatorId(locator: Record<string, unknown>): string {
  const value = locator['id'] ?? locator['memoryItemId'] ?? locator['documentId'];
  return typeof value === 'string' ? value : '';
}

/**
 * Run the auto-attach while any builder step is mounted.
 *
 * `applyCommands` is the shell's shared command writer; a failure here is
 * silent by design (the Context step surfaces server errors on its own cards,
 * and this hook has no UI of its own to speak from).
 */
export function useOutreachMeetingAutoContext(input: {
  session: OutreachV3SessionEnvelope | null;
  /**
   * `Promise<unknown>` (not `void`): this is the shell's shared command
   * writer, whose builder-wide contract (`OutreachBuilderStepCommon`) returns
   * the command batch result. The hook ignores the resolution value.
   */
  applyCommands: (commands: OutreachV3Command[]) => Promise<unknown>;
}): void {
  const { session, applyCommands } = input;
  const api = useApi();

  const clientId = soleSponsorClientId(session);
  const campaignType = useMemo(
    () => outreachCampaignTypeFromSpec(session),
    [session],
  );
  const isRequestMeeting = campaignType === 'request_meeting';

  // Same query keys the Context step used, so anything the shell or the step
  // has already fetched is reused, not re-fetched.
  const capabilitiesQuery = useQuery({
    queryKey: ['client-capabilities', clientId],
    enabled: isRequestMeeting && Boolean(clientId),
    queryFn: async () =>
      (await api.get<CapabilityRecord[]>(`/api/clients/${clientId}/capabilities`)).data,
    staleTime: 60_000,
    retry: false,
  });
  const facilitiesQuery = useQuery({
    queryKey: ['client-facilities', clientId],
    enabled: isRequestMeeting && Boolean(clientId),
    queryFn: async () =>
      (await api.get<ClientFacility[]>(`/api/clients/${clientId}/facilities`)).data,
    staleTime: 60_000,
    retry: false,
  });

  const accepted = useMemo(
    () => acceptedContextRefs(session?.spec.context),
    [session],
  );
  const targets = useMemo(() => outreachSelectedTargets(session), [session]);

  const hasCapiroRecordRef = (recordId: string) =>
    accepted.some(
      (ref) =>
        (ref.locator as Record<string, unknown>)['source'] === 'capiro_record' &&
        contextRefLocatorId(ref.locator as Record<string, unknown>) === recordId,
    );
  const hasCareerBackgroundRef = (target: OutreachV3ResolvedTargetRef) =>
    accepted.some(
      (ref) =>
        ref.scope.kind === 'target' &&
        ref.scope.targetKey === target.targetKey &&
        (ref.locator as Record<string, unknown>)['factCode'] === 'career_background',
    );

  const [pending, setPending] = useState<string | null>(null);
  const runCommands = useCallback(
    async (key: string, commands: OutreachV3Command[]): Promise<void> => {
      setPending(key);
      try {
        await applyCommands(commands);
      } catch {
        // The Context step's own cards are the error surface for context
        // writes; this hook adds no UI of its own. A failed batch is retried
        // only when the attempted SET changes (the signature guard below) —
        // a persistently failing batch degrades to "context not attached",
        // never to a request storm.
      } finally {
        setPending(null);
      }
    },
    [applyCommands],
  );

  /**
   * Observed live: a deploy mismatch left the server rejecting this batch
   * every time. `accepted` never changed (nothing landed), so the retry
   * condition below stayed true on every render, and `pending` cycling back
   * to `null` after each failed attempt re-armed the effect immediately —
   * over 1,000 identical batches hit the API in seconds. The server's
   * content-addressed dedup made each individual accept idempotent, but
   * nothing stopped the CLIENT from hammering a request that was failing.
   *
   * This remembers the exact set of context keys the last attempt sent. A
   * later render only retries when that SET has actually changed (a query
   * resolved, a target got added) — never merely because `pending` cycled.
   * A genuinely new piece still gets tried once; a piece that keeps failing
   * does not turn into a client-side denial-of-service against the API.
   */
  const lastAttemptedKeys = useRef<string | null>(null);

  useEffect(() => {
    if (!isRequestMeeting || !clientId || pending !== null) return;
    // Each of the four pieces is checked independently — a slow/failed
    // capabilities or facilities fetch never blocks the other pieces from
    // attaching, and each is its own `capiro_record`/`target_profile_fact`
    // Source once accepted, never a `manual` marker the user can't see.
    const missing: OutreachV3ContextSelection[] = [];
    if (!hasCapiroRecordRef(clientId)) missing.push(clientRecordContextSelection(clientId));
    for (const capability of capabilitiesQuery.data ?? []) {
      if (!hasCapiroRecordRef(capability.id)) {
        missing.push(clientCapabilityContextSelection(clientId, capability.id));
      }
    }
    for (const facility of facilitiesQuery.data ?? []) {
      if (!hasCapiroRecordRef(facility.id)) {
        missing.push(clientFacilityContextSelection(clientId, facility.id));
      }
    }
    for (const target of targets) {
      if (outreachTargetHasCareerBackgroundSource(target) && !hasCareerBackgroundRef(target)) {
        missing.push(targetCareerBackgroundContextSelection(target));
      }
    }
    if (missing.length === 0) return;
    const signature = missing
      .map((selection) => JSON.stringify(selection.locator))
      .sort()
      .join('|');
    if (signature === lastAttemptedKeys.current) return;
    lastAttemptedKeys.current = signature;
    void runCommands('auto-request-meeting-context', [acceptContextCommand(missing)]);
    // `accepted` already reflects every locator currently on the spec, so it
    // (not `session` directly) is what tells this effect whether a prior
    // batch landed — applyCommands invalidates the session query on success,
    // which is what refreshes it.
  }, [
    isRequestMeeting,
    clientId,
    accepted,
    capabilitiesQuery.data,
    facilitiesQuery.data,
    targets,
    pending,
    runCommands,
  ]);
}
