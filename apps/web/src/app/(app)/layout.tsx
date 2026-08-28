import { AppShell } from '@/components/app-shell';

/**
 * Every route in this group requires authentication. `AppShell` redirects to `/login` when the
 * session is anonymous — client-side, because the session lives in an httpOnly cookie the API
 * owns and the web app has no way to validate it without a round trip.
 */
export default function AppLayout({ children }: { children: React.ReactNode }) {
  return <AppShell>{children}</AppShell>;
}
