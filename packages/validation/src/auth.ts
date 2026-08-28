/**
 * Authentication schemas.
 *
 * Shared verbatim between the API's validation pipe and the web app's React Hook Form
 * resolvers, so a field the client accepts is exactly a field the server accepts. Where they
 * diverge, one of them is wrong — and historically it is the server that ends up more
 * permissive, which is the direction that matters.
 */

import { z } from 'zod';

/** Trim before validating: a trailing space in a pasted email should not fail the form. */
export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3)
  .max(320)
  .email('Enter a valid email address');

/**
 * Login accepts an email address or a phone number, so it is validated loosely here and
 * normalised on the server. Rejecting a malformed identifier with a specific message would
 * distinguish "not a valid email" from "no such account", which is an enumeration hint.
 */
export const loginSchema = z.object({
  identifier: z.string().trim().min(3, 'Enter your email address or phone number').max(320),
  password: z.string().min(1, 'Enter your password').max(128),
  tenantSlug: z
    .string()
    .trim()
    .regex(/^[a-z0-9-]+$/, 'Invalid school identifier')
    .max(63)
    .optional(),
  deviceLabel: z.string().trim().max(128).optional(),
});

export type LoginInput = z.infer<typeof loginSchema>;

/**
 * Password policy, mirrored from `PasswordService.check`.
 *
 * Duplicated deliberately rather than shared: the server's check must not depend on a package
 * the client can influence, and the client needs synchronous feedback while typing. The API
 * test suite asserts the two agree on a shared table of examples.
 */
export const passwordSchema = z
  .string()
  .min(12, 'Password must be at least 12 characters')
  .max(128, 'Password must be at most 128 characters')
  .refine((value) => !/^(.)\1+$/.test(value), 'Password cannot be a single repeated character');

export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1, 'Enter your current password').max(128),
    newPassword: passwordSchema,
    confirmPassword: z.string(),
  })
  .refine((data) => data.newPassword === data.confirmPassword, {
    message: 'The passwords do not match',
    path: ['confirmPassword'],
  })
  .refine((data) => data.currentPassword !== data.newPassword, {
    message: 'The new password must be different from the current one',
    path: ['newPassword'],
  });

export const refreshSchema = z.object({
  /** Optional: the browser sends it as an httpOnly cookie; mobile clients send it in the body. */
  refreshToken: z.string().min(20).max(200).optional(),
  deviceLabel: z.string().trim().max(128).optional(),
});

export const forgotPasswordSchema = z.object({
  identifier: z.string().trim().min(3).max(320),
});

export const resetPasswordSchema = z
  .object({
    token: z.string().min(20).max(200),
    newPassword: passwordSchema,
    confirmPassword: z.string(),
  })
  .refine((data) => data.newPassword === data.confirmPassword, {
    message: 'The passwords do not match',
    path: ['confirmPassword'],
  });

export const acceptInvitationSchema = z
  .object({
    token: z.string().min(20).max(200),
    password: passwordSchema,
    confirmPassword: z.string(),
    fullNameEn: z.string().trim().min(2).max(255),
    fullNameBn: z.string().trim().max(255).optional(),
  })
  .refine((data) => data.password === data.confirmPassword, {
    message: 'The passwords do not match',
    path: ['confirmPassword'],
  });
