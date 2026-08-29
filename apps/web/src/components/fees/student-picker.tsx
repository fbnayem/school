'use client';

/**
 * Pick the student a payment is being recorded against.
 *
 * A labelled search box over `GET /students` plus a list of real buttons, rather than a
 * combobox. A combobox is the richer pattern, but it is also the one that is most often shipped
 * half-implemented — and the consequence of picking the wrong row here is money credited to the
 * wrong family. A visible list of buttons, each announcing the student's code, is unambiguous
 * for a keyboard and a screen reader alike, and the chosen student stays on screen until it is
 * deliberately changed.
 *
 * The search is debounced and runs on the server: shipping the whole roll to the browser to
 * filter it would be slow and a data-minimisation failure on a table of children's records.
 */

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, type StudentSummary } from '@/lib/api';
import {
  Badge,
  BilingualName,
  Button,
  ErrorNotice,
  SearchInput,
  Spinner,
  useDebouncedValue,
} from '@/components/ui';
import { formatCount } from '@/lib/format';

export function StudentPicker({
  institutionId,
  value,
  onChange,
  inputId = 'student-search',
}: {
  institutionId: string;
  value: StudentSummary | null;
  onChange: (student: StudentSummary | null) => void;
  inputId?: string;
}) {
  const [term, setTerm] = useState('');
  const query = useDebouncedValue(term.trim());

  const results = useQuery({
    queryKey: ['student-search', institutionId, query],
    queryFn: () => api.students({ q: query, pageSize: 8, institutionId }),
    // Two characters is the point at which the result set stops being "the whole school".
    enabled: query.length >= 2,
  });

  if (value) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-3 rounded border border-line bg-surface-muted px-4 py-3">
        <div className="min-w-0">
          <BilingualName row={value} layout="stacked" className="font-medium" />
          <p className="mt-0.5 font-mono text-xs text-content-subtle">{value.studentCode}</p>
        </div>
        <div className="flex items-center gap-2">
          <Badge tone={value.status === 'active' ? 'success' : 'warning'}>{value.status}</Badge>
          <Button size="sm" onClick={() => onChange(null)}>
            Change student
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <label htmlFor={inputId} className="label">
        Student
      </label>
      <SearchInput
        id={inputId}
        value={term}
        onChange={(event) => setTerm(event.target.value)}
        onClear={() => setTerm('')}
        placeholder="Search by name, student ID or admission number"
        autoComplete="off"
      />

      {results.isError ? <ErrorNotice error={results.error} /> : null}

      <p aria-live="polite" className="text-xs text-content-muted">
        {query.length < 2
          ? 'Type at least two characters to search.'
          : results.isFetching
            ? 'Searching…'
            : formatCount(results.data?.data.length ?? 0, 'student') + ' found'}
      </p>

      {results.isFetching && !results.data ? (
        <div className="flex items-center gap-2 px-1 py-2 text-sm text-content-muted">
          <Spinner size="sm" />
          Looking up students
        </div>
      ) : null}

      {results.data && results.data.data.length > 0 ? (
        <ul className="divide-y divide-line overflow-hidden rounded border border-line">
          {results.data.data.map((student) => (
            <li key={student.id}>
              <button
                type="button"
                onClick={() => onChange(student)}
                className="flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left hover:bg-surface-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-600"
              >
                <span className="min-w-0">
                  <BilingualName row={student} layout="stacked" />
                </span>
                <span className="shrink-0 font-mono text-xs text-content-subtle">
                  {student.studentCode}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
