import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import { map } from 'rxjs';
import { presentIssueMatterTitle } from './advocacy-history-presentation.interceptor.js';

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function normalizeQuarter(value: string): string | null {
  const key = value.trim().toLowerCase().replace(/[\s-]+/g, '_');
  const quarters: Record<string, string> = {
    q1: 'Q1',
    first_quarter: 'Q1',
    q2: 'Q2',
    second_quarter: 'Q2',
    q3: 'Q3',
    third_quarter: 'Q3',
    q4: 'Q4',
    fourth_quarter: 'Q4',
  };
  return quarters[key] ?? null;
}

/**
 * Some reviewed LDA findings created human-owned Matters using the source
 * filing slug verbatim (for example `2021 first_quarter — BUD`). We must not
 * rewrite the durable Matter title after review, but that source identifier is
 * still a poor display headline. Only this exact machine-shaped title pattern
 * is normalized; any genuine human-edited Matter title is left untouched.
 */
export function presentMatterDisplayTitle(title: string): string {
  const match = title.match(
    /^(20\d{2})\s+(first_quarter|second_quarter|third_quarter|fourth_quarter|q[1-4])\s+[—-]\s*([A-Z]{2,5})\s*$/i,
  );
  if (!match?.[1] || !match[2] || !match[3]) return title;

  const period = normalizeQuarter(match[2]);
  const code = match[3].toUpperCase();
  if (!period) return title;
  const category = presentIssueMatterTitle(`${code} lobbying activity`, `issue:${code}`);
  return `${category} — ${period} ${match[1]}`;
}

function ldaPeriodFromPresentedTitle(title: string): string | null {
  return title.match(/(?:^|—)\s*(Q[1-4]\s+20\d{2})\s*$/i)?.[1]?.toUpperCase() ?? null;
}

function presentTimelineEntry(value: unknown): unknown {
  if (!isRecord(value)) return value;

  const matterTitle = asString(value.matterTitle);
  const withMatterContext = matterTitle
    ? { ...value, matterTitle: presentMatterDisplayTitle(matterTitle) }
    : value;

  if (value.kind !== 'record' || value.subtype !== 'federal_lobbying') return withMatterContext;

  const existingTitle = asString(value.title);
  const period = existingTitle ? ldaPeriodFromPresentedTitle(existingTitle) : null;
  return {
    ...withMatterContext,
    // Matters answer "what are we advocating for?"; Timeline answers
    // "what happened, and when?". A quarterly LDA filing is an event, not
    // another copy of the Matter headline.
    title: period ? `Quarterly lobbying disclosure — ${period}` : 'Quarterly lobbying disclosure',
  };
}

function presentMatterSummary(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const title = asString(value.title);
  return title ? { ...value, title: presentMatterDisplayTitle(title) } : value;
}

function presentMatterDetail(value: unknown): unknown {
  const summary = presentMatterSummary(value);
  if (!isRecord(summary)) return summary;
  const matterTitle = asString(summary.title);
  if (!matterTitle || !Array.isArray(summary.records)) return summary;

  return {
    ...summary,
    records: summary.records.map((entry) => {
      if (!isRecord(entry)) return entry;
      const eventTitle = asString(entry.title);
      const metadata = isRecord(entry.metadata) ? entry.metadata : {};
      const priorPresentation = isRecord(metadata.presentation) ? metadata.presentation : {};

      return {
        ...entry,
        // Inside a Matter drawer, the record headline is context, not a
        // competing second issue name. The event/source-specific title stays
        // available below presentation.eventTitle for provenance and future UI.
        title: matterTitle,
        metadata: {
          ...metadata,
          presentation: {
            ...priorPresentation,
            matterTitle,
            ...(eventTitle ? { eventTitle } : {}),
          },
        },
      };
    }),
  };
}

/**
 * Final Advocacy History hierarchy pass.
 *
 * This interceptor is registered BEFORE AdvocacyHistoryPresentationInterceptor
 * in ClientsModule. Nest response interceptors unwind in reverse registration
 * order, so the existing LDA presentation runs first and this hierarchy pass
 * receives the final issue-first summaries/metadata before applying the product
 * hierarchy:
 *
 * - Matters / Matter drawer = the institutional advocacy objective/context.
 * - Records inside that drawer inherit the Matter title as their primary label.
 * - Timeline = dated events/actions; LDA rows are explicitly quarterly filing
 *   events rather than another rendering of the Matter title.
 *
 * Durable DB values are untouched. Original LDA source titles remain under
 * metadata.presentation.sourceTitle; the pre-hierarchy display/event title is
 * retained under metadata.presentation.eventTitle.
 */
export function presentAdvocacyHierarchy(path: string, value: unknown): unknown {
  const normalizedPath = path.replace(/\/+$/, '');
  if (normalizedPath.includes('/federal-register-correlations')) return value;

  if (normalizedPath.endsWith('/timeline')) {
    return Array.isArray(value) ? value.map(presentTimelineEntry) : value;
  }

  if (Array.isArray(value)) return value.map(presentMatterSummary);
  return presentMatterDetail(value);
}

@Injectable()
export class AdvocacyHistoryHierarchyInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler) {
    if (context.getType() !== 'http') return next.handle();
    const request = context.switchToHttp().getRequest<{
      method?: string;
      originalUrl?: string;
      url?: string;
    }>();
    const path = (request.originalUrl ?? request.url ?? '').split('?')[0] ?? '';
    if (request.method !== 'GET' || !path.includes('/advocacy-matters')) return next.handle();
    return next.handle().pipe(map((value) => presentAdvocacyHierarchy(path, value)));
  }
}
