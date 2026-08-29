/**
 * The UI kit, in one import.
 *
 * ```ts
 * import { PageHeader, DataTable, Pagination, Button, useToast } from '@/components/ui';
 * ```
 *
 * Three things worth knowing about what is in here:
 *
 *  - `EmptyState`, `ErrorNotice` and `StatusBadge` are re-exported from their existing homes,
 *    not reimplemented. They are already used by the students screens and the dashboard.
 *  - The money formatters are re-exported from `@/components/fees/format`, which owns the one
 *    implementation. Money is a decimal string and is never parsed into a float in the browser
 *    (ADR-004) — a second `formatMoney` is how a receipt ends up a poisa short.
 *  - General formatting (dates, times, counts, enum labels, bilingual names) lives in
 *    `@/lib/format` and is imported from there, so that a Server Component can use it without
 *    pulling in a client component barrel.
 */

// ── Actions ───────────────────────────────────────────────────────────────────────────
export { Button, IconButton, type ButtonProps, type ButtonSize, type ButtonVariant } from './button';

// ── Form controls ─────────────────────────────────────────────────────────────────────
export {
  Field,
  FieldGrid,
  FieldGridSpan,
  FormError,
  mergeFieldProps,
  useFieldControl,
  type FieldControlProps,
  type FieldProps,
} from './field';
export {
  DatePicker,
  Input,
  NumberInput,
  SearchInput,
  Textarea,
  TimeInput,
  type InputProps,
  type NumberInputProps,
  type TextareaProps,
} from './input';
export { Select, toOptions, type SelectOption, type SelectProps } from './select';
export { Checkbox, CheckboxRow, type CheckboxProps } from './checkbox';
export { RadioGroup, type RadioGroupProps, type RadioOption } from './radio-group';

// ── React Hook Form bridge ────────────────────────────────────────────────────────────
export {
  applyApiFieldErrors,
  CheckboxField,
  DateField,
  Form,
  FormActions,
  formRootError,
  MoneyField,
  NumberField,
  RadioField,
  SelectField,
  TextAreaField,
  TextField,
  TimeField,
  type FormProps,
} from './form';

// ── Data display ──────────────────────────────────────────────────────────────────────
export {
  DataTable,
  TableSkeleton,
  type CardSlot,
  type DataTableColumn,
  type DataTableProps,
} from './data-table';
export { Pagination } from './pagination';
export { FilterBar, type FilterBarSearch, type FilterBarSelect } from './filter-bar';
export { DescriptionList, type DescriptionItem } from './description-list';
export { Badge, toneForStatus, type BadgeTone } from './badge';
export { Card, CardBody, CardFooter, CardHeader } from './card';
export { PageHeader, SectionHeading, type Crumb } from './page-header';
export { MetricCard, StatCard, StatGrid } from './stat-card';
export { BilingualName } from './bilingual-name';

// ── Feedback ──────────────────────────────────────────────────────────────────────────
export { Skeleton, SkeletonCard, SkeletonText } from './skeleton';
export { LoadingBlock, Spinner } from './spinner';
export { ToastProvider, useToast, type ToastOptions, type ToastVariant } from './toast';

// ── Overlays and navigation ───────────────────────────────────────────────────────────
export { Dialog, type DialogProps, type DialogSize } from './dialog';
export { ConfirmDialog, useConfirm, type ConfirmDialogProps } from './confirm-dialog';
export { Tab, TabList, TabPanel, Tabs } from './tabs';

// ── Hooks ─────────────────────────────────────────────────────────────────────────────
export { useDebouncedValue } from './use-debounced-value';

// ── Re-exported from their existing homes (not duplicated) ────────────────────────────
export { EmptyState } from '@/components/empty-state';
export { ErrorNotice } from '@/components/error-notice';
export { StatusBadge } from '@/components/status-badge';
export {
  formatMoney,
  formatPercent,
  isMoneyString,
  minorToDecimal,
  toMinor,
} from '@/components/fees/format';
