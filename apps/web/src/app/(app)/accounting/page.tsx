'use client';

/**
 * Accounting home: the chart of accounts and the two reports read off it.
 *
 * The chart is `accounting.coa.view`; the reports are `accounting.reports.view`. They are
 * separate permissions because they are separate jobs — a principal reads the trial balance and
 * never touches the chart — so the tab strip is assembled from what the user holds rather than
 * shown whole with two dead ends in it.
 */

import { useState } from 'react';
import { useSession } from '@/lib/session';
import { Button, EmptyState, PageHeader, Tab, TabList, TabPanel, Tabs } from '@/components/ui';
import { ChartOfAccounts } from '@/components/accounting/chart-of-accounts';
import { GeneralLedgerReport, TrialBalanceReport } from '@/components/accounting/reports';

export default function AccountingPage() {
  const session = useSession();
  // Guaranteed by the area layout, which refuses to render without an institution scope.
  const institutionId = session.institutionId!;

  const canSeeChart = session.can('accounting.coa.view');
  const canSeeReports = session.can('accounting.reports.view');

  const tabs = [
    ...(canSeeChart ? [{ value: 'accounts', label: 'Chart of accounts' }] : []),
    ...(canSeeReports
      ? [
          { value: 'trial-balance', label: 'Trial balance' },
          { value: 'ledger', label: 'General ledger' },
        ]
      : []),
  ];

  const [tab, setTab] = useState(tabs[0]?.value ?? 'accounts');

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title="Accounting"
        description="The double-entry ledger: the accounts, what they hold, and how each one got there."
        actions={
          session.can('accounting.journal.view') ? (
            <Button href="/accounting/journals">Journal entries</Button>
          ) : null
        }
      />

      {tabs.length === 0 ? (
        <EmptyState
          title="You do not have access to the ledger"
          description="Reading the chart needs accounting.coa.view, and the reports need accounting.reports.view. Ask your school administrator to check your role."
        />
      ) : (
        <Tabs value={tab} onValueChange={setTab} activation="manual">
          <TabList label="Accounting sections">
            {tabs.map((entry) => (
              <Tab key={entry.value} value={entry.value}>
                {entry.label}
              </Tab>
            ))}
          </TabList>

          {canSeeChart ? (
            <TabPanel value="accounts">
              <ChartOfAccounts institutionId={institutionId} />
            </TabPanel>
          ) : null}

          {canSeeReports ? (
            <>
              <TabPanel value="trial-balance">
                <TrialBalanceReport institutionId={institutionId} />
              </TabPanel>
              <TabPanel value="ledger">
                <GeneralLedgerReport institutionId={institutionId} />
              </TabPanel>
            </>
          ) : null}
        </Tabs>
      )}
    </div>
  );
}
