/**
 * Empty state.
 *
 * Always says what to do next. "No results" on its own leaves the user guessing whether the
 * filter is wrong, the data is missing, or they lack permission.
 */
export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="card flex flex-col items-center px-6 py-12 text-center">
      <p className="font-medium text-content">{title}</p>
      <p className="mt-1 max-w-sm text-sm text-content-muted">{description}</p>
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}
