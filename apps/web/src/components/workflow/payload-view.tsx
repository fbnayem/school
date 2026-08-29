'use client';

/**
 * Renders a workflow request's `payload`.
 *
 * The payload is jsonb the *owning* module wrote — an expense claim's amount, a leave
 * request's dates, an attendance correction's before and after. The engine treats it as
 * opaque, and so does this component: there is no per-entity-type layout here, because a
 * layout keyed on `entityType` would silently render nothing the day a new module starts
 * routing something new through the engine.
 *
 * What it does instead is show every key it was given, once, honestly:
 *  - scalars become a labelled row;
 *  - objects and arrays are shown as formatted JSON in a scrollable block, because collapsing
 *    a nested structure into "3 items" hides exactly the detail an approver is deciding on.
 *
 * Nothing is inferred. A value that looks like a number is not formatted as money — the engine
 * does not say it is money, and a taka sign we invented on a leave-day count would be a lie.
 */

import { humanize } from '@/lib/format';
import { DescriptionList, type DescriptionItem } from '@/components/ui';

function isScalar(value: unknown): value is string | number | boolean {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

/**
 * Payload keys come from whichever module wrote them, so both `amount_due` and `amountDue`
 * turn up. `humanize` handles the snake case; the split handles the camel case first, rather
 * than rendering "Amountdue".
 */
function label(key: string): string {
  return humanize(key.replace(/([a-z0-9])([A-Z])/g, '$1 $2'));
}

export function PayloadView({ payload }: { payload: Record<string, unknown> }) {
  const entries = Object.entries(payload);

  if (entries.length === 0) {
    return (
      <p className="text-sm text-content-muted">
        The module that raised this request attached no extra detail beyond the summary above.
      </p>
    );
  }

  const scalars: DescriptionItem[] = [];
  const structured: Array<[string, unknown]> = [];

  for (const [key, value] of entries) {
    if (value === null || value === undefined) {
      scalars.push({ label: label(key), value: null });
    } else if (isScalar(value)) {
      scalars.push({
        label: label(key),
        // Booleans render as words: a bare "true" in a decision record reads as a typo.
        value: typeof value === 'boolean' ? (value ? 'Yes' : 'No') : String(value),
      });
    } else {
      structured.push([key, value]);
    }
  }

  return (
    <div className="space-y-4">
      {scalars.length > 0 ? <DescriptionList items={scalars} /> : null}

      {structured.map(([key, value]) => (
        <div key={key}>
          <p className="mb-1 text-xs text-content-subtle">{label(key)}</p>
          {/* `overflow-x-auto` on the block, never on the page: a wide payload must not make
              the whole screen scroll sideways on a phone. */}
          <pre className="max-h-64 overflow-auto rounded-md border border-line bg-surface-muted p-3 text-xs text-content-muted">
            {JSON.stringify(value, null, 2)}
          </pre>
        </div>
      ))}
    </div>
  );
}
