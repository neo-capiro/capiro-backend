/**
 * Hill Day module — API client.
 *
 * The surface is a NEW build against the requirement §6 endpoint families.
 * Until the Hill Day backend module ships, every read resolves from
 * fixtures.ts (the prototype's own data) after a simulated latency-free
 * await — the call shape below is the integration target, so wiring the real
 * backend later is a swap of the resolver, not a rewrite of the UI.
 *
 * This module uses the workspace raw-fetch `api` client only where a real
 * workspace endpoint exists today (documents listing). Everything
 * Hill-Day-specific is fixture-backed and marked.
 */
import {
  BLUEPRINTS,
  CLIENTS,
  DIRECTORY,
  LIBRARY_DOCS,
  MEETINGS,
  THREADS,
} from './fixtures.js';
import type {
  ClientOption,
  HillDayMeeting,
  LibraryDocRow,
  MeetingDirectory,
  ThreadRef,
} from './types.js';
import type { BlueprintDef } from './types.js';

export interface HillDayApi {
  listBlueprints(): Promise<BlueprintDef[]>;
  listClients(): Promise<ClientOption[]>;
  listDocuments(): Promise<LibraryDocRow[]>;
  listMeetings(): Promise<HillDayMeeting[]>;
  memberDirectory(meetingId: string): Promise<MeetingDirectory>;
  listThreads(meetingId: string): Promise<ThreadRef[]>;
  /**
   * Synchronous resolvers for the fixture-backed read paths the wizard and
   * editor use during render. When the real backend ships these become
   * react-query reads and the sync forms are removed.
   */
  memberDirectorySync(meetingId: string): MeetingDirectory;
  listThreadsSync(meetingId: string): ThreadRef[];
}

/** Fixture-backed implementation — the shape the backend must honour. */
export const hillDayApi: HillDayApi = {
  async listBlueprints() {
    return BLUEPRINTS;
  },
  async listClients() {
    return CLIENTS;
  },
  async listDocuments() {
    return LIBRARY_DOCS;
  },
  async listMeetings() {
    return MEETINGS;
  },
  async memberDirectory(meetingId: string) {
    return DIRECTORY[meetingId] ?? { issues: [], bio: '', staff: {} };
  },
  async listThreads(meetingId: string) {
    return THREADS[meetingId] ?? [];
  },
  memberDirectorySync(meetingId: string) {
    return DIRECTORY[meetingId] ?? { issues: [], bio: '', staff: {} };
  },
  listThreadsSync(meetingId: string) {
    return THREADS[meetingId] ?? [];
  },
};
