/**
 * Hill Day module — domain types for the wizard and editor surfaces.
 *
 * These mirror the API contracts in the implementation requirements §6
 * (GET /api/v1/documents/{id}/resolution, GET /api/v1/documents/{id}/meetings/…,
 * etc.). Until the backend module ships, the module hydrates from
 * fixtures.ts, which is the prototype's own data verbatim — never invented.
 */
import type { HillDayIcon } from './ui.js';

/** The pill/status badge tones (Untitled UI badge colour families). */
export type PillTone = 'gray' | 'navy' | 'warn' | 'ok' | 'dark';

export type AttendeeState = 'resolved' | 'unresolved' | 'scheduler' | 'stale';

export interface HillDayAttendee {
  name: string;
  detail: string;
  state: AttendeeState;
}

export interface HillDayMeeting {
  id: string;
  day: number;
  time: string;
  dur: string;
  subject: string;
  short: string;
  place: string;
  kind: 'hill' | 'internal';
  member?: string;
  party?: string;
  room?: string;
  cmte?: string;
  att?: HillDayAttendee[];
  focus?: string;
  background?: string;
}

export interface DirectoryStaffer {
  role: string;
  topics: string[];
}

export interface MeetingDirectory {
  issues: string[];
  bio: string;
  staff: Record<string, DirectoryStaffer>;
}

export interface ThreadRef {
  id: string;
  subject: string;
  meta: string;
  age: string;
}

export interface ClientOption {
  id: string;
  mono: string;
  name: string;
  meta: string;
}

export interface BlueprintDef {
  name: string;
  desc: string;
  meta: string;
  icon: HillDayIcon;
  isNew: boolean;
  sources: string[];
}

export interface LibraryDocRow {
  name: string;
  type: string;
  client: string;
  tone: PillTone;
  label: string;
  updated: string;
  owner: string;
  icon: HillDayIcon;
  isHill: boolean;
}
