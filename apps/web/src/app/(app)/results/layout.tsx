import { ToastProvider } from '@/components/ui';

/**
 * Toast host for the result screens — see `app/(app)/exams/layout.tsx` for why it is mounted
 * per route group rather than at the root.
 */
export default function ResultsLayout({ children }: { children: React.ReactNode }) {
  return <ToastProvider>{children}</ToastProvider>;
}
