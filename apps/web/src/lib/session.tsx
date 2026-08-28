'use client';

/**
 * Session context.
 *
 * Holds the current user and their effective permission set, and exposes a `can()` helper the
 * UI uses to hide actions the caller cannot perform.
 *
 * The important thing to be clear about: **this is presentation only.** The permission list is
 * a hint for rendering, not a security boundary. Every action it gates is re-checked by the
 * API, so a user who edits this list in their devtools gets buttons that return 403. Treating
 * it as anything more is how client-side authorization bugs happen.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, ApiError, type CurrentUser } from './api';

interface SessionState {
  user: CurrentUser['user'] | null;
  roles: CurrentUser['roles'];
  permissions: Set<string>;
  status: 'loading' | 'authenticated' | 'anonymous';
  /** The institution the user is acting in. Sent as `x-institution-id` on scoped requests. */
  institutionId: string | null;
  setInstitutionId: (id: string | null) => void;
  can: (permission: string) => boolean;
  canAny: (...permissions: string[]) => boolean;
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
}

const SessionContext = createContext<SessionState | null>(null);

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [user, setUser] = useState<CurrentUser['user'] | null>(null);
  const [roles, setRoles] = useState<CurrentUser['roles']>([]);
  const [permissions, setPermissions] = useState<Set<string>>(new Set());
  const [status, setStatus] = useState<SessionState['status']>('loading');
  const [institutionId, setInstitutionIdState] = useState<string | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const me = await api.me({ signal });
      setUser(me.user);
      setRoles(me.roles);
      setPermissions(new Set(me.permissions));
      setStatus('authenticated');

      // Default to the user's only institution. With several, the user picks — guessing would
      // silently scope their work to the wrong school.
      const scoped = me.roles.flatMap((role) => role.institutionIds ?? []);
      const unique = [...new Set(scoped)];
      setInstitutionIdState((current) => current ?? (unique.length === 1 ? unique[0]! : null));
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      if (error instanceof ApiError && error.status === 401) {
        setStatus('anonymous');
        setUser(null);
        setPermissions(new Set());
        return;
      }
      // A network failure is not the same as "signed out" — showing the login page would lose
      // the user's place for what may be a two-second blip.
      setStatus('anonymous');
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const setInstitutionId = useCallback((id: string | null) => {
    setInstitutionIdState(id);
    // Remembered per browser so a group administrator does not re-pick on every page load.
    try {
      if (id) window.localStorage.setItem('shikkha.institution', id);
      else window.localStorage.removeItem('shikkha.institution');
    } catch {
      // Private mode, or storage disabled. The selection still works for this session.
    }
  }, []);

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem('shikkha.institution');
      if (stored) setInstitutionIdState((current) => current ?? stored);
    } catch {
      // Ignored, as above.
    }
  }, []);

  const signOut = useCallback(async () => {
    try {
      await api.logout();
    } catch {
      // Even if the call fails, the local session must end — the cookies may already be gone.
    }
    setUser(null);
    setRoles([]);
    setPermissions(new Set());
    setStatus('anonymous');
    router.push('/login');
  }, [router]);

  const value = useMemo<SessionState>(
    () => ({
      user,
      roles,
      permissions,
      status,
      institutionId,
      setInstitutionId,
      can: (permission) => permissions.has(permission),
      canAny: (...list) => list.some((permission) => permissions.has(permission)),
      refresh: () => load(),
      signOut,
    }),
    [user, roles, permissions, status, institutionId, setInstitutionId, load, signOut],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionState {
  const context = useContext(SessionContext);
  if (!context) {
    throw new Error('useSession must be used inside a SessionProvider');
  }
  return context;
}

/**
 * Render children only when the user holds the permission.
 *
 * A convenience for hiding buttons. It does not protect the endpoint behind the button — that
 * is the API's job, and it does it on every request.
 */
export function Can({
  permission,
  any,
  children,
  fallback = null,
}: {
  permission?: string;
  any?: string[];
  children: React.ReactNode;
  fallback?: React.ReactNode;
}) {
  const session = useSession();
  const allowed = permission ? session.can(permission) : any ? session.canAny(...any) : false;
  return <>{allowed ? children : fallback}</>;
}
