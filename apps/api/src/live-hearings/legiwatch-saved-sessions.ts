/**
 * Read-only bridge from public hearing identity to accessible browser captures.
 * Transcript and intelligence bodies remain behind intel-api's existing access
 * and decryption boundary. Nothing here writes tenant content to public rails.
 */
export interface SavedHearingSession {
  id: string;
  hearingId: string;
  title: string;
  status: string;
  transcriptSegmentCount: number;
  intelligenceMomentCount: number;
  recordingPath: string;
  association: 'hearing_id' | 'official_source';
  sourceUrl: string | null;
  startedAt: string | null;
  endedAt: string | null;
}

export interface SavedSessionsDiscovery {
  savedSessionsState: 'available' | 'unavailable';
  sessions: SavedHearingSession[];
}

interface QueryPort {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
}

/**
 * The caller supplies a withTenant transaction. Explicit tenant predicates are
 * still required: the application role can bypass RLS. Private sessions use
 * the Clerk creator id, exactly like HearingSessionService.getAccessible.
 *
 * An explicit existing hearing id wins over URLs. Unlinked/legacy sessions may
 * match only an exact official page or media identity already in the public
 * corpus, and only when that identity resolves to ONE hearing. Registry/listing
 * URLs are not event identities, even in a sparse corpus. Media/player fallback
 * requires a recognized event-specific provider URL; unknown media needs an
 * explicit hearing id. No title/date similarity creates a link.
 */
export async function discoverSavedHearingSessions(
  tx: QueryPort,
  tenantId: string,
  clerkUserId: string,
  hearingId: string | null = null,
): Promise<SavedSessionsDiscovery> {
  // intel-api migrations can roll out separately from API migrations. A missing
  // rail is explicitly unavailable, never an assertion that no sessions exist.
  const readiness = await tx.$queryRawUnsafe<Array<{ available: boolean }>>(`
   SELECT to_regclass('intel_live_hearing_session') IS NOT NULL
      AND to_regclass('intel_transcript_segment') IS NOT NULL
      AND to_regclass('intel_live_summary_card') IS NOT NULL
      AND to_regclass('public_hearing_capture') IS NOT NULL
      AND to_regclass('public_hearing_transcript_segment') IS NOT NULL
      AND to_regclass('public_hearing_insight') IS NOT NULL AS available
 `);
  if (!readiness[0]?.available) return { savedSessionsState: 'unavailable', sessions: [] };

  const rows = await tx.$queryRawUnsafe<
    Array<{
      id: string;
      hearingId: string;
      title: string;
      status: string;
      transcriptSegmentCount: number;
      intelligenceMomentCount: number;
      association: SavedHearingSession['association'];
      sourceUrl: string | null;
      startedAt: Date | string | null;
      endedAt: Date | string | null;
    }>
  >(
    `
    WITH official_identities AS MATERIALIZED (
      SELECT h.id AS hearing_id, h.url AS source_url
      FROM federal_committee_hearing h WHERE h.visibility = 'public' AND h.url IS NOT NULL
      UNION
      SELECT h.id, sc.official_page_url FROM hearing_stream_candidate sc
      JOIN federal_committee_hearing h ON h.id = sc.hearing_id AND h.visibility = 'public'
      WHERE sc.official_page_url IS NOT NULL
      UNION
      SELECT h.id, sc.media_url FROM hearing_stream_candidate sc
      JOIN federal_committee_hearing h ON h.id = sc.hearing_id AND h.visibility = 'public'
      WHERE sc.media_url IS NOT NULL
    ), accessible_sessions AS MATERIALIZED (
      SELECT s.*,
        lower(regexp_replace(split_part(split_part(s.source_url, '?', 1), '#', 1), '^https?://[^/]+', '', 'i')) AS source_path
      FROM intel_live_hearing_session s
      WHERE s.tenant_id = $1
        AND (s.source_type::text IN ('hearing', 'markup') OR s.created_by = $2)
        -- Detail bounds tenant rows before artifact counts. Source uniqueness
        -- below still checks ALL public identities, not only this hearing.
        AND ($3::text IS NULL OR s.hearing_id = $3 OR s.source_url IN (
          SELECT source_url FROM official_identities WHERE hearing_id = $3
        ))
    ), source_candidates AS (
      SELECT s.id AS session_id, identity.hearing_id
      FROM accessible_sessions s
      JOIN official_identities identity ON identity.source_url = s.source_url
      WHERE s.source_type::text IN ('hearing', 'markup')
        AND s.source_url ~ '^https?://[^/]+/.+'
        AND NOT EXISTS (SELECT 1 FROM federal_committee_hearing explicit WHERE explicit.id = s.hearing_id)
        -- Normalization is used only to REJECT source/listing identities;
        -- association equality above remains exact, including query values.
        AND NOT EXISTS (
          SELECT 1 FROM committee_source registry
          WHERE rtrim(lower(split_part(split_part(registry.source_url, '?', 1), '#', 1)), '/') =
                rtrim(lower(split_part(split_part(s.source_url, '?', 1), '#', 1)), '/')
        )
        AND s.source_path NOT IN ('', '/')
        AND s.source_path !~ '/(hearings?|hearings_meetings|meetings?|events?|calendars?|schedules?|committee_schedules|index)([.](xml|html?|aspx|php))?/?$'
        AND (
          -- Ordinary specific event-page URLs can qualify. Media/player URLs
          -- can be persistent channels, so they require provider identity.
          (s.source_path !~ '[.](m3u8?|mp4|mp3|aac|webm|mpd|wav)$'
           AND s.source_path !~ '(^|/)(live|streams?|videos?|watch|player|isvp|embed)(/|[.]|$)'
           AND s.source_url !~ '^https?://([^/]+[.])?(youtube[.]com|youtu[.]be)/')
          OR s.source_url ~ '^https://(www[.])?youtube[.]com/(watch[?]([^#]*&)?v=[A-Za-z0-9_-]{11}(&|#|$)|embed/[A-Za-z0-9_-]{11}([?/#]|$))'
          OR s.source_url ~ '^https://youtu[.]be/[A-Za-z0-9_-]{11}([?/#]|$)'
          OR (s.source_url ~ '^https://(www[.])?senate[.]gov/isvp/?[?]'
              AND s.source_url ~ '[?&]filename=[A-Za-z]+[0-9]{6}([.]mp4)?(&|#|$)')
          OR s.source_url ~ '^https://www-senate-gov-media-srs[.]akamaized[.]net/.*/[A-Za-z]+[0-9]{6}/master[.]m3u8([?#]|$)'
        )
    ), associations AS (
      SELECT s.id AS session_id, h.id AS hearing_id, 'hearing_id' AS association
      FROM accessible_sessions s JOIN federal_committee_hearing h ON h.id = s.hearing_id
      WHERE $3::text IS NULL OR h.id = $3
      UNION ALL
      SELECT session_id, min(hearing_id), 'official_source'
      FROM source_candidates GROUP BY session_id
      HAVING count(DISTINCT hearing_id) = 1
        AND ($3::text IS NULL OR min(hearing_id) = $3)
    )
    SELECT s.id, a.hearing_id AS "hearingId", s.title, s.status::text AS status,
      a.association, s.source_url AS "sourceUrl", s.started_at AS "startedAt", s.ended_at AS "endedAt",
      CASE
        -- Canonical public review context: count the public capture's final
        -- transcript instead of the tenant-private browser rail. The capture FK
        -- trigger validates the hearing association at write time; we verify it
        -- again here so a stale/misassociated session cannot borrow another
        -- hearing's transcript count.
        WHEN s.public_capture_id IS NOT NULL AND EXISTS (
          SELECT 1 FROM public_hearing_capture c
          WHERE c.id = s.public_capture_id AND c.hearing_id = s.hearing_id
        )
        THEN (SELECT count(*)::int FROM public_hearing_transcript_segment pts
              WHERE pts.capture_id = s.public_capture_id AND pts.is_final = true)
        ELSE (SELECT count(*)::int FROM intel_transcript_segment seg
              WHERE seg.tenant_id = $1 AND seg.session_id = s.id AND seg.is_final = true)
      END AS "transcriptSegmentCount",
      -- Same owner choice as the transcript count above: a verified public
      -- review session counts its capture's public insight moments instead of
      -- the tenant-private summary-card rail (which is always empty there).
      -- Insight rows hang off one canonical segment each, so the moment count
      -- is distinct source segments, never raw rows or synthetic edges.
      CASE
        WHEN s.public_capture_id IS NOT NULL AND EXISTS (
          SELECT 1 FROM public_hearing_capture c
          WHERE c.id = s.public_capture_id AND c.hearing_id = s.hearing_id
        )
        THEN (SELECT count(DISTINCT coalesce(insight.segment_id, insight.id))::int
              FROM public_hearing_insight insight
              WHERE insight.capture_id = s.public_capture_id
                AND insight.hearing_id = s.hearing_id)
        ELSE (SELECT count(DISTINCT coalesce(card.segment_id, card.id))::int FROM intel_live_summary_card card
              WHERE card.tenant_id = $1 AND card.session_id = s.id)
      END AS "intelligenceMomentCount"
    FROM associations a JOIN accessible_sessions s ON s.id = a.session_id
    ORDER BY s.created_at DESC, s.id DESC
  `,
    tenantId,
    clerkUserId,
    hearingId,
  );

  const iso = (value: Date | string | null): string | null =>
    value instanceof Date ? value.toISOString() : value;
  return {
    savedSessionsState: 'available',
    sessions: rows.map((row) => ({
      ...row,
      transcriptSegmentCount: Number(row.transcriptSegmentCount),
      intelligenceMomentCount: Number(row.intelligenceMomentCount),
      startedAt: iso(row.startedAt),
      endedAt: iso(row.endedAt),
      recordingPath: `/intelligence/hearing-watch/${encodeURIComponent(row.id)}`,
    })),
  };
}
