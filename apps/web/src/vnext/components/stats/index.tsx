import React from 'react';
import './stats.css';

export type UuiStatTone = 'success' | 'warning' | 'danger' | 'info' | 'neutral';

interface UuiStatProps {
  label: string;
  value: React.ReactNode;
  trend?: number;
  trendLabel?: string;
  tone?: UuiStatTone;
  loading?: boolean;
  className?: string;
}

export function UuiStat({ label, value, trend, trendLabel, tone, loading, className }: UuiStatProps) {
  const trendDir = trend === undefined ? null : trend > 0 ? 'up' : trend < 0 ? 'down' : null;
  return (
    <div className={['capiro-uui-stat', className].filter(Boolean).join(' ')}>
      <span className="capiro-uui-stat__label">{label}</span>
      <span className="capiro-uui-stat__value" aria-busy={loading}>
        {loading ? <span className="capiro-uui-stat__skeleton" aria-hidden="true" /> : value}
      </span>
      {trend !== undefined && (
        <span
          className={['capiro-uui-stat__trend', trendDir && `capiro-uui-stat__trend--${trendDir}`]
            .filter(Boolean)
            .join(' ')}
        >
          {trendDir === 'up' ? '▲' : trendDir === 'down' ? '▼' : null}
          {trendLabel ?? (trend > 0 ? `+${trend}%` : `${trend}%`)}
        </span>
      )}
    </div>
  );
}

export default UuiStat;
