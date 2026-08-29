/**
 * Button.
 *
 * No `'use client'` on purpose. This component uses no hooks and no browser API, so it works
 * inside a Server Component that only needs a link, and inherits the client boundary of any
 * client screen that hands it an `onClick`. Marking it would force every consumer into the
 * client bundle for no gain.
 *
 * The variant classes deliberately re-use the `.btn-*` component classes from `globals.css`
 * rather than re-declaring the padding and colours here — there is one definition of what a
 * primary button looks like, and it is in the stylesheet with the rest of the design system.
 */

import Link from 'next/link';
import { forwardRef } from 'react';
import { cn } from '@/lib/cn';
import { Spinner } from './spinner';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md';

const VARIANT_CLASS: Record<ButtonVariant, string> = {
  primary: 'btn-primary',
  secondary: 'btn-secondary',
  ghost: 'btn-ghost',
  // The only variant not in globals.css: danger is rare enough that it lives with the component
  // that owns it. `text-white` rather than `text-content-inverted` because the danger fill is
  // the same dark red in both themes, so the text on it must not follow the theme.
  danger: 'btn bg-danger text-white hover:bg-danger/90 active:bg-danger/80',
};

const SIZE_CLASS: Record<ButtonSize, string> = {
  sm: 'px-2.5 py-1.5 text-sm',
  md: '',
};

interface CommonProps {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Disables the control, shows a spinner, and announces progress to screen readers. */
  loading?: boolean;
  /** What the spinner announces. Say what is happening: "Saving fee structure". */
  loadingLabel?: string;
  fullWidth?: boolean;
  iconLeft?: React.ReactNode;
  iconRight?: React.ReactNode;
  className?: string;
  children?: React.ReactNode;
}

export interface ButtonProps
  extends CommonProps,
    Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, keyof CommonProps> {
  /** When present the button renders as a Next.js link. `type` is then meaningless. */
  href?: string;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = 'secondary',
    size = 'md',
    loading = false,
    loadingLabel = 'Working…',
    fullWidth = false,
    iconLeft,
    iconRight,
    className,
    children,
    href,
    disabled,
    type,
    ...rest
  },
  ref,
) {
  const classes = cn(
    VARIANT_CLASS[variant],
    SIZE_CLASS[size],
    fullWidth && 'w-full',
    className,
  );

  const inner = (
    <>
      {loading ? <Spinner size={size === 'sm' ? 'xs' : 'sm'} /> : iconLeft}
      {children}
      {loading ? null : iconRight}
      {/*
        The visual spinner is invisible to a screen reader, so the state is announced instead.
        `role="status"` is polite: it does not interrupt whatever the user is currently reading,
        which matters because a save button's spinner is not more important than the field
        error the user is in the middle of hearing.
      */}
      {loading ? (
        <span role="status" className="sr-only">
          {loadingLabel}
        </span>
      ) : null}
    </>
  );

  if (href !== undefined) {
    // A disabled link is not a thing in HTML — `aria-disabled` on an anchor still lets a
    // keyboard user activate it. Rendering a span removes the affordance entirely, which is
    // the honest representation of "you cannot go there right now".
    if (disabled || loading) {
      return (
        <span
          aria-disabled="true"
          className={cn(classes, 'cursor-not-allowed opacity-60')}
        >
          {inner}
        </span>
      );
    }
    return (
      <Link {...(rest as Omit<React.ComponentProps<typeof Link>, 'href' | 'className'>)} href={href} className={classes}>
        {inner}
      </Link>
    );
  }

  return (
    <button
      ref={ref}
      // Defaulting to "button" prevents the classic bug where a button inside a form submits it
      // by accident — a "Add another guardian" button that saves the half-filled form.
      type={type ?? 'button'}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={classes}
      {...rest}
    >
      {inner}
    </button>
  );
});

/**
 * An icon-only button. The label is required, not optional, because an icon button without an
 * accessible name is an unusable button — and making it a required prop is the only way that
 * stays true after the tenth call site.
 */
export const IconButton = forwardRef<
  HTMLButtonElement,
  Omit<ButtonProps, 'children' | 'iconLeft' | 'iconRight'> & {
    label: string;
    icon: React.ReactNode;
  }
>(function IconButton({ label, icon, className, size = 'md', ...rest }, ref) {
  return (
    <Button
      ref={ref}
      size={size}
      aria-label={label}
      title={label}
      className={cn(size === 'sm' ? 'px-1.5' : 'px-2', className)}
      {...rest}
    >
      {icon}
    </Button>
  );
});
