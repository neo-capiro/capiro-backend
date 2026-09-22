const SIGNED_QUERY =
  /^(?:token|sig|signature|expires?|policy|key-pair-id|x-amz-.+|auth|auth_token|access_token|jwt|hdnea|hdnts)$/i;
const DIRECT_MEDIA_PATH = /\.(?:m3u8|mp[34]|m4a|aac|wav|webm|ts|mov|flv|mkv)(?:$|\/)/i;

function allowedHost(url: URL): boolean {
  const host = url.hostname.toLowerCase();
  const subdomainOf = (domain: string) => host === domain || host.endsWith(`.${domain}`);
  if (host.startsWith('api.')) return false;
  if (host === 'thefloridachannel.org') {
    return /^\/videos\/(?!feed\/?$|rss\/?$|page\/|category\/|tag\/|author\/|wp-json\/)[^/]+\/?$/i.test(
      url.pathname,
    );
  }
  return (
    ['congress.gov', 'senate.gov', 'house.gov', 'flsenate.gov', 'flhouse.gov'].some(subdomainOf) ||
    host === 'youtu.be' ||
    host === 'youtube.com' ||
    host.endsWith('.youtube.com')
  );
}

export function safeOfficialExternalUrl(value?: string | null): string | null {
  const raw = value?.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
    if (!allowedHost(url) || DIRECT_MEDIA_PATH.test(url.pathname)) return null;
    if ([...url.searchParams.keys()].some((key) => SIGNED_QUERY.test(key))) return null;
    url.hash = '';
    if (url.pathname !== '/') url.pathname = url.pathname.replace(/\/+$/, '') || '/';
    return url.toString();
  } catch {
    return null;
  }
}

export function OfficialHearingLinks({
  officialPageUrl,
  officialPlaybackUrl,
  officialPlaybackKind,
  eventStatus,
}: {
  officialPageUrl?: string | null;
  officialPlaybackUrl?: string | null;
  officialPlaybackKind?: 'official_player_page' | 'official_listing_page' | null;
  eventStatus?: string | null;
}) {
  const playback = safeOfficialExternalUrl(officialPlaybackUrl);
  const source = safeOfficialExternalUrl(officialPageUrl);
  const distinctSource = source && source !== playback ? source : null;
  const replay = ['COMPLETED', 'ENDED', 'ADJOURNED'].includes((eventStatus ?? '').toUpperCase());
  if (!playback && !distinctSource) return null;
  return (
    <>
      {playback ? (
        <>
          <dt>
            {officialPlaybackKind === 'official_player_page'
              ? replay
                ? 'Official replay'
                : 'Official stream'
              : 'Official source'}
          </dt>
          <dd>
            <a className="lw-backlink" href={playback} target="_blank" rel="noreferrer noopener">
              {officialPlaybackKind === 'official_player_page'
                ? replay
                  ? 'Replay on official site ↗'
                  : 'Watch on official site ↗'
                : 'Official event page ↗'}
            </a>
          </dd>
        </>
      ) : null}
      {distinctSource ? (
        <>
          <dt>Official source</dt>
          <dd>
            <a
              className="lw-backlink"
              href={distinctSource}
              target="_blank"
              rel="noreferrer noopener"
            >
              Official event page ↗
            </a>
          </dd>
        </>
      ) : null}
    </>
  );
}

export function OfficialArchiveReplayLink({
  url,
  kind,
}: {
  url?: string | null;
  kind?: 'official_player_page' | 'official_listing_page' | null;
}) {
  const safe = kind === 'official_player_page' ? safeOfficialExternalUrl(url) : null;
  return safe ? (
    <a
      className="lw-backlink"
      href={safe}
      target="_blank"
      rel="noreferrer noopener"
      style={{ display: 'inline-block', marginTop: 6, fontSize: 12 }}
    >
      Replay on official site ↗
    </a>
  ) : null;
}
