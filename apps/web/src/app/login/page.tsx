'use client';

import { Suspense, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { loginSchema } from '@shikkha/validation';
import type { z } from 'zod';
import { api, ApiError } from '@/lib/api';
import { useSession } from '@/lib/session';
import { cn } from '@/lib/cn';

type LoginForm = z.infer<typeof loginSchema>;

/**
 * Sign-in.
 *
 * The schema is the same one the API validates against (`@shikkha/validation`), so the client
 * cannot accept a shape the server will reject — which is the whole point of sharing it.
 *
 * The identifier field takes an email address *or* a phone number, because a large share of
 * Bangladeshi parents have no email address at all. Making them invent one to receive their
 * child's attendance messages is the kind of small assumption that quietly excludes people.
 *
 * `useSearchParams` opts a component out of static prerendering, so the form lives in a
 * Suspense boundary and the page shell stays static — the shell renders immediately while the
 * part that depends on the URL waits.
 */
export default function LoginPage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-surface-muted px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <div className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-md bg-accent-600 text-lg font-semibold text-white">
            শি
          </div>
          <h1 className="text-2xl font-semibold tracking-tight text-content">ShikkhaOS</h1>
          <p className="mt-1 text-sm text-content-muted">Sign in to your school</p>
        </div>

        <Suspense fallback={<div className="card h-64 animate-pulse" aria-busy="true" />}>
          <LoginForm />
        </Suspense>

        {process.env.NEXT_PUBLIC_DEMO_HINTS === 'true' ? <DemoCredentials /> : null}
      </div>
    </main>
  );
}

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const session = useSession();
  const [formError, setFormError] = useState<string | null>(null);
  const [requestId, setRequestId] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<LoginForm>({
    resolver: zodResolver(loginSchema),
    defaultValues: { identifier: '', password: '' },
  });

  const onSubmit = handleSubmit(async (values) => {
    setFormError(null);
    setRequestId(null);
    try {
      await api.login(values.identifier, values.password);
      await session.refresh();
      // `next` comes from the middleware redirect. Only relative paths are followed — an
      // absolute URL here would be an open redirect straight out of a phishing email.
      const next = searchParams.get('next');
      router.push(next && next.startsWith('/') && !next.startsWith('//') ? next : '/dashboard');
    } catch (error) {
      if (error instanceof ApiError) {
        setRequestId(error.requestId ?? null);
        if (error.isValidation) {
          for (const [path, message] of Object.entries(error.fieldErrors())) {
            setError(path as keyof LoginForm, { message });
          }
          return;
        }
        setFormError(error.message);
        return;
      }
      setFormError('Could not reach the server. Check your connection and try again.');
    }
  });

  return (
    <form onSubmit={onSubmit} className="card space-y-4 p-6" noValidate>
      {formError ? (
        <div
          role="alert"
          className="rounded border border-danger/30 bg-danger-subtle px-3 py-2 text-sm text-danger"
        >
          <p>{formError}</p>
          {requestId ? (
            <p className="mt-1 font-mono text-xs opacity-75">Reference: {requestId}</p>
          ) : null}
        </div>
      ) : null}

      <div>
        <label htmlFor="identifier" className="label">
          Email or mobile number
        </label>
        <input
          id="identifier"
          type="text"
          autoComplete="username"
          inputMode="email"
          autoFocus
          placeholder="you@school.edu.bd or 01712-345678"
          aria-invalid={Boolean(errors.identifier)}
          aria-describedby={errors.identifier ? 'identifier-error' : undefined}
          className={cn('input mt-1.5', errors.identifier && 'input-error')}
          {...register('identifier')}
        />
        {errors.identifier ? (
          <p id="identifier-error" className="mt-1.5 text-xs text-danger">
            {errors.identifier.message}
          </p>
        ) : null}
      </div>

      <div>
        <label htmlFor="password" className="label">
          Password
        </label>
        <input
          id="password"
          type="password"
          autoComplete="current-password"
          aria-invalid={Boolean(errors.password)}
          aria-describedby={errors.password ? 'password-error' : undefined}
          className={cn('input mt-1.5', errors.password && 'input-error')}
          {...register('password')}
        />
        {errors.password ? (
          <p id="password-error" className="mt-1.5 text-xs text-danger">
            {errors.password.message}
          </p>
        ) : null}
      </div>

      <button type="submit" className="btn-primary w-full" disabled={isSubmitting}>
        {isSubmitting ? 'Signing in…' : 'Sign in'}
      </button>
    </form>
  );
}

/**
 * Seeded demo accounts, shown only when explicitly enabled.
 *
 * Gated on an environment variable rather than `NODE_ENV` so a staging deployment can turn it
 * off, and so it can never appear in production — the API's config check refuses to start with
 * the corresponding flag on.
 */
function DemoCredentials() {
  const accounts = [
    ['principal@dhakafuture.test', 'Principal — full academic authority'],
    ['teacher1@dhakafuture.test', 'Class teacher — sees only their own section'],
    ['accountant@dhakafuture.test', 'Accountant — fees, no marks'],
    ['parent1@dhakafuture.test', 'Guardian — sees only their own children'],
  ] as const;

  return (
    <div className="mt-6 rounded border border-line bg-surface p-4 text-sm">
      <p className="font-medium text-content">Demo accounts</p>
      <p className="mt-0.5 text-xs text-content-muted">
        Password for all: <code className="font-mono">ShikkhaDemo2026!</code>
      </p>
      <ul className="mt-3 space-y-1.5">
        {accounts.map(([email, description]) => (
          <li key={email} className="text-xs">
            <code className="font-mono text-content">{email}</code>
            <span className="ml-1.5 text-content-subtle">{description}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
