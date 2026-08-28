'use client';

/**
 * Student roll.
 *
 * The table is the piece of this product staff spend the most time in, so the details matter:
 *
 *  - **Search is debounced** and drives a server query. Filtering 10,000 rows in the browser
 *    would mean shipping 10,000 rows, which is both slow and a data-minimisation failure.
 *  - **Below `sm` the table becomes a card list.** A horizontally-scrolling table on a phone is
 *    technically responsive and practically unusable, and teachers do this on phones.
 *  - **Page size is bounded by the API**, not chosen here, so a crafted URL cannot ask for the
 *    whole roll in one response.
 */

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useSession } from '@/lib/session';
import { EmptyState } from '@/components/empty-state';
import { ErrorNotice } from '@/components/error-notice';
import { StatusBadge } from '@/components/status-badge';
import { cn } from '@/lib/cn';

const PAGE_SIZE = 25;

export default function StudentsPage() {
  const session = useSession();
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);

  // 300ms: long enough that a normal typing burst is one request, short enough that the result
  // feels immediate. Anything above ~400ms reads as lag.
  useEffect(() => {
    const timer = setTimeout(() => {
      setSearch(searchInput.trim());
      setPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [searchInput]);

  const students = useQuery({
    queryKey: ['students', { page, search, institutionId: session.institutionId }],
    queryFn: () =>
      api.students({
        page,
        pageSize: PAGE_SIZE,
        q: search || undefined,
        institutionId: session.institutionId,
      }),
    // Keeps the previous page visible while the next loads, so the table does not collapse to
    // a spinner and bounce the scroll position on every page change.
    placeholderData: keepPreviousData,
  });

  const rows = students.data?.data ?? [];
  const meta = students.data?.meta;

  return (
    <div className="mx-auto max-w-6xl">
      <header className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Students</h1>
          <p className="mt-1 text-sm text-content-muted">
            {meta
              ? `${meta.total.toLocaleString('en-IN')} ${meta.total === 1 ? 'student' : 'students'}${
                  session.can('students.view.all') ? '' : ' in your sections'
                }`
              : 'Loading…'}
          </p>
        </div>
      </header>

      <div className="mb-4">
        <label htmlFor="student-search" className="sr-only">
          Search students by name, student ID or admission number
        </label>
        <input
          id="student-search"
          type="search"
          value={searchInput}
          onChange={(event) => setSearchInput(event.target.value)}
          placeholder="Search by name, student ID or admission number"
          className="input max-w-md"
        />
      </div>

      {students.isError ? <ErrorNotice error={students.error} /> : null}

      {students.isLoading ? (
        <TableSkeleton />
      ) : rows.length === 0 ? (
        <EmptyState
          title={search ? 'No students match that search' : 'No students yet'}
          description={
            search
              ? 'Try a shorter search, or check the spelling of the name.'
              : 'Once students are admitted they will appear here.'
          }
        />
      ) : (
        <>
          {/* Desktop and tablet: a table. */}
          <div className="card hidden overflow-hidden sm:block">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[40rem] text-sm">
                <caption className="sr-only">
                  Students, page {meta?.page} of {meta?.totalPages}
                </caption>
                <thead className="border-b border-line bg-surface-muted text-left">
                  <tr>
                    <th scope="col" className="px-4 py-2.5 font-medium text-content-muted">
                      Name
                    </th>
                    <th scope="col" className="px-4 py-2.5 font-medium text-content-muted">
                      Student ID
                    </th>
                    <th scope="col" className="px-4 py-2.5 font-medium text-content-muted">
                      Date of birth
                    </th>
                    <th scope="col" className="px-4 py-2.5 font-medium text-content-muted">
                      Status
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {rows.map((student) => (
                    <tr key={student.id} className="hover:bg-surface-muted">
                      <td className="px-4 py-2.5">
                        <Link
                          href={`/students/${student.id}`}
                          className="font-medium text-accent-700 hover:underline"
                        >
                          {student.fullNameEn}
                        </Link>
                        {student.fullNameBn ? (
                          <span lang="bn" className="ml-2 text-content-muted">
                            {student.fullNameBn}
                          </span>
                        ) : null}
                      </td>
                      <td className="px-4 py-2.5 font-mono text-xs text-content-muted">
                        {student.studentCode}
                      </td>
                      <td className="px-4 py-2.5 tabular-nums text-content-muted">
                        {formatDate(student.dateOfBirth)}
                      </td>
                      <td className="px-4 py-2.5">
                        <StatusBadge status={student.status} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Phone: cards, because a four-column table at 375px is not usable. */}
          <ul className="space-y-2 sm:hidden">
            {rows.map((student) => (
              <li key={student.id}>
                <Link href={`/students/${student.id}`} className="card block p-3.5">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate font-medium">{student.fullNameEn}</p>
                      {student.fullNameBn ? (
                        <p lang="bn" className="truncate text-sm text-content-muted">
                          {student.fullNameBn}
                        </p>
                      ) : null}
                      <p className="mt-1 font-mono text-xs text-content-subtle">
                        {student.studentCode}
                      </p>
                    </div>
                    <StatusBadge status={student.status} />
                  </div>
                </Link>
              </li>
            ))}
          </ul>

          {meta && meta.totalPages > 1 ? (
            <nav
              aria-label="Pagination"
              className="mt-4 flex items-center justify-between gap-3 text-sm"
            >
              <p className="text-content-muted">
                Page {meta.page} of {meta.totalPages}
              </p>
              <div className="flex gap-2">
                <button
                  type="button"
                  className="btn-secondary"
                  disabled={!meta.hasPrevious || students.isFetching}
                  onClick={() => setPage((current) => Math.max(1, current - 1))}
                >
                  Previous
                </button>
                <button
                  type="button"
                  className={cn('btn-secondary', students.isFetching && 'opacity-70')}
                  disabled={!meta.hasNext || students.isFetching}
                  onClick={() => setPage((current) => current + 1)}
                >
                  Next
                </button>
              </div>
            </nav>
          ) : null}
        </>
      )}
    </div>
  );
}

function TableSkeleton() {
  return (
    <div className="card divide-y divide-line" aria-busy="true" aria-label="Loading students">
      {Array.from({ length: 8 }).map((_, index) => (
        <div key={index} className="flex animate-pulse items-center gap-4 px-4 py-3">
          <div className="h-4 w-1/3 rounded bg-surface-muted" />
          <div className="h-4 w-24 rounded bg-surface-muted" />
          <div className="ml-auto h-4 w-16 rounded bg-surface-muted" />
        </div>
      ))}
    </div>
  );
}

/** Dates arrive as calendar dates (`YYYY-MM-DD`), so they are formatted without a timezone. */
function formatDate(value: string): string {
  const [year, month, day] = value.split('-');
  if (!year || !month || !day) return value;
  return `${day}/${month}/${year}`;
}
