/**
 * Data Explorer vNext — results table, pagination, tags and state blocks.
 *
 * The table is the vNext CapiroTable primitive family with the canonical
 * antd-Table column contract layered on top (title/dataIndex/width/align/
 * ellipsis/render(value, row)), so each source's column definitions port
 * verbatim. States are contract:
 *   loading (first load)  → CapiroSkeleton stack
 *   zero rows             → CapiroEmptyState with the canonical copy
 *   data                  → meta line "N records · showing X–Y" + rows +
 *                           numbered pagination (page size 25, no size changer)
 */
import type { ReactNode } from 'react';
import {
  CapiroTable,
  CapiroTableBody,
  CapiroTableCell,
  CapiroTableHead,
  CapiroTableHeaderCell,
  CapiroTableWrap,
} from '../../components/tables/index.js';
import { CapiroBadge, type CapiroBadgeTone } from '../../components/badges/index.js';
import { CapiroButton } from '../../components/actions/index.js';
import { CapiroEmptyState, CapiroSkeleton } from '../../components/feedback/index.js';
import { PAGE_SIZE } from './explorer-format.js';

/* ── Tags ────────────────────────────────────────────────────────────────── */

/** Canonical `<Tag className="redesign-mono-tag">` — a small mono chip. */
export function MonoTag({ children }: { children: ReactNode }) {
  return <CapiroBadge className="xp-tag xp-tag--mono">{children}</CapiroBadge>;
}

/** Canonical bare `<Tag>` (and its gold/green color variants). */
export function PlainTag({ tone, children }: { tone?: CapiroBadgeTone; children: ReactNode }) {
  return (
    <CapiroBadge tone={tone} className="xp-tag">
      {children}
    </CapiroBadge>
  );
}

/** Canonical ChipList: first `max` values as mono chips, then a "+n" chip. */
export function ChipList({ items, max }: { items: string[]; max: number }) {
  return (
    <span className="xp-chiplist">
      {items.slice(0, max).map((it) => (
        <MonoTag key={it}>{it}</MonoTag>
      ))}
      {items.length > max ? <PlainTag>+{items.length - max}</PlainTag> : null}
    </span>
  );
}

/* ── Loading / empty ─────────────────────────────────────────────────────── */

/** antd `<Skeleton active paragraph={{ rows }} />` equivalent. */
export function XpSkeletonRows({ rows = 8 }: { rows?: number }) {
  return (
    <div className="xp-skeleton" aria-busy="true">
      {Array.from({ length: rows }, (_, i) => (
        <CapiroSkeleton key={i} height={14} width={i === rows - 1 ? '61%' : '100%'} />
      ))}
    </div>
  );
}

export function XpEmpty({ description }: { description: string }) {
  return (
    <div className="xp-empty">
      <CapiroEmptyState title={description} />
    </div>
  );
}

/* ── Pagination ──────────────────────────────────────────────────────────── */

function pageItems(current: number, totalPages: number): Array<number | 'gap-l' | 'gap-r'> {
  if (totalPages <= 7) return Array.from({ length: totalPages }, (_, i) => i + 1);
  const items: Array<number | 'gap-l' | 'gap-r'> = [1];
  const from = Math.max(2, current - 2);
  const to = Math.min(totalPages - 1, current + 2);
  if (from > 2) items.push('gap-l');
  for (let p = from; p <= to; p += 1) items.push(p);
  if (to < totalPages - 1) items.push('gap-r');
  items.push(totalPages);
  return items;
}

/** Numbered pager — same reachable pages as the canonical antd Pagination
 *  (arbitrary page jumps, fixed page size, no size changer). */
export function XpPagination({
  page,
  total,
  onPageChange,
}: {
  page: number;
  total: number;
  onPageChange: (page: number) => void;
}) {
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  return (
    <nav className="xp-pagination" aria-label="Pagination">
      <CapiroButton size="compact" disabled={page <= 1} onClick={() => onPageChange(page - 1)}>
        Previous
      </CapiroButton>
      <span className="xp-pagination__pages">
        {pageItems(page, totalPages).map((item) =>
          typeof item === 'number' ? (
            <button
              key={item}
              type="button"
              className={`xp-pagination__page${item === page ? ' xp-pagination__page--current' : ''}`}
              aria-current={item === page ? 'page' : undefined}
              onClick={() => onPageChange(item)}
            >
              {item}
            </button>
          ) : (
            <span key={item} className="xp-pagination__gap" aria-hidden="true">
              …
            </span>
          ),
        )}
      </span>
      <CapiroButton size="compact" disabled={page >= totalPages} onClick={() => onPageChange(page + 1)}>
        Next
      </CapiroButton>
    </nav>
  );
}

/* ── Table ───────────────────────────────────────────────────────────────── */

export interface XpColumn<T> {
  title: string;
  /** Field plucked off the row and passed to `render` as the first argument. */
  dataIndex?: keyof T & string;
  width?: number;
  align?: 'left' | 'right';
  ellipsis?: boolean;
  render?: (value: never, row: T) => ReactNode;
}

export function XpTable<T extends { id: string }>({
  loading,
  rows,
  total,
  page,
  onPageChange,
  rowKey,
  columns,
  onRowClick,
}: {
  loading: boolean;
  rows: T[];
  total: number;
  page: number;
  onPageChange: (page: number) => void;
  rowKey: keyof T;
  columns: Array<XpColumn<T>>;
  onRowClick?: (id: string, row: T) => void;
}) {
  if (loading && rows.length === 0) {
    return (
      <div className="xp-table-shell">
        <XpSkeletonRows rows={8} />
      </div>
    );
  }

  if (!rows.length) {
    return (
      <div className="xp-table-shell xp-table-shell--empty">
        <XpEmpty description="No rows match these filters." />
      </div>
    );
  }

  return (
    <div className="xp-table-shell">
      <div className="xp-table-meta">
        <span className="xp-table-count">
          <b>{total.toLocaleString()}</b> record{total === 1 ? '' : 's'} · showing{' '}
          {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, total)}
        </span>
      </div>
      <CapiroTableWrap className="xp-table-wrap">
        <CapiroTable className="xp-table">
          <colgroup>
            {columns.map((column, index) => (
              <col key={index} style={column.width ? { width: column.width } : undefined} />
            ))}
          </colgroup>
          <CapiroTableHead>
            <tr>
              {columns.map((column, index) => (
                <CapiroTableHeaderCell
                  key={index}
                  className={column.align === 'right' ? 'xp-cell--right' : undefined}
                >
                  {column.title}
                </CapiroTableHeaderCell>
              ))}
            </tr>
          </CapiroTableHead>
          <CapiroTableBody>
            {rows.map((row) => (
              <tr
                key={String(row[rowKey])}
                className={onRowClick ? 'xp-row xp-row--clickable' : 'xp-row'}
                onClick={onRowClick ? () => onRowClick(row.id, row) : undefined}
              >
                {columns.map((column, index) => {
                  const value = column.dataIndex ? row[column.dataIndex] : undefined;
                  // No-render columns show the raw value exactly like antd's
                  // Table: null/undefined render as an empty cell, not "-".
                  const content = column.render
                    ? column.render(value as never, row)
                    : (value as ReactNode);
                  return (
                    <CapiroTableCell
                      key={index}
                      className={
                        [
                          column.align === 'right' ? 'xp-cell--right' : null,
                          column.ellipsis ? 'xp-cell--ellipsis' : null,
                        ]
                          .filter(Boolean)
                          .join(' ') || undefined
                      }
                    >
                      {content}
                    </CapiroTableCell>
                  );
                })}
              </tr>
            ))}
          </CapiroTableBody>
        </CapiroTable>
      </CapiroTableWrap>
      {total > PAGE_SIZE ? (
        <div className="xp-pagination-row">
          <XpPagination page={page} total={total} onPageChange={onPageChange} />
        </div>
      ) : null}
    </div>
  );
}
