'use client';

/**
 * The two ledger reports a school reads most often.
 *
 * Both are computed by the API in `Money` and arrive as decimal strings. In particular the
 * running balance in the general ledger is the server's, accumulated across every line since
 * inception (or since the opening balance it computed for the `from` date). Re-accumulating it
 * in the browser would be a float sum over two thousand rows — exact for a while, then not.
 *
 * `balanced` on the trial balance is likewise the API's own assertion: it throws a 500 rather
 * than returning a trial balance that does not balance, so the badge below reports a fact, not
 * a check this component performed.
 */

import { useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { COA_ACCOUNT_TYPES } from '@shikkha/validation';
import {
  Badge,
  Card,
  CardBody,
  CardHeader,
  DataTable,
  DatePicker,
  EmptyState,
  Field,
  FieldGrid,
  MetricCard,
  Select,
  StatGrid,
  formatMoney,
  type SelectOption,
} from '@/components/ui';
import { addDays, formatDate, humanize, todayInDhaka } from '@/lib/format';
import {
  accountingApi,
  type GeneralLedgerEntry,
  type TrialBalanceRow,
} from './accounting-api';

type LedgerRow = GeneralLedgerEntry & { rowId: string };

const TYPE_OPTIONS: SelectOption[] = COA_ACCOUNT_TYPES.map((type) => ({
  value: type,
  label: humanize(type),
}));

export function TrialBalanceReport({ institutionId }: { institutionId: string }) {
  const [asOf, setAsOf] = useState('');
  const [type, setType] = useState('');

  const report = useQuery({
    queryKey: ['trial-balance', institutionId, asOf],
    queryFn: () => accountingApi.trialBalance(institutionId, { asOf: asOf || undefined }),
    placeholderData: keepPreviousData,
  });

  // A display filter over rows the API already returned in full — not a second query, and not a
  // recalculation: the totals below stay the API's totals for the whole trial balance.
  const rows = (report.data?.accounts ?? []).filter((row) => !type || row.type === type);

  return (
    <>
      <Card className="mb-5">
        <CardHeader
          title="As of"
          description="Every posting up to and including this date. Leave blank for today in Dhaka."
        />
        <CardBody>
          <FieldGrid columns={2}>
            <Field label="Cut-off date" optional>
              <DatePicker value={asOf} onChange={(event) => setAsOf(event.target.value)} />
            </Field>
            <Field label="Show only" optional hint="Filters the rows below; the totals stay whole.">
              <Select
                value={type}
                onChange={(event) => setType(event.target.value)}
                options={TYPE_OPTIONS}
                placeholder="Every account type"
                allowEmpty
              />
            </Field>
          </FieldGrid>
        </CardBody>
      </Card>

      <StatGrid className="mb-5">
        <MetricCard
          label="Total debits"
          value={report.data ? formatMoney(report.data.totalDebits) : null}
        />
        <MetricCard
          label="Total credits"
          value={report.data ? formatMoney(report.data.totalCredits) : null}
        />
        <MetricCard
          label="As of"
          value={report.data ? formatDate(report.data.asOf) : null}
        />
        <MetricCard
          label="Books"
          value={report.data ? (report.data.balanced ? 'Balanced' : 'Unbalanced') : null}
          tone={report.data?.balanced ? 'success' : 'danger'}
          detail="Asserted by the API before it answers"
        />
      </StatGrid>

      <DataTable<TrialBalanceRow>
        caption="Trial balance"
        rows={rows}
        rowKey={(row) => row.accountId}
        isLoading={report.isLoading}
        isFetching={report.isFetching}
        error={report.error}
        minWidth="44rem"
        empty={{
          title: 'Nothing posted yet',
          description:
            'No journal line falls on or before this date, so every account is at zero. Post an entry, or move the cut-off later.',
        }}
        columns={[
          {
            id: 'code',
            header: 'Code',
            className: 'font-mono text-xs',
            card: 'subtitle',
            render: (row) => row.code,
          },
          { id: 'name', header: 'Account', card: 'title', render: (row) => row.nameEn },
          {
            id: 'type',
            header: 'Type',
            hideBelow: 'md',
            card: 'meta',
            render: (row) => humanize(row.type),
          },
          {
            id: 'debits',
            header: 'Debits',
            align: 'right',
            card: 'row',
            className: 'tabular-nums text-content-muted',
            render: (row) => formatMoney(row.debits),
          },
          {
            id: 'credits',
            header: 'Credits',
            align: 'right',
            card: 'row',
            className: 'tabular-nums text-content-muted',
            render: (row) => formatMoney(row.credits),
          },
          {
            id: 'balance',
            header: 'Balance',
            align: 'right',
            card: 'aside',
            className: 'tabular-nums font-medium',
            render: (row) => (
              <span>
                {formatMoney(row.balance)}
                <span className="ml-1 text-xs text-content-subtle">{row.normalBalance[0]?.toUpperCase()}r</span>
              </span>
            ),
          },
        ]}
      />
    </>
  );
}

export function GeneralLedgerReport({ institutionId }: { institutionId: string }) {
  const today = todayInDhaka();
  const [accountId, setAccountId] = useState('');
  const [from, setFrom] = useState(addDays(today, -90));
  const [to, setTo] = useState(today);

  const rangeIsValid = !from || !to || to >= from;

  const accounts = useQuery({
    queryKey: ['accounts', 'postable', institutionId],
    queryFn: () =>
      accountingApi.listAccounts(institutionId, {
        postableOnly: 'true',
        pageSize: 200,
        sort: 'code',
      }),
    staleTime: 5 * 60_000,
  });

  const ledger = useQuery({
    queryKey: ['general-ledger', { institutionId, accountId, from, to }],
    queryFn: () =>
      accountingApi.generalLedger(institutionId, {
        accountId,
        from: from || undefined,
        to: to || undefined,
      }),
    enabled: Boolean(accountId) && rangeIsValid,
    placeholderData: keepPreviousData,
  });

  // One entry can legitimately touch the same account twice, so the position in the API's
  // ordered list — not a value from the row — is what makes a stable, unique React key.
  const rows: LedgerRow[] = (ledger.data?.entries ?? []).map((entry, index) => ({
    ...entry,
    rowId: `${entry.entryId}-${index}`,
  }));

  return (
    <>
      <Card className="mb-5">
        <CardHeader
          title="Account and period"
          description="Only postable accounts carry lines, so only they are offered."
        />
        <CardBody>
          <FieldGrid columns={3}>
            <Field label="Account" required>
              <Select
                value={accountId}
                onChange={(event) => setAccountId(event.target.value)}
                options={(accounts.data?.data ?? []).map((account) => ({
                  value: account.id,
                  label: `${account.code} — ${account.nameEn}`,
                  hint: humanize(account.type),
                  group: humanize(account.type),
                }))}
                placeholder="Choose an account"
              />
            </Field>
            <Field label="From" optional hint="Blank means since inception.">
              <DatePicker value={from} onChange={(event) => setFrom(event.target.value)} />
            </Field>
            <Field
              label="To"
              optional
              error={rangeIsValid ? null : 'The end of the range cannot be before its start.'}
            >
              <DatePicker value={to} onChange={(event) => setTo(event.target.value)} />
            </Field>
          </FieldGrid>
        </CardBody>
      </Card>

      {!accountId ? (
        <EmptyState
          title="Choose an account"
          description="A general ledger is one account's history. Pick the account whose movements you want to read."
        />
      ) : (
        <>
          <StatGrid className="mb-5">
            <MetricCard
              label="Opening balance"
              value={ledger.data ? formatMoney(ledger.data.openingBalance) : null}
            />
            <MetricCard
              label="Debits in period"
              value={ledger.data ? formatMoney(ledger.data.totalDebits) : null}
            />
            <MetricCard
              label="Credits in period"
              value={ledger.data ? formatMoney(ledger.data.totalCredits) : null}
            />
            <MetricCard
              label="Closing balance"
              value={ledger.data ? formatMoney(ledger.data.closingBalance) : null}
              detail={
                ledger.data
                  ? `${ledger.data.account.code} — ${humanize(ledger.data.account.normalBalance)} normal`
                  : undefined
              }
            />
          </StatGrid>

          <DataTable<LedgerRow>
            caption={
              ledger.data
                ? `General ledger for ${ledger.data.account.code} ${ledger.data.account.nameEn}`
                : 'General ledger'
            }
            rows={rows}
            rowKey={(entry) => entry.rowId}
            rowHref={(entry) => `/accounting/journals/${entry.entryId}`}
            isLoading={ledger.isLoading}
            isFetching={ledger.isFetching}
            error={ledger.error}
            minWidth="46rem"
            empty={{
              title: 'No movement in this period',
              description:
                'Nothing was posted to this account between these dates. Widen the range, or clear the from date to read the account since inception.',
            }}
            columns={[
              {
                id: 'entryNumber',
                header: 'Entry',
                card: 'title',
                className: 'font-mono text-xs',
                render: (entry) => entry.entryNumber,
              },
              {
                id: 'date',
                header: 'Date',
                card: 'subtitle',
                className: 'tabular-nums',
                render: (entry) => formatDate(entry.date),
              },
              {
                id: 'description',
                header: 'Description',
                hideBelow: 'md',
                card: 'row',
                render: (entry) => (
                  <span className="text-content-muted">{entry.description ?? '—'}</span>
                ),
              },
              {
                id: 'status',
                header: 'Status',
                card: 'meta',
                render: (entry) => (
                  <Badge tone={entry.status === 'reversed' ? 'danger' : 'success'}>
                    {humanize(entry.status)}
                  </Badge>
                ),
              },
              {
                id: 'debit',
                header: 'Debit',
                align: 'right',
                card: 'row',
                className: 'tabular-nums',
                render: (entry) => formatMoney(entry.debit),
              },
              {
                id: 'credit',
                header: 'Credit',
                align: 'right',
                card: 'row',
                className: 'tabular-nums',
                render: (entry) => formatMoney(entry.credit),
              },
              {
                id: 'balance',
                header: 'Balance',
                align: 'right',
                card: 'aside',
                className: 'tabular-nums font-medium',
                render: (entry) => formatMoney(entry.balance),
              },
            ]}
          />
        </>
      )}
    </>
  );
}
