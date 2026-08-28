# 09 — Integrations

Every external dependency sits behind an interface with a working local adapter. A missing
credential never blocks development — but a missing _implementation_ fails loudly rather than
silently falling back, because a silent fallback appears to work right up until it loses data.

---

## Status

| Integration  | Interface | Local adapter              | Production adapter |
| ------------ | --------- | -------------------------- | ------------------ |
| Storage      | Yes       | **Yes** — real signed URLs | No (KI-003)        |
| Email        | No        | Mailpit in compose         | No                 |
| SMS          | No        | —                          | No                 |
| Payments     | No        | —                          | No                 |
| AI providers | No        | —                          | No                 |
| GPS          | No        | —                          | No                 |

Only storage has been built, because it is the only one Phases 1–4 needed.

---

## Storage

`StorageProvider`: `put`, `get`, `stream`, `delete`, `signUrl`, `verifySignature`, `health`.

The local adapter is **not a stub**. It implements the same contract including signed, expiring
URLs, so the authorization semantics are exercised in development rather than only in
production.

That matters more than it sounds. The most common file-storage vulnerability in this kind of
product is a development shortcut — serving `/uploads/*` statically — that survives to
production and exposes every student's documents to anyone who guesses a path. Building the
local adapter with real signature verification means the shortcut never exists to survive.

**The signature covers the key and the expiry together.** Signing only the key would let a
holder extend the lifetime indefinitely; signing only the expiry would let them swap in another
student's document.

**Keys are `tenants/{tenantId}/{category}/{uuid}.{ext}`**, constructed centrally, so a bug in a
feature module cannot produce a key that collides across tenants. The resolved filesystem path
is re-validated against the storage root — a boundary between an identifier and the filesystem
eventually gets called with unexpected input, however carefully the identifiers are generated.

The extension is allow-listed rather than sanitised, and anything unrecognised gets no extension
at all. The MIME type is determined from the bytes and stored in the database, so it does not
depend on the filename.

MinIO is in the development compose file specifically so the S3 adapter can be tested without an
AWS account.

---

## SMS — the one that matters most here

Most guardian communication in Bangladesh is SMS, not email or push. A large share of parents
have no email address at all, which is why the login identifier already accepts a phone number.

Planned interface: `send`, `sendBulk`, `getStatus`, with adapters for the local providers and a
console adapter for development.

Constraints that will shape the design:

- **Bangla SMS is UCS-2 encoded**, so a message part is 70 characters rather than 160. A
  template system that counts characters in the wrong encoding silently triples the bill.
- **Delivery reports arrive asynchronously and are redelivered.** Handling must be idempotent.
- **Numbers must be E.164 before submission.** `normalizeBdMobile` already does this at the
  schema boundary, so every stored number is already in the right form — one of the few
  integration prerequisites that is already finished.

---

## Payments

`PaymentProvider` with adapters for cash, bank transfer, bKash, Nagad and SSLCommerz.

The requirements that make this an abstraction rather than a direct integration:

- **Payment intents** created before redirect, so an abandoned payment is distinguishable from a
  failed one.
- **Callback signature verification.** A gateway callback is an unauthenticated request from the
  internet that claims money has moved.
- **Idempotency and duplicate-callback protection.** Providers retry; a double credit is worse
  than a missed one.
- **Reconciliation** against the provider's settlement file, because callbacks do get lost.
- **The ledger posting happens inside the same transaction as the payment record.** A payment
  that exists without its accounting entry is a discrepancy someone has to find by hand.

A mock provider will cover the full happy path plus failure, timeout and duplicate-callback
cases, so the workflow is testable without credentials.

---

## Email

SMTP, with Mailpit locally so nothing reaches a real inbox from a development machine. Used for
invitations, password resets and report delivery — not for time-critical guardian
communication, which is SMS.

---

## GPS (transport)

An interface with a mock adapter, so the transport module can complete without a live GPS
service. The brief is explicit that a missing GPS provider must not block the module, and the
useful parts — routes, stops, student assignments, transport fees — do not depend on live
position data at all.

---

## AI providers

See `docs/06_AI_ARCHITECTURE.md`. `AIProvider` with per-task routing, so no application logic
references a vendor.

---

## Credentials required before production

| Variable                                                               | For                         |
| ---------------------------------------------------------------------- | --------------------------- |
| `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | Documents and photos        |
| SMTP host, port, user, password                                        | Invitations, password reset |
| SMS provider key and sender id                                         | Guardian notifications      |
| bKash / Nagad / SSLCommerz merchant credentials                        | Online fee collection       |
| AI provider key                                                        | Phases 27–36                |

None are needed to run, develop against, or test the system as it stands.
