-- =====================================================================================
-- 0011 — Auth lifecycle: invitations, password reset, and TOTP multi-factor hardening
--
-- The `auth_tokens` table (0001) already carries every single-use credential this phase
-- needs — invitations, password resets, and now the short-lived MFA challenge minted
-- between "password verified" and "second factor verified". This migration does not add a
-- parallel token table; it hardens the one that exists and adds the single column TOTP
-- verification needs that the Phase 1 schema did not anticipate.
--
--   1. `users.mfa_last_verified_step` — the highest TOTP time step (unix seconds / 30) the
--      user has successfully verified. A presented code whose step is not strictly greater
--      is a replay of a captured code and must be refused; without persisting the step, a
--      code shoulder-surfed or intercepted in its 30-second window would work twice.
--
--   2. Check constraints on `auth_tokens`. Zod validates the same facts at the edge, but
--      "never trust frontend data" extends to not fully trusting the backend either: a
--      token row with an unknown purpose or a negative attempt counter is corruption that
--      would otherwise surface as an authentication bug, which is the worst place to find
--      out.
--
--   3. Supporting indexes for the new access paths: revoking a person's previous pending
--      invitation when they are re-invited (lookup by email/phone + purpose), and the RLS
--      tenant predicate on `auth_tokens`, which 0001 never indexed because nothing
--      tenant-scoped read the table until now.
--
-- No new tables are created, so the RLS catalogue loop from 0002 is not re-run; the
-- closing `assert_rls_coverage()` still executes so that this migration fails loudly if
-- coverage has regressed underneath it.
-- =====================================================================================

-- -------------------------------------------------------------------------------------
-- 1. TOTP replay protection
-- -------------------------------------------------------------------------------------

alter table public.users
  add column if not exists mfa_last_verified_step bigint;

comment on column public.users.mfa_last_verified_step is
  'Highest TOTP time step successfully verified; codes at or below it are replays and are refused.';

-- -------------------------------------------------------------------------------------
-- 2. auth_tokens domain invariants
-- -------------------------------------------------------------------------------------

alter table public.auth_tokens
  add constraint auth_tokens_purpose_known check (
    purpose in (
      'invitation',
      'password_reset',
      'email_verification',
      'phone_verification',
      'mfa_challenge'
    )
  ),
  add constraint auth_tokens_attempts_nonnegative check (attempts >= 0);

-- Note: `auth_tokens_expiry_after_creation` (expires_at > created_at) is deliberately NOT
-- added here. Migration 0002 already created it; re-adding it fails with SQLSTATE 42710 and
-- rolls back this whole migration, which takes the test suite down with it.

-- -------------------------------------------------------------------------------------
-- 3. Access-path indexes
-- -------------------------------------------------------------------------------------

-- Re-inviting a person must invalidate their previous pending invitation. That lookup is
-- by recipient + purpose over rows that are still live, so the indexes are partial.
create index if not exists auth_tokens_email_purpose_idx
  on public.auth_tokens (email, purpose)
  where used_at is null and revoked_at is null;

create index if not exists auth_tokens_phone_purpose_idx
  on public.auth_tokens (phone, purpose)
  where used_at is null and revoked_at is null;

-- The RLS policy on auth_tokens filters by tenant_id on every tenant-context query.
create index if not exists auth_tokens_tenant_idx
  on public.auth_tokens (tenant_id);

-- -------------------------------------------------------------------------------------
-- Structural assertion: nothing in this migration may leave a table unprotected.
-- -------------------------------------------------------------------------------------

select assert_rls_coverage();
