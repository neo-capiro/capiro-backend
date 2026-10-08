import type { PlannerViewPreferencesData } from '@capiro/strategy-verifier';
import { useRef, useState } from 'react';
import {
  plannerError,
  usePlannerKey,
  usePlannerMutations,
  usePlannerResources,
} from './planner-api.js';

export type PlannerLayoutControls = {
  data: PlannerViewPreferencesData;
  disabled: boolean;
  save: (
    patch: Partial<
      Pick<PlannerViewPreferencesData, 'expandedTaskIds' | 'collapsedGroupIds' | 'hideUnscheduled'>
    >,
  ) => void;
};

export function usePlannerViewPreferences(
  scope: 'mine' | 'project',
  projectId: string | null,
  view: PlannerViewPreferencesData['view'],
) {
  const resources = usePlannerResources(),
    actions = usePlannerMutations();
  const scopeKey = JSON.stringify([...usePlannerKey(), scope, projectId, view]);
  const currentScope = useRef(scopeKey);
  currentScope.current = scopeKey;
  const inFlight = useRef<{ scope: string } | null>(null);
  const [savingScope, setSavingScope] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<{ scope: string; error: unknown } | null>(null);
  const row = resources.data?.find(
    (r) =>
      r.kind === 'view_preferences' &&
      !r.archived &&
      r.data.scope === scope &&
      r.data.projectId === projectId &&
      r.data.view === view,
  );
  const data: PlannerViewPreferencesData = {
    scope,
    projectId,
    view,
    expandedTaskIds: [],
    collapsedGroupIds: [],
    hideUnscheduled: false,
    ...(row?.data as unknown as PlannerViewPreferencesData | undefined),
  };
  const disabled = resources.isPending || resources.isError || savingScope === scopeKey;
  const request = (input: Parameters<typeof actions.resource.mutateAsync>[0]) => {
    if (disabled || inFlight.current?.scope === scopeKey) return;
    const token = { scope: scopeKey };
    inFlight.current = token;
    setSavingScope(scopeKey);
    setSaveError(null);
    void actions.resource
      .mutateAsync(input)
      .catch((error) => {
        if (inFlight.current === token && currentScope.current === scopeKey)
          setSaveError({ scope: scopeKey, error });
      })
      .finally(() => {
        if (inFlight.current === token) {
          inFlight.current = null;
          setSavingScope(null);
        }
      });
  };
  const controls: PlannerLayoutControls = {
    data,
    disabled,
    save: (patch) =>
      request({
        id: row?.id,
        version: row?.version,
        kind: 'view_preferences',
        name: 'Personal view layout',
        data: { ...data, ...patch },
      }),
  };
  return {
    controls,
    reset: row ? () => request({ id: row.id, version: row.version, archived: true }) : undefined,
    error: resources.error ?? (saveError?.scope === scopeKey ? saveError.error : null),
    pending: savingScope === scopeKey,
  };
}

export function PlannerLayoutStatus({
  error,
  pending,
  onReset,
  disabled,
}: {
  error: unknown;
  pending: boolean;
  onReset?: () => void;
  disabled?: boolean;
}) {
  return (
    <>
      {onReset && (
        <button type="button" disabled={disabled || pending} onClick={onReset}>
          Reset personal layout
        </button>
      )}
      {pending && (
        <p role="status" className="planner-muted">
          Saving view layout…
        </p>
      )}
      {error && (
        <p role="alert" className="planner-error">
          View layout was not saved. {plannerError(error)}
        </p>
      )}
    </>
  );
}
