import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * Merge class names, with later Tailwind utilities winning over earlier conflicting ones.
 *
 * `clsx` alone would leave both `px-3` and `px-6` in the output and let CSS source order
 * decide, which makes a component's `className` prop unreliable as an override.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
