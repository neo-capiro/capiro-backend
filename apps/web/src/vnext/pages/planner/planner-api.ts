import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@clerk/clerk-react';
import type {
  PlannerBootstrap,
  PlannerProject,
  PlannerProjectData,
  PlannerTask,
  PlannerTaskData,
  PlannerTaskPage,
  PlannerEvent,
  PlannerInboxItem,
  PlannerActivityPage,
  PlannerResource,
  PlannerResourceKind,
  PlannerAttachment,
  PlannerFormQuestion,
  PlannerGoalData,
  PlannerGoalUpdateSection,
  PlannerGoalReminder,
} from '@capiro/strategy-verifier';
import { plannerFormSubmissionBody, type PlannerFormFiles } from './planner-form-questions.js';
import { useApi } from '../../../lib/use-api.js';
import { useImpersonation } from '../../../state/impersonation.js';

export function usePlannerKey() {
  const { orgId, userId } = useAuth();
  const { actAsTenantSlug } = useImpersonation();
  return ['planner', orgId, userId, actAsTenantSlug] as const;
}
const BASE = '/strategy-api/planner';
export function usePlannerBootstrap() {
  const api = useApi();
  const key = usePlannerKey();
  return useQuery({
    queryKey: [...key, 'bootstrap'],
    queryFn: async () => (await api.get<PlannerBootstrap>(`${BASE}/bootstrap`)).data,
    refetchInterval: 30_000,
  });
}
export function usePlannerQueue() {
  const api = useApi();
  const key = usePlannerKey();
  return useQuery({
    queryKey: [...key, 'queue'],
    queryFn: async () => (await api.get<PlannerTask[]>(`${BASE}/queue`)).data,
    refetchInterval: 30_000,
  });
}
export function usePlannerTasks(
  filters: {
    projectId?: string;
    mine?: string;
    archived?: string;
    parentId?: string;
    search?: string;
  } = {},
  enabled = true,
) {
  const api = useApi();
  const key = usePlannerKey();
  return useInfiniteQuery({
    queryKey: [...key, 'tasks', filters],
    enabled,
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam }) =>
      (
        await api.get<PlannerTaskPage>(`${BASE}/tasks`, {
          params: { ...filters, ...(pageParam ? { cursor: pageParam } : {}) },
        })
      ).data,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    refetchInterval: 30_000,
  });
}
export function usePlannerTask(id: string | null) {
  const api = useApi();
  const key = usePlannerKey();
  return useQuery({
    queryKey: [...key, 'task', id],
    enabled: Boolean(id),
    queryFn: async () => (await api.get<PlannerTask>(`${BASE}/tasks/${id}`)).data,
  });
}
export function usePlannerEvents(taskId?: string, projectId?: string, resourceId?: string) {
  const api = useApi();
  const key = usePlannerKey();
  const path = resourceId
    ? `goals/${resourceId}`
    : taskId
      ? `tasks/${taskId}`
      : `projects/${projectId}`;
  return useInfiniteQuery({
    queryKey: [...key, 'events', path],
    enabled: Boolean(taskId || projectId || resourceId),
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam }) =>
      (
        await api.get<PlannerActivityPage<PlannerEvent>>(`${BASE}/${path}/events`, {
          params: { paged: 'true', ...(pageParam ? { cursor: pageParam } : {}) },
        })
      ).data,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    refetchInterval: 15_000,
  });
}
export function usePlannerInbox(archived = false) {
  const api = useApi();
  const key = usePlannerKey();
  return useInfiniteQuery({
    queryKey: [...key, 'inbox', archived],
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam }) =>
      (
        await api.get<PlannerActivityPage<PlannerInboxItem>>(`${BASE}/inbox`, {
          params: {
            paged: 'true',
            archived: String(archived),
            ...(pageParam ? { cursor: pageParam } : {}),
          },
        })
      ).data,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    refetchInterval: 20_000,
  });
}
export function usePlannerResources() {
  const api = useApi();
  const key = usePlannerKey();
  return useQuery({
    queryKey: [...key, 'resources'],
    queryFn: async () => (await api.get<PlannerResource[]>(`${BASE}/resources`)).data,
    refetchInterval: 30_000,
  });
}
export function usePlannerAttachments(taskId: string) {
  const api = useApi();
  const client = useQueryClient();
  const key = usePlannerKey();
  const path = `${BASE}/tasks/${taskId}/attachments`;
  const onSuccess = () => client.invalidateQueries({ queryKey: key });
  const query = useQuery({
    queryKey: [...key, 'attachments', taskId],
    queryFn: async () => (await api.get<PlannerAttachment[]>(path)).data,
    refetchInterval: 30_000,
  });
  const upload = useMutation({
    mutationFn: async (file: File) => {
      const body = new FormData();
      body.append('file', file);
      return (
        await api.post<PlannerAttachment>(path, body, {
          headers: { 'Content-Type': 'multipart/form-data' },
        })
      ).data;
    },
    onSuccess,
  });
  const archive = useMutation({
    mutationFn: async (input: { id: string; archived: boolean }) =>
      (await api.patch<PlannerAttachment>(`${path}/${input.id}`, { archived: input.archived }))
        .data,
    onSuccess,
  });
  const download = useMutation({
    mutationFn: async (file: PlannerAttachment) => {
      const blob = (await api.get<Blob>(`${path}/${file.id}/download`, { responseType: 'blob' }))
        .data;
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = file.fileName;
      link.click();
      URL.revokeObjectURL(url);
    },
  });
  return { query, upload, archive, download };
}
export function usePlannerMutations() {
  const api = useApi();
  const client = useQueryClient();
  const key = usePlannerKey();
  const onSuccess = () => client.invalidateQueries({ queryKey: key });
  const project = useMutation({
    mutationFn: async (input: {
      id?: string;
      version?: number;
      data?: Partial<PlannerProjectData>;
      archived?: boolean;
    }) => {
      const { id, ...body } = input;
      return (
        await (id
          ? api.patch<PlannerProject>(`${BASE}/projects/${id}`, body)
          : api.post<PlannerProject>(`${BASE}/projects`, body))
      ).data;
    },
    onSuccess,
  });
  const task = useMutation({
    mutationFn: async (input: {
      id?: string;
      version?: number;
      data?: Partial<PlannerTaskData>;
      archived?: boolean;
    }) => {
      const { id, ...body } = input;
      return (
        await (id
          ? api.patch<PlannerTask>(`${BASE}/tasks/${id}`, body)
          : api.post<PlannerTask>(`${BASE}/tasks`, body))
      ).data;
    },
    onSuccess,
  });
  const event = useMutation({
    mutationFn: async (input: {
      taskId?: string;
      projectId?: string;
      resourceId?: string;
      kind: 'comment' | 'time' | 'status';
      text: string;
      minutes?: number;
      mentions?: string[];
    }) => {
      const { taskId, projectId, resourceId, ...body } = input;
      return (
        await api.post<PlannerEvent>(
          `${BASE}/${resourceId ? `goals/${resourceId}` : taskId ? `tasks/${taskId}` : `projects/${projectId}`}/events`,
          body,
        )
      ).data;
    },
    onSuccess,
  });
  const inbox = useMutation({
    mutationFn: async (input: { id: string; read?: boolean; archived?: boolean }) => {
      const { id, ...body } = input;
      await api.patch(`${BASE}/inbox/${id}`, body);
    },
    onSuccess,
  });
  const reviseEvent = useMutation({
    mutationFn: async (input: {
      id: string;
      version: number;
      text?: string;
      minutes?: number;
      removed?: boolean;
    }) => {
      const { id, ...body } = input;
      return (await api.patch<PlannerEvent>(`${BASE}/events/${id}`, body)).data;
    },
    onSuccess,
  });
  const resource = useMutation({
    mutationFn: async (input: {
      id?: string;
      version?: number;
      kind?: PlannerResourceKind;
      projectId?: string | null;
      name?: string;
      data?: Record<string, unknown>;
      archived?: boolean;
    }) => {
      const { id, ...body } = input;
      return (
        await (id
          ? api.patch<PlannerResource>(`${BASE}/resources/${id}`, body)
          : api.post<PlannerResource>(`${BASE}/resources`, body))
      ).data;
    },
    onSuccess,
  });
  const goalUpdate = useMutation({
    mutationFn: async (input: {
      id: string;
      version: number;
      status: PlannerGoalData['status'];
      current?: number;
      title: string;
      sections: PlannerGoalUpdateSection[];
      reminder?: PlannerGoalReminder | null;
      timeZone?: string;
    }) => {
      const { id, ...body } = input;
      return (
        await api.post<{ goal: PlannerResource; event: PlannerEvent }>(
          `${BASE}/goals/${id}/updates`,
          body,
        )
      ).data;
    },
    onSuccess,
  });
  const followGoal = useMutation({
    mutationFn: async (input: { id: string; version: number; following: boolean }) => {
      const { id, ...body } = input;
      return (await api.patch<{ following: boolean }>(`${BASE}/goals/${id}/follow`, body)).data;
    },
    onSuccess,
  });
  const instantiate = useMutation({
    mutationFn: async (input: { id: string; name: string; anchorOn?: string }) =>
      (
        await api.post<PlannerProject>(`${BASE}/templates/${input.id}/instantiate`, {
          name: input.name,
          ...(input.anchorOn ? { anchorOn: input.anchorOn } : {}),
        })
      ).data,
    onSuccess,
  });
  const submitForm = useMutation({
    mutationFn: async (input: {
      id: string;
      answers: Record<string, unknown>;
      fields?: PlannerFormQuestion[];
      files?: PlannerFormFiles;
    }) =>
      (
        await api.post<PlannerTask>(
          `${BASE}/forms/${input.id}/submit`,
          input.fields
            ? plannerFormSubmissionBody(input.fields, input.answers, input.files)
            : input.answers,
        )
      ).data,
    onSuccess,
  });
  const shareForm = useMutation({
    mutationFn: async (input: { id: string; version: number; enabled: boolean }) =>
      (
        await api.post<{ token: string | null }>(`${BASE}/forms/${input.id}/share`, {
          version: input.version,
          enabled: input.enabled,
        })
      ).data,
    onSuccess,
  });
  const duplicateProject = useMutation({
    mutationFn: async (input: { id: string; name: string }) =>
      (
        await api.post<PlannerProject>(`${BASE}/projects/${input.id}/duplicate`, {
          name: input.name,
        })
      ).data,
    onSuccess,
  });
  const reorder = useMutation({
    mutationFn: async (input: { projectId: string; tasks: { id: string; version: number }[] }) =>
      api.post(`${BASE}/projects/${input.projectId}/reorder`, { tasks: input.tasks }),
    onSuccess,
  });
  return {
    project,
    task,
    event,
    reviseEvent,
    inbox,
    resource,
    goalUpdate,
    followGoal,
    instantiate,
    submitForm,
    shareForm,
    duplicateProject,
    reorder,
  };
}
export function plannerError(error: unknown): string {
  const value = error as {
    response?: { status?: number; data?: { message?: string | string[] } };
    message?: string;
  };
  if (value.response?.status === 409)
    return 'Someone else updated this item. Refresh it before saving your changes.';
  const message = value.response?.data?.message;
  return Array.isArray(message)
    ? message.join('; ')
    : (message ?? value.message ?? 'Planner could not complete this action.');
}
