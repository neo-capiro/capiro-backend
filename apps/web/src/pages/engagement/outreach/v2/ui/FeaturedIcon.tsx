import type { ComponentType } from 'react';
import { cn } from './cn.js';

// Handover §5.1: "Preflight pass / review marks → FeaturedIcon size sm,
// color success / warning." Also used more generally as the small tinted
// icon tile in panel headers (handover §6.7's Users01/User01 tiles) — those
// call sites use color="brand"/"gray" instead.
type Color = 'gray' | 'brand' | 'success' | 'warning';
type Size = 'sm' | 'md' | 'lg';

const COLOR_CLASS: Record<Color, string> = {
  gray: 'bg-neutral-bg text-neutral-ink',
  brand: 'bg-accent-tint text-accent-ink',
  success: 'bg-success-bg text-success',
  warning: 'bg-warning-bg text-warning-heading',
};

// Geometry §4: icon tile 38 / 30 / 26 / 22 — sm/md/lg cover the three sizes
// this component is actually used at; the 22px case is rare enough to take
// an arbitrary className override at the call site instead of a 4th variant.
const SIZE_CLASS: Record<Size, { box: string; icon: number }> = {
  sm: { box: 'h-[26px] w-[26px] rounded-[7px]', icon: 14 },
  md: { box: 'h-[30px] w-[30px] rounded-[8px]', icon: 16 },
  lg: { box: 'h-[38px] w-[38px] rounded-md', icon: 18 },
};

interface Props {
  icon: ComponentType<{ size?: number | string; className?: string }>;
  color?: Color;
  size?: Size;
  className?: string;
}

export function FeaturedIcon({ icon: IconCmp, color = 'gray', size = 'sm', className = '' }: Props) {
  const { box, icon } = SIZE_CLASS[size];
  return (
    <span
      className={cn('inline-flex flex-none items-center justify-center', box, COLOR_CLASS[color], className)}
    >
      <IconCmp size={icon} />
    </span>
  );
}
