import { cn } from './cn.js';

// Handover §5.1: "Avatar (NM), staffer initials → Avatar (initials
// variant)." The app header's NM avatar (36px, accent-tint + accent-border)
// is out of scope (AppShell.tsx isn't touched by this migration) — this is
// for in-wizard uses: the Meri mark (26px, navy gradient) and any staffer
// initials shown at 36px.
interface Props {
  /** 1-2 letters, already uppercased by the caller. */
  initials: string;
  size?: number;
  tone?: 'tint' | 'navy';
  className?: string;
}

export function Avatar({ initials, size = 36, tone = 'tint', className = '' }: Props) {
  const toneClass =
    tone === 'navy'
      ? 'bg-linear-to-br from-accent-hover to-accent text-white'
      : 'bg-accent-tint text-accent-ink border border-accent-border';
  return (
    <span
      className={cn('inline-flex flex-none items-center justify-center rounded-full font-semibold', toneClass, className)}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.38) }}
    >
      {initials}
    </span>
  );
}
