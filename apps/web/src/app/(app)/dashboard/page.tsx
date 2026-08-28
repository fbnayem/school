'use client';

/**
 * Dashboard.
 *
 * Shows the user what *they* can act on, which for this product means four genuinely different
 * dashboards behind one route: a guardian sees their children, a teacher sees their sections, an
 * administrator sees the roll, a principal sees the institution.
 *
 * Every figure here comes from a real API call scoped by the caller's permissions. The brief is
 * explicit that decorative charts with no operational purpose are worse than nothing, so this
 * shows counts people act on and nothing else.
 */

import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useSession } from '@/lib/session';
import { StatCard } from '@/components/stat-card';
import { EmptyState } from '@/components/empty-state';
import { ErrorNotice } from '@/components/error-notice';
import { StatusBadge } from '@/components/status-badge';

export default function DashboardPage() {
  const session = useSession();
  const isGuardian = session.can('students.view.own') && !session.can('students.view.all');
  const canSeeStudents = session.canAny('students.view.all', 'students.view.assigned');

  return (
    <div className="mx-auto max-w-6xl">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">
          {greeting()}, {session.user?.fullNameEn.split(' ')[0]}
        </h1>
        <p className="mt-1 text-sm text-content-muted">
          {session.roles.map((role) => humanizeRole(role.key)).join(' · ')}
        </p>
      </header>

      {isGuardian ? <GuardianDashboard /> : null}
      {canSeeStudents ? <StaffDashboard /> : null}
      {!isGuardian && !canSeeStudents ? (
        <EmptyState
          title="Nothing assigned yet"
          description="Your account is active but has no records associated with it. Ask your school administrator to complete your setup."
        />
      ) : null}
    </div>
  );
}

function GuardianDashboard() {
  const children = useQuery({ queryKey: ['my-children'], queryFn: api.myChildren });

  if (children.isError) return <ErrorNotice error={children.error} />;

  return (
    <section aria-labelledby="children-heading">
      <h2 id="children-heading" className="mb-3 text-lg font-semibold">
        Your children
      </h2>

      {children.isLoading ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <SkeletonCard />
          <SkeletonCard />
        </div>
      ) : children.data && children.data.length > 0 ? (
        <div className="grid gap-3 sm:grid-cols-2">
          {children.data.map((child) => (
            <div key={child.studentId} className="card p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate font-medium text-content">{child.fullNameEn}</p>
                  {child.fullNameBn ? (
                    <p lang="bn" className="truncate text-sm text-content-muted">
                      {child.fullNameBn}
                    </p>
                  ) : null}
                  <p className="mt-1.5 font-mono text-xs text-content-subtle">
                    {child.studentCode}
                  </p>
                </div>
                <StatusBadge status={child.status} />
              </div>
              <div className="mt-3 flex flex-wrap gap-1.5">
                <span className="badge bg-surface-muted text-content-muted">
                  {humanizeRelation(child.relation)}
                </span>
                {child.isBillingContact ? (
                  <span className="badge bg-info-subtle text-info">Billing contact</span>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <EmptyState
          title="No children linked"
          description="Your account is not yet linked to a student. Contact the school office."
        />
      )}
    </section>
  );
}

function StaffDashboard() {
  const session = useSession();

  const students = useQuery({
    queryKey: ['students', 'count', session.institutionId],
    queryFn: () => api.students({ pageSize: 1, institutionId: session.institutionId }),
  });

  const sections = useQuery({
    queryKey: ['sections', session.institutionId],
    queryFn: () => api.sections(session.institutionId!),
    // Sections are institution-scoped, so there is nothing to ask for until one is chosen.
    enabled: Boolean(session.institutionId) && session.can('academic.sections.view'),
  });

  if (students.isError) return <ErrorNotice error={students.error} />;

  const totalCapacity = sections.data?.reduce((sum, s) => sum + (s.capacity ?? 0), 0) ?? 0;
  const totalEnrolled = sections.data?.reduce((sum, s) => sum + s.enrolledCount, 0) ?? 0;
  const overCapacity =
    sections.data?.filter((s) => s.capacity !== null && s.enrolledCount > s.capacity) ?? [];

  return (
    <div className="space-y-6">
      <section aria-label="Key figures" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <StatCard
          label={session.can('students.view.all') ? 'Students' : 'Students in your sections'}
          value={students.isLoading ? null : (students.data?.meta.total ?? 0)}
          href="/students"
        />
        {sections.data ? (
          <>
            <StatCard label="Sections" value={sections.data.length} href="/academic" />
            <StatCard
              label="Seats filled"
              value={totalEnrolled}
              // Utilisation is the operationally useful number, not the raw seat count: it is
              // what tells an administrator whether to open another section.
              detail={
                totalCapacity > 0
                  ? `${Math.round((totalEnrolled / totalCapacity) * 100)}% of ${totalCapacity.toLocaleString('en-IN')} seats`
                  : undefined
              }
            />
          </>
        ) : null}
      </section>

      {overCapacity.length > 0 ? (
        <section className="rounded border border-warning/30 bg-warning-subtle px-4 py-3">
          <h2 className="text-sm font-medium text-warning">
            {overCapacity.length} section{overCapacity.length === 1 ? ' is' : 's are'} over capacity
          </h2>
          <ul className="mt-1.5 space-y-0.5 text-sm text-content-muted">
            {overCapacity.slice(0, 5).map((section) => (
              <li key={section.id}>
                {section.classLevelName} — {section.nameEn}: {section.enrolledCount} of{' '}
                {section.capacity}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {sections.data && sections.data.length > 0 ? (
        <section aria-labelledby="sections-heading">
          <h2 id="sections-heading" className="mb-3 text-lg font-semibold">
            Sections
          </h2>
          <div className="card overflow-hidden">
            {/* Horizontal scroll is contained here rather than on the page body, so the rest
                of the layout never shifts on a narrow screen. */}
            <div className="overflow-x-auto">
              <table className="w-full min-w-[32rem] text-sm">
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
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {[...sections.data]
                    .sort((a, b) => a.classLevelOrdinal - b.classLevelOrdinal)
                    .map((section) => (
                      <tr key={section.id} className="hover:bg-surface-muted">
                        <td className="px-4 py-2.5">{section.classLevelName}</td>
                        <td className="px-4 py-2.5">{section.nameEn}</td>
                        <td className="px-4 py-2.5 text-right tabular-nums">
                          {section.enrolledCount}
                        </td>
                        <td className="px-4 py-2.5 text-right tabular-nums text-content-muted">
                          {section.capacity ?? '—'}
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      ) : null}
    </div>
  );
}

function SkeletonCard() {
  return (
    <div className="card animate-pulse p-4" aria-hidden="true">
      <div className="h-4 w-2/3 rounded bg-surface-muted" />
      <div className="mt-2 h-3 w-1/3 rounded bg-surface-muted" />
    </div>
  );
}

function greeting(): string {
  // Dhaka local hour: the server may be anywhere, but the user is here.
  const hour = Number(
    new Intl.DateTimeFormat('en-GB', {
      hour: 'numeric',
      hour12: false,
      timeZone: 'Asia/Dhaka',
    }).format(new Date()),
  );
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

function humanizeRole(key: string): string {
  return key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function humanizeRelation(relation: string): string {
  return relation.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}
