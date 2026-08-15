import type { HTMLAttributes } from 'react';

export type CapiroSurfaceProps = HTMLAttributes<HTMLElement> & {
  as?: 'section' | 'div' | 'article';
  elevated?: boolean;
};

export function CapiroSurface({ as: Tag = 'section', elevated = false, className = '', ...props }: CapiroSurfaceProps) {
  return (
    <Tag
      className={`capiro-surface${elevated ? ' capiro-elevation-widget' : ''} ${className}`.trim()}
      {...props}
    />
  );
}

export function CapiroCard({ className = '', elevated = true, ...props }: CapiroSurfaceProps) {
  return <CapiroSurface className={`capiro-card ${className}`.trim()} elevated={elevated} {...props} />;
}
