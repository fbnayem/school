'use client';

/**
 * Student detail.
 *
 * Medical fields are rendered only when the API returned them — it nulls them for callers
 * without `students.medical.view` — so this component never has to know the permission rule.
 * The server decides; the UI reflects what it was given. Duplicating the check here would
 * create a second place for it to drift.
 */

import { use } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { ErrorNotice } from '@/components/error-notice';
import { StatusBadge } from '@/components/status-badge';

export default function StudentDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const student = useQuery({ queryKey: ['student', id], queryFn: () => api.student(id) });

  if (student.isError) {
    return (
      <div className="mx-auto max-w-3xl">
        <ErrorNotice error={student.error} />
        <Link href="/students" className="btn-secondary mt-4 inline-flex">
          Back to students
        </Link>
      </div>
    );
  }

  if (student.isLoading || !student.data) {
    return (
      <div className="mx-auto max-w-3xl">
        <div className="card h-64 animate-pulse" aria-busy="true" aria-label="Loading student" />
      </div>
    );
  }

  const s = student.data;
  const medical = (
    [
      ['Medical conditions', s['medicalConditions']],
      ['Allergies', s['allergies']],
      ['Special needs', s['specialNeeds']],
    ] as [string, unknown][]
  ).filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1] !== '');

  return (
    <div className="mx-auto max-w-3xl">
      <nav className="mb-4 text-sm">
        <Link href="/students" className="text-accent-700 hover:underline">
          Back to students
        </Link>
      </nav>

      <header className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{s.fullNameEn}</h1>
          {s.fullNameBn ? (
            <p lang="bn" className="mt-0.5 text-lg text-content-muted">
              {s.fullNameBn}
            </p>
          ) : null}
          <p className="mt-1.5 font-mono text-xs text-content-subtle">
            {s.studentCode} · Admission {s.admissionNumber}
          </p>
        </div>
        <StatusBadge status={s.status} />
      </header>

      <div className="space-y-4">
        <Section title="Personal">
          <Field label="Date of birth" value={formatDate(s.dateOfBirth)} />
          <Field label="Gender" value={titleCase(s.gender)} />
          <Field label="Blood group" value={asText(s['bloodGroup'])} />
          <Field label="Religion" value={titleCase(asText(s['religion']) ?? '')} />
          <Field label="Nationality" value={asText(s['nationality'])} />
        </Section>

        <Section title="Family">
          <Field label="Father" value={asText(s['fatherNameEn'])} />
          <Field label="Mother" value={asText(s['motherNameEn'])} />
          <Field label="Phone" value={s.phone} />
          <Field label="Address" value={asText(s['presentAddress'])} span />
        </Section>

        <Section title="Admission">
          <Field label="Admitted on" value={formatDate(s.admissionDate)} />
          <Field label="Previous institution" value={asText(s['previousInstitutionName'])} />
        </Section>

        {medical.length > 0 ? (
          <Section title="Medical" tone="sensitive">
            {medical.map(([label, value]) => (
              <Field key={label} label={label} value={value} span />
            ))}
          </Section>
        ) : null}
      </div>
    </div>
  );
}

function Section({
  title,
  children,
  tone,
}: {
  title: string;
  children: React.ReactNode;
  tone?: 'sensitive';
}) {
  return (
    <section className="card p-5">
      <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-content-muted">
        {title}
        {tone === 'sensitive' ? (
          // Visible marker: staff should know this section is restricted and its access logged.
          <span className="badge bg-warning-subtle text-warning">Restricted</span>
        ) : null}
      </h2>
      <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">{children}</dl>
    </section>
  );
}

function Field({
  label,
  value,
  span,
}: {
  label: string;
  value: string | null | undefined;
  span?: boolean;
}) {
  return (
    <div className={span ? 'sm:col-span-2' : undefined}>
      <dt className="text-xs text-content-subtle">{label}</dt>
      <dd className="mt-0.5 text-base text-content">
        {value ? value : <span className="text-content-subtle">Not recorded</span>}
      </dd>
    </div>
  );
}

function asText(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function formatDate(value: string | null | undefined): string {
  if (!value) return '';
  const [year, month, day] = value.split('-');
  return year && month && day ? `${day}/${month}/${year}` : value;
}

function titleCase(value: string): string {
  return value ? value.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) : '';
}
