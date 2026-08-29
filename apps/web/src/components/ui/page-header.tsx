/**
 * PageHeader and SectionHeading.
 *
 * One `h1` per screen, here, so heading levels stay in order across forty screens — a document
 * that jumps from `h1` to `h3` is navigable but confusing to anyone moving by heading, which is
 * how most screen-reader users navigate a long admin page.
 *
 * Server-compatible: no hooks.
 */

import Link from 'next/link';
import { cn } from '@/lib/cn';

export interface Crumb {
  label: string;
  /** Omit on the current page — the last crumb is not a link. */
  href?: string;
}

export function PageHeader({
  title,
  titleBn,
  description,
  breadcrumbs,
  actions,
  meta,
  className,
}: {
  title: React.ReactNode;
  /** The Bangla form of the same name, where the API provides one (rule 10). */
  titleBn?: string | null;
  description?: React.ReactNode;
  breadcrumbs?: Crumb[];
  /** Buttons. Render these behind a permission check — see `Can` in `@/lib/session`. */
  actions?: React.ReactNode;
  /** A row of small facts under the title: a code, a status badge, a date. */
  meta?: React.ReactNode;
  className?: string;
}) {
  return (
    <header className={cn('mb-5', className)}>
      {breadcrumbs && breadcrumbs.length > 0 ? (
        <nav aria-label="Breadcrumb" className="mb-2">
          <ol className="flex flex-wrap items-center gap-1.5 text-sm text-content-muted">
            {breadcrumbs.map((crumb, index) => (
              <li key={`${crumb.label}-${index}`} className="flex items-center gap-1.5">
                {index > 0 ? (
                  <span aria-hidden="true" className="text-content-subtle">
                    /
                  </span>
                ) : null}
                {crumb.href ? (
                  <Link href={crumb.href} className="text-accent-700 hover:underline">
                    {crumb.label}
                  </Link>
                ) : (
                  <span aria-current="page">{crumb.label}</span>
                )}
              </li>
            ))}
          </ol>
        </nav>
      ) : null}

      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
          {titleBn ? (
            // `lang="bn"` is not decoration: it selects the Bengali font stack and the taller
            // line height defined in globals.css, and tells a screen reader to switch voice.
            <p lang="bn" className="mt-0.5 text-lg text-content-muted">
              {titleBn}
            </p>
          ) : null}
          {description ? (
            <p className="mt-1 max-w-2xl text-sm text-content-muted">{description}</p>
          ) : null}
          {meta ? (
            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-sm text-content-muted">
              {meta}
            </div>
          ) : null}
        </div>
        {actions ? <div className="flex shrink-0 flex-wrap gap-2">{actions}</div> : null}
      </div>
    </header>
  );
}

export function SectionHeading({
  title,
  description,
  actions,
  level = 'h2',
  className,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  level?: 'h2' | 'h3';
  className?: string;
}) {
  const Heading = level;
  return (
    <div className={cn('mb-3 flex flex-wrap items-end justify-between gap-3', className)}>
      <div className="min-w-0">
        <Heading
          className={cn(
            'font-semibold tracking-tight',
            level === 'h2' ? 'text-lg' : 'text-base',
          )}
        >
          {title}
        </Heading>
        {description ? (
          <p className="mt-0.5 text-sm text-content-muted">{description}</p>
        ) : null}
      </div>
      {actions ? <div className="flex shrink-0 gap-2">{actions}</div> : null}
    </div>
  );
}
