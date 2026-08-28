'use client';

/**
 * Academic structure.
 *
 * Read-only for now: it shows the configured years and sections with live enrolment. The write
 * paths exist in the API and are permission-gated, but shipping a half-wired editing UI would
 * violate the "no placeholder features" rule, so the buttons are absent rather than inert.
 */

import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useSession } from '@/lib/session';
import { EmptyState } from '@/components/empty-state';
import { ErrorNotice } from '@/components/error-notice';

export default function AcademicPage() {
  const session = useSession();
  const institutionId = session.institutionId;

  const years = useQuery({
    queryKey: ['academic-years', institutionId],
    queryFn: () => api.academicYears(institutionId!),
    enabled: Boolean(institutionId),
  });

  const currentYear = years.data?.find((year) => year.isCurrent);

  const sections = useQuery({
    queryKey: ['sections', institutionId, currentYear?.id],
    queryFn: () => api.sections(institutionId!, currentYear?.id),
    enabled: Boolean(institutionId),
  });

  if (!institutionId) {
    return (
      <div className="mx-auto max-w-4xl">
        <h1 className="mb-5 text-2xl font-semibold tracking-tight">Academic structure</h1>
        <EmptyState
          title="Choose an institution"
          description="Your account has access to more than one institution. Academic structure is configured per institution, so pick one to continue."
        />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl">
      <h1 className="mb-5 text-2xl font-semibold tracking-tight">Academic structure</h1>

      {years.isError ? <ErrorNotice error={years.error} /> : null}

      <section className="mb-6">
        <h2 className="mb-3 text-lg font-semibold">Academic years</h2>
        {years.isLoading ? (
          <div className="card h-24 animate-pulse" aria-busy="true" />
        ) : years.data && years.data.length > 0 ? (
          <ul className="space-y-2">
            {years.data.map((year) => (
              <li key={year.id} className="card flex items-center justify-between px-4 py-3">
                <div>
                  <span className="font-medium">{year.name}</span>
                  <span className="ml-2 text-sm text-content-muted">{year.status}</span>
                </div>
                {year.isCurrent ? (
                  <span className="badge bg-accent-50 text-accent-800">Current</span>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState
            title="No academic years configured"
            description="An academic year defines the enrolment period, terms and calendar. One must exist before students can be enrolled."
          />
        )}
      </section>

      <section>
        <h2 className="mb-3 text-lg font-semibold">
          Sections{currentYear ? ` — ${currentYear.name}` : ''}
        </h2>
        {sections.isError ? <ErrorNotice error={sections.error} /> : null}
        {sections.isLoading ? (
          <div className="card h-40 animate-pulse" aria-busy="true" />
        ) : sections.data && sections.data.length > 0 ? (
          <div className="card overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[30rem] text-sm">
                <thead className="border-b border-line bg-surface-muted text-left">
                  <tr>
                    <th scope="col" className="px-4 py-2.5 font-medium text-content-muted">
                      Class
                    </th>
                    <th scope="col" className="px-4 py-2.5 font-medium text-content-muted">
                      Section
                    </th>
                    <th
                      scope="col"
                      className="px-4 py-2.5 text-right font-medium text-content-muted"
                    >
                      Enrolled
                    </th>
                    <th
                      scope="col"
                      className="px-4 py-2.5 text-right font-medium text-content-muted"
                    >
                      Capacity
                    </th>
                    <th
                      scope="col"
                      className="px-4 py-2.5 text-right font-medium text-content-muted"
                    >
                      Filled
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {[...sections.data]
                    .sort(
                      (a, b) =>
                        a.classLevelOrdinal - b.classLevelOrdinal ||
                        a.nameEn.localeCompare(b.nameEn),
                    )
                    .map((section) => {
                      const utilisation =
                        section.capacity && section.capacity > 0
                          ? Math.round((section.enrolledCount / section.capacity) * 100)
                          : null;
                      return (
                        <tr key={section.id} className="hover:bg-surface-muted">
                          <td className="px-4 py-2.5">{section.classLevelName}</td>
                          <td className="px-4 py-2.5">{section.nameEn}</td>
                          <td className="px-4 py-2.5 text-right tabular-nums">
                            {section.enrolledCount}
                          </td>
                          <td className="px-4 py-2.5 text-right tabular-nums text-content-muted">
                            {section.capacity ?? 'Not set'}
                          </td>
                          <td className="px-4 py-2.5 text-right tabular-nums">
                            {utilisation === null ? (
                              <span className="text-content-subtle">—</span>
                            ) : (
                              <span
                                className={
                                  utilisation > 100
                                    ? 'font-medium text-danger'
                                    : utilisation > 90
                                      ? 'font-medium text-warning'
                                      : 'text-content-muted'
                                }
                              >
                                {utilisation}%
                              </span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                </tbody>
              </table>
            </div>
          </div>
        ) : (
          <EmptyState
            title="No sections yet"
            description="Sections are the groups students are enrolled into and attendance is taken for."
          />
        )}
      </section>
    </div>
  );
}
