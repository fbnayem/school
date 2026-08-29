'use client';

/**
 * Application shell: navigation, header, and the authenticated boundary.
 *
 * The navigation is **derived from permissions, not from role names** (ADR-005). A section
 * appears when the user holds the permission its pages need, so a school that invents a custom
 * role gets a sensible menu without a code change.
 *
 * Mobile is not an afterthought here: the sidebar becomes a slide-over, and the teacher's
 * primary flow (dashboard → today's class → attendance → save) is reachable in the same number
 * of taps on a phone as on a desktop.
 */

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useSession } from '@/lib/session';
import { cn } from '@/lib/cn';

interface NavItem {
  href: string;
  label: string;
  /** Shown when the user holds any of these. Empty means always shown. */
  permissions: string[];
  icon: React.ReactNode;
}

interface NavSection {
  /** `null` for the first group, which carries no heading above the dashboard link. */
  heading: string | null;
  items: NavItem[];
}

/**
 * The menu, grouped, in the order a school actually works in: what you do today, then the
 * people, then the money, then the back office.
 *
 * A section appears only when the user holds one of its permissions, so this single list
 * produces a teacher's menu, a guardian's menu and an accountant's menu without a branch. It
 * is a usability rule and not a security one — every page behind it re-checks on the server,
 * and the API refuses regardless of what the menu chose to render.
 *
 * A link here must point at a page that exists. A menu entry for an unbuilt screen is the
 * placeholder this project does not ship: it looks like a feature and behaves like a 404.
 */
const NAV: NavSection[] = [
  {
    heading: null,
    items: [{ href: '/dashboard', label: 'Dashboard', permissions: [], icon: <IconHome /> }],
  },
  {
    heading: 'Teaching',
    items: [
      {
        href: '/attendance',
        label: 'Attendance',
        permissions: ['attendance.mark', 'attendance.view.all', 'attendance.view.assigned'],
        icon: <IconCheck />,
      },
      {
        href: '/exams',
        label: 'Examinations',
        permissions: ['exams.view', 'results.enter_marks', 'results.review'],
        icon: <IconClipboard />,
      },
      {
        href: '/results',
        label: 'Results',
        permissions: ['results.view.all', 'results.view.assigned', 'results.view.own'],
        icon: <IconChart />,
      },
      {
        href: '/timetable',
        label: 'Timetable',
        permissions: ['timetable.view', 'timetable.manage'],
        icon: <IconGrid />,
      },
    ],
  },
  {
    heading: 'People',
    items: [
      {
        href: '/students',
        label: 'Students',
        permissions: ['students.view.all', 'students.view.assigned'],
        icon: <IconUsers />,
      },
      {
        href: '/children',
        label: 'My children',
        permissions: ['students.view.own'],
        icon: <IconHeart />,
      },
      {
        href: '/admissions',
        label: 'Admissions',
        permissions: ['admissions.applications.view', 'admissions.applications.manage'],
        icon: <IconInbox />,
      },
      {
        href: '/hr',
        label: 'Staff',
        permissions: ['hr.employees.view'],
        icon: <IconBriefcase />,
      },
    ],
  },
  {
    heading: 'Finance',
    items: [
      {
        href: '/fees',
        label: 'Fees',
        permissions: ['finance.fees.view', 'finance.invoices.view', 'finance.collect_payment'],
        icon: <IconCoin />,
      },
      {
        href: '/accounting',
        label: 'Accounting',
        permissions: ['accounting.coa.view', 'accounting.journal.view', 'accounting.reports.view'],
        icon: <IconLedger />,
      },
    ],
  },
  {
    heading: 'Administration',
    items: [
      {
        href: '/approvals',
        label: 'Approvals',
        permissions: ['workflows.act', 'workflows.view'],
        icon: <IconStamp />,
      },
      {
        href: '/academic',
        label: 'Academic',
        permissions: ['academic.years.view', 'academic.classes.view'],
        icon: <IconBook />,
      },
      {
        href: '/audit',
        label: 'Audit log',
        permissions: ['audit.view'],
        icon: <IconShield />,
      },
    ],
  },
];

export function AppShell({ children }: { children: React.ReactNode }) {
  const session = useSession();
  const router = useRouter();
  const pathname = usePathname();
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  useEffect(() => {
    if (session.status === 'anonymous') {
      // Preserve where they were going so the login page can send them back.
      const next = encodeURIComponent(pathname);
      router.replace(`/login?next=${next}`);
    }
  }, [session.status, pathname, router]);

  // Close the slide-over on navigation; leaving it open over the new page is disorienting.
  useEffect(() => {
    setMobileNavOpen(false);
  }, [pathname]);

  if (session.status === 'loading') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-surface-muted">
        <div className="text-sm text-content-muted">Loading…</div>
      </div>
    );
  }

  if (session.status === 'anonymous') return null;

  // Filter items first, then drop any section left empty — otherwise a guardian gets a
  // "Finance" heading with nothing under it, which reads as a broken menu rather than as a
  // menu that correctly has nothing to show them.
  const visible: NavSection[] = NAV.map((section) => ({
    ...section,
    items: section.items.filter(
      (item) => item.permissions.length === 0 || session.canAny(...item.permissions),
    ),
  })).filter((section) => section.items.length > 0);

  return (
    <div className="min-h-screen bg-surface-muted">
      {/* Skip link: the first tab stop, so a keyboard user is not forced through the whole nav. */}
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded focus:bg-surface focus:px-3 focus:py-2 focus:text-sm focus:shadow-popover"
      >
        Skip to content
      </a>

      <header className="sticky top-0 z-30 border-b border-line bg-surface">
        <div className="flex h-14 items-center gap-3 px-4">
          <button
            type="button"
            className="btn-ghost -ml-1.5 px-2 lg:hidden"
            aria-label={mobileNavOpen ? 'Close navigation' : 'Open navigation'}
            aria-expanded={mobileNavOpen}
            onClick={() => setMobileNavOpen((open) => !open)}
          >
            <IconMenu />
          </button>

          <Link href="/dashboard" className="flex items-center gap-2">
            <span className="flex h-7 w-7 items-center justify-center rounded bg-accent-600 text-xs font-semibold text-white">
              শি
            </span>
            <span className="text-lg font-semibold tracking-tight">ShikkhaOS</span>
          </Link>

          <div className="ml-auto flex items-center gap-3">
            <span className="hidden text-sm text-content-muted sm:inline">
              {session.user?.fullNameEn}
            </span>
            <button type="button" className="btn-secondary text-sm" onClick={session.signOut}>
              Sign out
            </button>
          </div>
        </div>
      </header>

      <div className="flex">
        <Sidebar sections={visible} pathname={pathname} className="hidden lg:block" />

        {mobileNavOpen ? (
          <>
            <div
              className="fixed inset-0 z-40 bg-slate-900/40 lg:hidden"
              onClick={() => setMobileNavOpen(false)}
              aria-hidden="true"
            />
            <Sidebar
              sections={visible}
              pathname={pathname}
              className="fixed inset-y-0 left-0 z-50 w-64 pt-14 lg:hidden"
            />
          </>
        ) : null}

        <main id="main" className="min-w-0 flex-1 px-4 py-6 lg:px-8">
          {children}
        </main>
      </div>
    </div>
  );
}

function Sidebar({
  sections,
  pathname,
  className,
}: {
  sections: NavSection[];
  pathname: string;
  className?: string;
}) {
  return (
    <nav
      aria-label="Main"
      className={cn('w-56 shrink-0 overflow-y-auto border-r border-line bg-surface', className)}
    >
      <div className="space-y-4 p-3">
        {sections.map((section, index) => (
          <div key={section.heading ?? `section-${index}`}>
            {section.heading ? (
              // `aria-labelledby` on the list rather than a bare styled <div>, so a screen
              // reader announces "Finance, list, 2 items" the way the grouping reads visually.
              <h2
                id={`nav-${section.heading.toLowerCase()}`}
                className="px-2.5 pb-1 text-xs font-semibold uppercase tracking-wide text-content-subtle"
              >
                {section.heading}
              </h2>
            ) : null}
            <ul
              className="space-y-0.5"
              aria-labelledby={
                section.heading ? `nav-${section.heading.toLowerCase()}` : undefined
              }
            >
              {section.items.map((item) => {
                const active =
                  pathname === item.href || pathname.startsWith(`${item.href}/`);
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      aria-current={active ? 'page' : undefined}
                      className={cn(
                        'flex items-center gap-2.5 rounded px-2.5 py-2 text-base transition-colors',
                        active
                          ? 'bg-accent-50 font-medium text-accent-800'
                          : 'text-content-muted hover:bg-surface-muted hover:text-content',
                      )}
                    >
                      <span
                        className={cn(
                          'shrink-0',
                          active ? 'text-accent-600' : 'text-content-subtle',
                        )}
                      >
                        {item.icon}
                      </span>
                      {item.label}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>
    </nav>
  );
}

/*
 * Inline SVGs rather than an icon package.
 *
 * A dozen icons do not justify a dependency, a bundle, or a tree-shaking configuration — and
 * inlining keeps them styleable with `currentColor` so they follow the active state without a
 * second set of colour props.
 */
const iconProps = {
  width: 18,
  height: 18,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.75,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
};

function IconHome() {
  return (
    <svg {...iconProps}>
      <path d="M3 10.5 12 3l9 7.5" />
      <path d="M5 9.5V21h14V9.5" />
    </svg>
  );
}

function IconUsers() {
  return (
    <svg {...iconProps}>
      <circle cx="9" cy="8" r="3.25" />
      <path d="M2.5 20a6.5 6.5 0 0 1 13 0" />
      <path d="M16 5.5a3.25 3.25 0 0 1 0 6" />
      <path d="M18 14.5a6.5 6.5 0 0 1 3.5 5.5" />
    </svg>
  );
}

function IconHeart() {
  return (
    <svg {...iconProps}>
      <path d="M12 20s-7-4.5-7-9.5A3.5 3.5 0 0 1 12 8a3.5 3.5 0 0 1 7 2.5c0 5-7 9.5-7 9.5Z" />
    </svg>
  );
}

function IconBook() {
  return (
    <svg {...iconProps}>
      <path d="M4 4.5A1.5 1.5 0 0 1 5.5 3H19v18H5.5A1.5 1.5 0 0 1 4 19.5Z" />
      <path d="M4 17h15" />
    </svg>
  );
}

function IconShield() {
  return (
    <svg {...iconProps}>
      <path d="M12 3l7 3v5.5c0 4.5-3 8-7 9.5-4-1.5-7-5-7-9.5V6Z" />
      <path d="m9 12 2 2 4-4" />
    </svg>
  );
}

function IconCheck() {
  return (
    <svg {...iconProps}>
      <path d="M4 5.5A1.5 1.5 0 0 1 5.5 4h13A1.5 1.5 0 0 1 20 5.5v13a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18.5Z" />
      <path d="m8 12 3 3 5-6" />
    </svg>
  );
}

function IconClipboard() {
  return (
    <svg {...iconProps}>
      <path d="M9 4h6v3H9Z" />
      <path d="M9 5.5H6.5A1.5 1.5 0 0 0 5 7v12.5A1.5 1.5 0 0 0 6.5 21h11a1.5 1.5 0 0 0 1.5-1.5V7a1.5 1.5 0 0 0-1.5-1.5H15" />
      <path d="M9 12h6M9 16h4" />
    </svg>
  );
}

function IconChart() {
  return (
    <svg {...iconProps}>
      <path d="M4 20V4" />
      <path d="M4 20h16" />
      <path d="M8 17v-5M12 17V8M16 17v-7" />
    </svg>
  );
}

function IconInbox() {
  return (
    <svg {...iconProps}>
      <path d="M4 13 6.5 5h11L20 13v5.5A1.5 1.5 0 0 1 18.5 20h-13A1.5 1.5 0 0 1 4 18.5Z" />
      <path d="M4 13h4l1 2.5h6L16 13h4" />
    </svg>
  );
}

function IconCoin() {
  return (
    <svg {...iconProps}>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 7.5v9M14.5 10a2.5 2.5 0 0 0-5 0c0 2.5 5 1.5 5 4a2.5 2.5 0 0 1-5 0" />
    </svg>
  );
}

function IconLedger() {
  return (
    <svg {...iconProps}>
      <path d="M5 4.5A1.5 1.5 0 0 1 6.5 3H19v18H6.5A1.5 1.5 0 0 1 5 19.5Z" />
      <path d="M9 8h6M9 12h6M9 16h3" />
    </svg>
  );
}

function IconGrid() {
  return (
    <svg {...iconProps}>
      <path d="M4 5.5A1.5 1.5 0 0 1 5.5 4h13A1.5 1.5 0 0 1 20 5.5v13a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18.5Z" />
      <path d="M4 9.5h16M4 14.5h16M9.5 9.5V20M14.5 9.5V20" />
    </svg>
  );
}

function IconBriefcase() {
  return (
    <svg {...iconProps}>
      <path d="M4 9.5A1.5 1.5 0 0 1 5.5 8h13A1.5 1.5 0 0 1 20 9.5v8a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5Z" />
      <path d="M9 8V6.5A1.5 1.5 0 0 1 10.5 5h3A1.5 1.5 0 0 1 15 6.5V8" />
      <path d="M4 13h16" />
    </svg>
  );
}

function IconStamp() {
  return (
    <svg {...iconProps}>
      <path d="M9 9a3 3 0 1 1 6 0c0 2-1.5 2.5-1.5 4h-3C10.5 11.5 9 11 9 9Z" />
      <path d="M6 17h12v3H6Z" />
    </svg>
  );
}

function IconMenu() {
  return (
    <svg {...iconProps} width={20} height={20}>
      <path d="M4 7h16M4 12h16M4 17h16" />
    </svg>
  );
}
