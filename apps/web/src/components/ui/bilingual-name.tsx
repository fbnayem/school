/**
 * BilingualName.
 *
 * The data model is bilingual: rows carry `nameBn` alongside `nameEn` (or `fullNameBn`, or
 * `titleBn`, depending on the module). Where the API gave us a Bangla name, it gets rendered —
 * for most of this product's users it is the name they actually recognise.
 *
 * The `lang="bn"` attribute is doing real work and is the reason this is a component rather
 * than string concatenation:
 *
 *  - it selects the Bengali font stack from `tailwind.config.ts` and the taller line height
 *    `globals.css` sets for `:lang(bn)` — Bengali conjuncts are clipped at Latin line height;
 *  - it tells a screen reader to switch to a Bengali voice, instead of reading Bangla script
 *    with English phonetics, which is unintelligible.
 *
 * Server-compatible: no hooks.
 */

import { pickBilingual, type Bilingual } from '@/lib/format';
import { cn } from '@/lib/cn';

export function BilingualName({
  row,
  /** `stacked` puts the Bangla name on its own line — right for cards and detail headers. */
  layout = 'inline',
  className,
  bnClassName,
}: {
  row: Bilingual;
  layout?: 'inline' | 'stacked';
  className?: string;
  bnClassName?: string;
}) {
  const { en, bn } = pickBilingual(row);

  if (!bn) return <span className={className}>{en}</span>;

  if (layout === 'stacked') {
    return (
      <span className={cn('block', className)}>
        <span className="block truncate">{en}</span>
        <span lang="bn" className={cn('block truncate text-content-muted', bnClassName)}>
          {bn}
        </span>
      </span>
    );
  }

  return (
    <span className={className}>
      {en}
      <span lang="bn" className={cn('ml-2 text-content-muted', bnClassName)}>
        {bn}
      </span>
    </span>
  );
}
