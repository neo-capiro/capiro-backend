/**
 * vNext re-skin of pages/help/HelpPage.tsx — identical endpoint
 * (GET /api/help/content), query key (['help-content']), search filtering,
 * video modal / guide new-tab behavior, copy, and empty/loading/error states.
 * Presentation moves to the vNext token layer + Capiro primitives.
 */
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useApi } from '../../../lib/use-api.js';
import { CapiroBadge } from '../../components/badges/index.js';
import { CapiroInput } from '../../components/fields/index.js';
import { CapiroEmptyState, CapiroErrorState, CapiroSkeleton } from '../../components/feedback/index.js';
import { CapiroReadIcon } from '../../components/icons/index.js';
import { CapiroModal } from '../../components/overlays/index.js';

interface HelpItem {
  id: string;
  title: string;
  description: string;
  type: 'video' | 'guide';
  durationLabel?: string;
  url: string | null;
  thumbnailUrl: string | null;
}

interface HelpCategory {
  id: string;
  title: string;
  description?: string;
  items: HelpItem[];
}

function HelpCover({ item }: { item: HelpItem }) {
  if (item.thumbnailUrl) {
    return (
      <div className="amx-help-cover">
        <img src={item.thumbnailUrl} alt="" />
        {item.type === 'video' ? (
          <span className="amx-help-cover-glyph" aria-hidden="true" style={{ fontSize: 40 }}>
            ▶
          </span>
        ) : null}
      </div>
    );
  }
  return (
    <div className="amx-help-cover" aria-hidden="true">
      {item.type === 'video' ? '▶' : <CapiroReadIcon size={1} />}
    </div>
  );
}

export function VNextHelpPage() {
  const api = useApi();
  const [query, setQuery] = useState('');
  const [activeVideo, setActiveVideo] = useState<HelpItem | null>(null);

  const { data, isLoading, isError, error, refetch } = useQuery<HelpCategory[]>({
    queryKey: ['help-content'],
    queryFn: async () => (await api.get<HelpCategory[]>('/api/help/content')).data,
    staleTime: 5 * 60_000,
  });

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const categories = data ?? [];
    if (!q) return categories;
    return categories
      .map((category) => ({
        ...category,
        items: category.items.filter(
          (item) =>
            item.title.toLowerCase().includes(q) || item.description.toLowerCase().includes(q),
        ),
      }))
      .filter((category) => category.items.length > 0);
  }, [data, query]);

  const openItem = (item: HelpItem) => {
    if (!item.url) return;
    if (item.type === 'video') setActiveVideo(item);
    else window.open(item.url, '_blank', 'noopener,noreferrer');
  };

  return (
    <div className="settings-vnext amx">
      <header className="stv-header">
        <div>
          <h1>Help center</h1>
          <p>How-to videos and guides for getting the most out of Capiro.</p>
        </div>
      </header>
      <div className="stv-body">
        <div style={{ maxWidth: 480 }}>
          <CapiroInput
            label="Search help content"
            type="search"
            placeholder="Search help videos and guides…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>

        {isLoading ? (
          <div className="stv-stack" aria-label="Loading help content">
            <CapiroSkeleton height={18} width="40%" />
            <div className="amx-help-grid">
              <CapiroSkeleton height={180} />
              <CapiroSkeleton height={180} />
              <CapiroSkeleton height={180} />
            </div>
          </div>
        ) : isError ? (
          <CapiroErrorState
            title="Couldn't load help content"
            description={error instanceof Error ? error.message : 'Please try again.'}
            onRetry={() => void refetch()}
          />
        ) : filtered.length === 0 ? (
          <CapiroEmptyState
            title={query ? 'No matching help content' : 'No help content yet'}
          />
        ) : (
          filtered.map((category) => (
            <section key={category.id} className="stv-stack" aria-label={category.title}>
              <div>
                <h2 className="stv-card__title" style={{ margin: 0 }}>
                  {category.title}
                </h2>
                {category.description ? (
                  <p className="stv-card__desc">{category.description}</p>
                ) : null}
              </div>
              <div className="amx-help-grid">
                {category.items.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className="amx-help-card"
                    disabled={!item.url}
                    onClick={() => openItem(item)}
                  >
                    <HelpCover item={item} />
                    <span className="amx-help-card-body">
                      <span className="stv-row" style={{ gap: 8 }}>
                        <CapiroBadge tone={item.type === 'video' ? 'info' : 'success'}>
                          {item.type === 'video' ? 'Video' : 'Guide'}
                        </CapiroBadge>
                        {item.durationLabel ? (
                          <span className="stv-muted stv-small">{item.durationLabel}</span>
                        ) : null}
                        {item.type === 'guide' && item.url ? (
                          <span className="stv-muted stv-small" style={{ marginLeft: 'auto' }} aria-hidden="true">
                            ↗
                          </span>
                        ) : null}
                      </span>
                      <span className="stv-strong">{item.title}</span>
                      <span className="stv-muted stv-small">{item.description}</span>
                      {!item.url ? <span className="stv-muted stv-small">Unavailable</span> : null}
                    </span>
                  </button>
                ))}
              </div>
            </section>
          ))
        )}
      </div>

      {activeVideo ? (
        <CapiroModal open title={activeVideo.title} onClose={() => setActiveVideo(null)}>
          {activeVideo.url ? (
            <video
              className="amx-help-video"
              src={activeVideo.url}
              poster={activeVideo.thumbnailUrl ?? undefined}
              controls
              autoPlay
              muted
              playsInline
            />
          ) : null}
        </CapiroModal>
      ) : null}
    </div>
  );
}
