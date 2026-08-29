'use client';

/**
 * "Which sections am I allowed to work with?"
 *
 * Every attendance screen needs the same three things — the current academic year, the sections
 * in it, and the subset of those sections the signed-in user actually has business with — and
 * getting the third one wrong is what produces a section list where two thirds of the rows
 * return 404 when you click them.
 *
 * The narrowing mirrors the API's own rule rather than guessing at it. `AttendanceService`
 * resolves the caller's data scope and, for `assigned`, matches the register's section against
 * `employee_section_assignments` or `employee_subject_assignments`. `GET /academic/assignments`
 * reads exactly those two tables and needs only `academic.sections.view`, which every teaching
 * role holds — unlike `/hr/employees`, which an academic coordinator does not. So a teacher gets
 * their own sections, and a holder of `attendance.view.all` gets all of them.
 *
 * This is a usability rule, not a security one: the API re-checks the assignment on every read
 * and every write, and returns 404 rather than 403 so an out-of-scope section id is not even
 * confirmed to exist.
 */

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSession } from '@/lib/session';
import { toOptions, type SelectOption } from '@/components/ui';
import { attendanceLookups, type SectionOption } from './api';

export interface AttendanceScope {
  institutionId: string | null;
  /** The academic year marked current by the API, or `null` while it loads. */
  currentYearId: string | null;
  sections: SectionOption[];
  sectionOptions: SelectOption[];
  /** True when the section list is the caller's assignments rather than the whole school. */
  isNarrowedToAssignments: boolean;
  isLoading: boolean;
  error: unknown;
}

export function useAttendanceScope(): AttendanceScope {
  const session = useSession();
  const institutionId = session.institutionId;
  const employeeId = session.user?.employeeId ?? null;

  // `attendance.view.all` is the permission the service resolves to the `all` data scope, so it
  // is the honest test for "may see every section's register".
  const seesEverySection = session.can('attendance.view.all');
  const narrows = !seesEverySection && employeeId !== null;

  const years = useQuery({
    queryKey: ['attendance', 'years', institutionId],
    queryFn: () => attendanceLookups.years(institutionId!),
    enabled: Boolean(institutionId),
  });

  const currentYearId = useMemo(
    () => years.data?.find((year) => year.isCurrent)?.id ?? null,
    [years.data],
  );

  const sections = useQuery({
    queryKey: ['attendance', 'sections', institutionId, currentYearId],
    queryFn: () => attendanceLookups.sections(institutionId!, currentYearId ?? undefined),
    enabled: Boolean(institutionId) && currentYearId !== null,
  });

  const assignments = useQuery({
    queryKey: ['attendance', 'assignments', institutionId, employeeId, currentYearId],
    queryFn: () =>
      attendanceLookups.myAssignments(institutionId!, employeeId!, currentYearId ?? undefined),
    enabled: narrows && Boolean(institutionId) && employeeId !== null && currentYearId !== null,
  });

  const scopedSections = useMemo<SectionOption[]>(() => {
    const all = sections.data ?? [];
    if (!narrows) return all;
    if (!assignments.data) return [];
    const mine = new Set<string>();
    for (const row of assignments.data.sectionAssignments) mine.add(row.sectionId);
    for (const row of assignments.data.subjectAssignments) mine.add(row.sectionId);
    return all.filter((section) => mine.has(section.id));
  }, [sections.data, assignments.data, narrows]);

  const sectionOptions = useMemo(
    () =>
      toOptions(scopedSections, (section) => ({
        value: section.id,
        label: `${section.classLevelName} — ${section.nameEn}`,
        // The Bangla name is appended by `Select` as " — <hint>", which is the only way a native
        // `<option>` can carry it; it still renders in the Bengali face from the font stack.
        hint: section.nameBn ?? undefined,
      })),
    [scopedSections],
  );

  return {
    institutionId,
    currentYearId,
    sections: scopedSections,
    sectionOptions,
    isNarrowedToAssignments: narrows,
    isLoading: years.isLoading || sections.isLoading || (narrows && assignments.isLoading),
    error: years.error ?? sections.error ?? assignments.error ?? null,
  };
}
