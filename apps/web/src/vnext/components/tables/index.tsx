import type { HTMLAttributes, TableHTMLAttributes, ThHTMLAttributes, TdHTMLAttributes } from 'react';

export function CapiroTableWrap(props: HTMLAttributes<HTMLDivElement>) {
  return <div className={`capiro-table-wrap ${props.className ?? ''}`.trim()} {...props} />;
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
