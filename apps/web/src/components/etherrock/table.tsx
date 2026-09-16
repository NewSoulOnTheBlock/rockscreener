'use client';

import * as React from 'react';
import { cn } from '@/lib/cn';

/**
 * The sortable table both listings use.
 *
 * SORT STARTS DESCENDING on whichever column is marked, because every column
 * here is a magnitude and the first question asked of a magnitude is which one
 * is biggest. Clicking the active column flips it; clicking another takes it
 * descending again rather than inheriting the previous direction, which is the
 * behaviour that stops a reader wondering why their new sort came back upside
 * down.
 *
 * Numbers are tabular and right-aligned so a column of them can be compared by
 * eye without reading any of them.
 */

export type Column<T> = {
  key: keyof T & string;
  label: string;
  num?: boolean;
  addr?: boolean;
  sort?: boolean;
  render?: (row: T) => React.ReactNode;
};

export function SortableTable<T extends Record<string, unknown>>({
  columns,
  rows,
  rowKey,
  maxHeight,
}: {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string | number;
  maxHeight?: number;
}) {
  const [sortKey, setSortKey] = React.useState<string>(
    () => columns.find((c) => c.sort)?.key ?? columns[0].key
  );
  const [desc, setDesc] = React.useState(true);

  const sorted = React.useMemo(() => {
    return [...rows].sort((a, b) => {
      const x = a[sortKey];
      const y = b[sortKey];
      if (typeof x === 'number' && typeof y === 'number') return desc ? y - x : x - y;
      return desc
        ? String(y ?? '').localeCompare(String(x ?? ''))
        : String(x ?? '').localeCompare(String(y ?? ''));
    });
  }, [rows, sortKey, desc]);

  const toggle = (key: string) => {
    if (sortKey === key) setDesc((d) => !d);
    else {
      setSortKey(key);
      setDesc(true);
    }
  };

  return (
    <div
      className="overflow-x-auto rounded-[var(--radius-md)] border border-rule-faint bg-sunk"
      style={maxHeight ? { maxHeight, overflowY: 'auto' } : undefined}
    >
      <table className="w-full border-collapse text-[13px]">
        <thead>
          <tr>
            {columns.map((c) => {
              const active = sortKey === c.key;
              return (
                <th
                  key={c.key}
                  onClick={() => toggle(c.key)}
                  aria-sort={active ? (desc ? 'descending' : 'ascending') : 'none'}
                  className={cn(
                    'sticky top-0 z-10 cursor-pointer select-none whitespace-nowrap border-b border-rule-faint bg-raised px-3 py-2',
                    'text-[11px] font-semibold tracking-[0.06em] uppercase transition-colors',
                    c.num ? 'text-right' : 'text-left',
                    active ? 'text-rock' : 'text-dim hover:text-ash'
                  )}
                >
                  {c.label}
                  {active ? <span className="ml-1 text-[9px]">{desc ? '▼' : '▲'}</span> : null}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {sorted.map((r) => (
            <tr key={rowKey(r)} className="transition-colors hover:bg-raised/60">
              {columns.map((c) => (
                <td
                  key={c.key}
                  className={cn(
                    'whitespace-nowrap border-b border-rule-faint px-3 py-2 text-ash last:border-b-0',
                    c.num && 'tnum text-right font-mono text-[12.5px]',
                    c.addr && 'font-mono text-[12px]'
                  )}
                >
                  {c.render ? c.render(r) : ((r[c.key] as React.ReactNode) ?? '—')}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
