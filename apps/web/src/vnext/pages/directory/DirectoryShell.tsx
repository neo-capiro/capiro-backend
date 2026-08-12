import type { ReactNode } from 'react';
import { CapiroTopNavItem } from '../../components/navigation/index.js';
import { DIRECTORY_TABS } from './directory-routes.js';
import './directory.css';

export interface DirectoryMetric {
  label: string;
  /** Rendered as `—` when null/undefined: unknown is stated, never faked as 0. */
  value: string | null | undefined;
}

export interface DirectoryShellProps {
  /** Mono eyebrow, e.g. "DIRECTORY · CONGRESSIONAL STAFF". */
  eyebrow: string;
  title: string;
  subtitle?: ReactNode;
  /** Premium Header / Metrics (954:3021). Omit where a surface has no metrics. */
  metrics?: readonly DirectoryMetric[];
  children: ReactNode;
}

/**
 * Chrome shared by every Directory vNext surface: the 112px white page header
 * with its slim accent orientation rail, the 40px route-tab band, and the body.
 *
 * The tab band is the information-architecture change from the handoff — the
 * four surfaces are peer routes, so they are links, not local tab state. That
 * also means back/forward and deep links behave like any other navigation.
 */
export function DirectoryShell({ eyebrow, title, subtitle, metrics, children }: DirectoryShellProps) {
  return (
    <>
      <header className="capiro-directory-header">
        <span className="capiro-directory-header__rail" aria-hidden="true" />
        <div className="capiro-directory-header__copy">
          <p className="capiro-directory-header__eyebrow">{eyebrow}</p>
          <h1 className="capiro-directory-header__title">{title}</h1>
          {subtitle ? <p className="capiro-directory-header__subtitle">{subtitle}</p> : null}
        </div>
        {metrics?.length ? (
          <div className="capiro-directory-header__metrics">
            {metrics.map((metric) => (
              <div className="capiro-directory-metric" key={metric.label}>
                <p className="capiro-directory-metric__label">{metric.label}</p>
                <p className="capiro-directory-metric__value">{metric.value ?? '—'}</p>
              </div>
            ))}
          </div>
        ) : null}
      </header>

      <nav className="capiro-directory-tabs" aria-label="Directory surfaces">
        {DIRECTORY_TABS.map((tab) => (
          <CapiroTopNavItem key={tab.id} label={tab.label} to={tab.path} />
        ))}
      </nav>

      <div className="capiro-directory-body">{children}</div>
    </>
  );
}
