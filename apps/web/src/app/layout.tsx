import type { Metadata, Viewport } from 'next';
import './globals.css';
import { SessionProvider } from '@/lib/session';
import { QueryProvider } from '@/lib/query';

export const metadata: Metadata = {
  title: { default: 'ShikkhaOS', template: '%s · ShikkhaOS' },
  description: 'School Operating System for Bangladesh',
  // The admin surface must never be indexed, even if a deployment is briefly public.
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  // Not `maximumScale: 1`: pinch-zoom is an accessibility need, and disabling it to stop iOS
  // zooming on focus is fixed properly by using a 16px input font instead.
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#ffffff' },
    { media: '(prefers-color-scheme: dark)', color: '#0f172a' },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <QueryProvider>
          <SessionProvider>{children}</SessionProvider>
        </QueryProvider>
      </body>
    </html>
  );
}
