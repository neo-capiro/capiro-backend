/**
 * Data Explorer vNext — drill-in presentation atoms (section + key/value row).
 * Mirrors the canonical `DrillSection`/`DrillKV` structure on vNext classes.
 */
import type { ReactNode } from 'react';

export function DrillSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="xp-drill-section">
      <h3 className="xp-drill-section__title">{title}</h3>
      {children}
    </section>
  );
}

export function DrillKV({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="xp-drill-kv">
      <span className="xp-drill-kv__k">{label}</span>
      <span className="xp-drill-kv__v">{value}</span>
    </div>
  );
}
