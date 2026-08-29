import { ToastProvider } from '@/components/ui';

/**
 * Toast host for the examination screens.
 *
 * `useToast` throws without a provider above it, and at the time these screens were written
 * `app/layout.tsx` did not mount one — that file belongs to the shell, and adding a provider
 * there from here would collide with whoever owns it. Mounting it at the top of this route
 * group is the smallest correct fix: the toasts these screens raise ("42 marks saved",
 * "Results published for 312 students") are exactly the kind of thing a provider is for, and
 * if a root provider appears later this one simply becomes the nearer of two, which is
 * harmless.
 */
export default function ExamsLayout({ children }: { children: React.ReactNode }) {
  return <ToastProvider>{children}</ToastProvider>;
}
