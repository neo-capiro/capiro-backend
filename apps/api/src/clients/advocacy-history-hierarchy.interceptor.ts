import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import { map } from 'rxjs';

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function ldaPeriodFromPresentedTitle(title: string): string | null {
  return title.match(/(?:^|—)\s*(Q[1-4]\s+20\d{2})\s*$/i)?.[1]?.toUpperCase() ?? null;
}

function presentTimelineEntry(value: unknown): unknown {
  if (!isRecord(value)) return value;
  if (value.kind !== 'record' || value.subtype !== 'federal_lobbying') return value;

  const existingTitle = asString(value.title);
  const period = existingTitle ? ldaPeriodFromPresentedTitle(existingTitle) : null;
  return {
    ...value,
    // Matters answer "what are we advocating for?"; Timeline answers
    // "what happened, and when?". A quarterly LDA filing is an event, not
    // another copy of the Matter headline.
    title: period ? `Quarterly lobbying disclosure — ${period}` : 'Quarterly lobbying disclosure',
  };
}

function presentMatterDetail(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const matterTitle = asString(value.title);
  if (!matterTitle || !Array.isArray(value.records)) return value;

  return {
    ...value,
    records: value.records.map((entry) => {
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

  // The list endpoint is already one row per Matter and must stay untouched.
  if (Array.isArray(value)) return value;
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
