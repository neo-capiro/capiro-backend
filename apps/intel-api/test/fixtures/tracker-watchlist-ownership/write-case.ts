import type { PutWatchlistInput } from '../../../src/tracker/tracker-watchlist.service.js';
import { writeHarness } from './write-io.js';

export const fullWriteInput: PutWatchlistInput = {
  issueAreas: ['Energy'],
  jurisdictions: ['tx'],
  expectedVersion: 7,
  topics: [
    {
      label: 'Renamed',
      renameFrom: 'Old',
      priority: 'high',
      terms: [
        { termType: 'company', value: 'RTX' },
        { termType: 'keyword', value: 'grid load' },
      ],
    },
  ],
};
export const writeOperations = [
  'system.client',
  'system.admin',
  'write.head',
  'write.head.upsert',
  'write.topics',
  'write.terms',
  'write.rename',
  'write.topic.upsert',
  'write.terms.delete',
  'write.terms.create',
  'write.topics.delete',
  'write.flat.clear',
  'write.revision',
];

export function fullWriteHarness() {
  const h = writeHarness();
  h.rows.topics = [
    { id: 'topic-kept', label: 'Old' },
    { id: 'topic-gone', label: 'Remove' },
  ];
  h.rows.terms = [
    { topicId: 'topic-kept', termType: 'company', value: 'RTX', weight: 5 },
    { topicId: null, termType: 'keyword', value: 'grid load', weight: 2 },
  ];
  h.rows.viewHead.jurisdictions = ['TX'];
  h.rows.viewTopics = [
    { id: 'topic-kept', label: 'Renamed', issueArea: null, position: 'monitor', priority: 'high' },
  ];
  h.rows.viewTerms = [
    { id: 'term-rtx', topicId: 'topic-kept', termType: 'company', value: 'RTX' },
    { id: 'term-grid', topicId: 'topic-kept', termType: 'keyword', value: 'grid load' },
  ];
  return h;
}
