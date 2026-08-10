import type {
  OutreachV3ContextClass,
  OutreachV3ContextScope,
} from './contracts.js';

declare module './contracts.js' {
  export interface OutreachV3ContextSearchInput {
    source: 'memory' | 'government';
    query: string;
    clientId?: string | null;
    intendedClass: OutreachV3ContextClass;
    scope: OutreachV3ContextScope;
    categories?: string[];
    limit?: number;
  }
}
