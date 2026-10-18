import type { TrackerBoardService } from './tracker-board.service.js';
export interface TrackerBoardReadPolicy {
  pageSize: number;
  pageSizeMax: number;
  recentChangeDays: number;
  dayMs: number;
}
export type BoardBills = Awaited<ReturnType<TrackerBoardService['fetchMergedBills']>>;
export type BoardTopics = Awaited<ReturnType<TrackerBoardService['compiledTopics']>>;
export type TenantBoardTopics = Awaited<ReturnType<TrackerBoardService['compileTopicsForClients']>>;
