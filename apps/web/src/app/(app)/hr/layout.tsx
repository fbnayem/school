'use client';

/**
 * Toasts for the HR section.
 *
 * `useToast` throws without a provider above it, and the app tree does not mount one yet
 * (`app/layout.tsx` and `components/app-shell.tsx` belong to another owner this batch). One
 * provider per section keeps this screen working today; when a provider is added at the root,
 * this file can be deleted and nothing else changes — `useToast` resolves to the nearest.
 */

import { ToastProvider } from '@/components/ui';

export default function HrLayout({ children }: { children: React.ReactNode }) {
  return <ToastProvider>{children}</ToastProvider>;
}
