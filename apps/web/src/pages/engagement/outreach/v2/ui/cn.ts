import { twMerge } from 'tailwind-merge';

// Plain string concatenation (`${base} ${className}`) does NOT make a
// caller-supplied className reliably override a conflicting base class —
// Tailwind resolves same-specificity conflicts by CSS source order, not by
// position in the className string, so e.g. base `bg-accent-tint` fighting
// an override `bg-surface` could silently keep whichever was compiled first.
// twMerge dedupes same-slot utilities, keeping the LAST one — use this
// anywhere a component's own classes and a caller override can collide.
export function cn(...classes: Array<string | false | null | undefined>): string {
  return twMerge(classes.filter(Boolean).join(' '));
}
