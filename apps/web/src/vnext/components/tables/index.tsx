import type { HTMLAttributes, TableHTMLAttributes, ThHTMLAttributes, TdHTMLAttributes } from 'react';
import React from 'react';

export function CapiroTableWrap({ className = '', ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={`capiro-table-wrap ${className}`.trim()} {...props} />;
}

export function CapiroTable({ className = '', ...props }: TableHTMLAttributes<HTMLTableElement>) {
  return <table className={`capiro-table ${className}`.trim()} {...props} />;
}

export function CapiroTableHead(props: HTMLAttributes<HTMLTableSectionElement>) {
  return <thead {...props} />;
}

export function CapiroTableBody(props: HTMLAttributes<HTMLTableSectionElement>) {
  return <tbody {...props} />;
}

export function CapiroTableHeaderCell(props: ThHTMLAttributes<HTMLTableCellElement>) {
  return <th scope="col" {...props} />;
}

export function CapiroTableCell(props: TdHTMLAttributes<HTMLTableCellElement>) {
  return <td {...props} />;
}

export type SortDirection = 'asc' | 'desc' | null;

interface CapiroTableSortHeaderProps extends React.ThHTMLAttributes<HTMLTableCellElement> {
  direction: SortDirection;
  onSort: () => void;
  children: React.ReactNode;
}

export function CapiroTableSortHeader({ direction, onSort, children, ...props }: CapiroTableSortHeaderProps) {
  return (
    <th
      scope="col"
      aria-sort={direction === 'asc' ? 'ascending' : direction === 'desc' ? 'descending' : 'none'}
      onClick={onSort}
      style={{ cursor: 'pointer', userSelect: 'none', whiteSpace: 'nowrap' }}
      {...props}
    >
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
        {children}
        <span aria-hidden="true" style={{ opacity: direction ? 1 : 0.3, fontSize: 10 }}>
          {direction === 'desc' ? '▼' : '▲'}
        </span>
      </span>
    </th>
  );
}
