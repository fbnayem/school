/**
 * Card, and its header/body/footer parts.
 *
 * A thin wrapper over the `.card` class in `globals.css` — the border, radius and shadow are
 * defined there once, next to the rest of the design system, so a card here and a card written
 * by hand on a page look identical.
 *
 * Server-compatible: no hooks.
 */

import { cn } from '@/lib/cn';

export function Card({
  children,
  className,
  /** Turn off when the card holds a table or a list that must reach the edges. */
  padded = false,
  as: Component = 'div',
}: {
  children: React.ReactNode;
  className?: string;
  padded?: boolean;
  as?: 'div' | 'section' | 'article' | 'li';
}) {
  return (
    <Component className={cn('card', padded && 'p-4 sm:p-5', className)}>{children}</Component>
  );
}

export function CardHeader({
  title,
  description,
  actions,
  className,
  /** `h3` inside a page section, `h2` when the card is the section. Never skip a level. */
  headingLevel = 'h2',
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
  headingLevel?: 'h2' | 'h3' | 'h4';
}) {
  const Heading = headingLevel;
  return (
    <div
      className={cn(
        'flex flex-wrap items-start justify-between gap-3 border-b border-line px-4 py-3 sm:px-5',
        className,
      )}
    >
      <div className="min-w-0">
        <Heading className="text-base font-semibold tracking-tight">{title}</Heading>
        {description ? (
          <p className="mt-0.5 text-sm text-content-muted">{description}</p>
        ) : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export function CardBody({
  children,
  className,
  padded = true,
}: {
  children: React.ReactNode;
  className?: string;
  padded?: boolean;
}) {
  return <div className={cn(padded && 'px-4 py-4 sm:px-5', className)}>{children}</div>;
}

export function CardFooter({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex flex-wrap items-center justify-end gap-2 border-t border-line bg-surface-muted px-4 py-3 sm:px-5',
        className,
      )}
    >
      {children}
    </div>
  );
}
