import Link from 'next/link';

/**
 * A single figure.
 *
 * `value: null` means loading rather than zero — rendering "0" while a request is in flight
 * tells an administrator their school has no students, which is alarming and wrong.
 */
export function StatCard({
  label,
  value,
  detail,
  href,
}: {
  label: string;
  value: number | null;
  detail?: string;
  href?: string;
}) {
  const content = (
    <>
      <p className="text-sm text-content-muted">{label}</p>
      {value === null ? (
        <div
          className="mt-1.5 h-8 w-20 animate-pulse rounded bg-surface-muted"
          aria-hidden="true"
        />
      ) : (
        <p className="mt-1 text-3xl font-semibold tabular-nums tracking-tight">
          {/* en-IN grouping: 12,34,567 rather than 1,234,567, which is how numbers are read here. */}
          {value.toLocaleString('en-IN')}
        </p>
      )}
      {detail ? <p className="mt-1 text-xs text-content-subtle">{detail}</p> : null}
    </>
  );

  if (href) {
    return (
      <Link href={href} className="card p-4 transition-shadow hover:shadow-popover">
        {content}
      </Link>
    );
  }
  return <div className="card p-4">{content}</div>;
}
