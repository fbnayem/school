'use client';

/**
 * Fees home: the invoice register, the fee-head catalogue and the fee plans.
 *
 * The three panels answer three different jobs and are permissioned differently — the invoice
 * register is `finance.invoices.view` (or a guardian's `finance.own.view`), the catalogue and
 * the plans are `finance.fees.view` — so the tab strip is built from what the user actually
 * holds. A tab that 403s when you click it is worse than a tab that is not there.
 *
 * `activation="manual"` matters here: each panel fires its own query, and with automatic
 * activation arrowing across the strip would fire all three.
 */

import { useState } from 'react';
import { useSession } from '@/lib/session';
import {
  Button,
  EmptyState,
  PageHeader,
  Tab,
  TabList,
  TabPanel,
  Tabs,
} from '@/components/ui';
import { FeeHeadList } from '@/components/fees/fee-head-list';
import { FeePlanList } from '@/components/fees/fee-plan-list';
import { InvoiceList } from '@/components/fees/invoice-list';

export default function FeesPage() {
  const session = useSession();
  // Guaranteed by the area layout, which refuses to render without an institution scope.
  const institutionId = session.institutionId!;

  const canSeeInvoices = session.canAny('finance.invoices.view', 'finance.own.view');
  const canSeeCatalogue = session.can('finance.fees.view');

  const tabs = [
    ...(canSeeInvoices ? [{ value: 'invoices', label: 'Invoices' }] : []),
    ...(canSeeCatalogue ? [{ value: 'heads', label: 'Fee heads' }] : []),
    ...(canSeeCatalogue ? [{ value: 'plans', label: 'Fee plans' }] : []),
  ];

  const [tab, setTab] = useState(tabs[0]?.value ?? 'invoices');

  const canViewAcademicYears = session.can('academic.years.view');
  const canViewClassLevels = session.can('academic.classes.view');

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title="Fees"
        description="Invoices, the charges they are built from, and the price lists a billing run reads."
        actions={
          <>
            {/* Each action is hidden unless the permission its screen needs is held. The API
                re-checks all of them; this is about not offering a door that does not open. */}
            {session.can('finance.collect_payment') ? (
              <Button variant="primary" href="/fees/collect">
                Collect payment
              </Button>
            ) : null}
            {session.can('finance.invoices.generate') ? (
              <Button href="/fees/generate">Generate invoices</Button>
            ) : null}
            {session.can('finance.reports.view') ? <Button href="/fees/dues">Dues report</Button> : null}
          </>
        }
      />

      {tabs.length === 0 ? (
        <EmptyState
          title="You do not have access to the fees area"
          description="Viewing invoices needs finance.invoices.view, and the fee catalogue needs finance.fees.view. Ask your school administrator to check your role."
        />
      ) : (
        <Tabs value={tab} onValueChange={setTab} activation="manual">
          <TabList label="Fees sections">
            {tabs.map((entry) => (
              <Tab key={entry.value} value={entry.value}>
                {entry.label}
              </Tab>
            ))}
          </TabList>

          {canSeeInvoices ? (
            <TabPanel value="invoices">
              <InvoiceList
                institutionId={institutionId}
                canViewAcademicYears={canViewAcademicYears}
                canViewClassLevels={canViewClassLevels}
              />
            </TabPanel>
          ) : null}

          {canSeeCatalogue ? (
            <>
              <TabPanel value="heads">
                <FeeHeadList institutionId={institutionId} />
              </TabPanel>
              <TabPanel value="plans">
                <FeePlanList
                  institutionId={institutionId}
                  canViewAcademicYears={canViewAcademicYears}
                  canViewClassLevels={canViewClassLevels}
                />
              </TabPanel>
            </>
          ) : null}
        </Tabs>
      )}
    </div>
  );
}
