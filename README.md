# PAL + Roqqu: payment links for invoices

**PAL is an AI co-founder for founders and entrepreneurs.** It remembers your business, keeps track of projects, tasks, decisions and invoices, and tells you what needs attention.

This repo holds PAL's Roqqu integration, built for the Anambra Web3 Hackathon 2026. This repo holds the integration code only, so it won't run on its own.

## Status

- **Built:** the code follows the [Roqqu API Service docs](https://roqqu-api-services.gitbook.io/ras).
- **Tested:** automated tests pass against simulated Roqqu responses.
- **Not yet tested with Roqqu itself:** Roqqu account verification hasn't completed, so we don't have a test key yet. Live testing follows once we do.
- **Test mode only:** the code sends a test key using Roqqu's `x-staging-api-key` header. It can't use a live key or move real money.

## How it works

1. A founder taps **Get paid** on an invoice, then confirms the naira amount and the client's details.
2. PAL calls `POST /payment-links` and gives the founder a Roqqu payment link to send.
3. The client pays on Roqqu's payment page, using a supported network such as Bitcoin or USDT (TRC20, BEP20).
4. Roqqu sends PAL an encrypted webhook. PAL decrypts it and checks it against the stored link.
5. A completed payment marks the invoice as paid and notifies the founder. A failed or underpaid payment leaves the invoice open and notifies the founder.

## Files

| Path | Purpose |
|---|---|
| `lib/payments/roqqu.ts` | Roqqu API client, input checks, webhook decryption |
| `lib/server/roqquPayments.ts` | Applies a verified payment event to PAL's data |
| `app/api/invoices/payment-links/route.ts` | Creates and lists payment links |
| `app/api/webhooks/roqqu/route.ts` | Receives Roqqu webhooks |
| `supabase/migrations/20261105000017_invoice_payment_links.sql` | Payment links table and access rules |
| `tests/roqquPaymentLinks.test.mjs` | Tests (they use a test helper from the main PAL app) |
| `patches/pal-app-changes.patch` | Changes to PAL's invoice screen and route access |

The server needs one setting, `ROQQU_TEST_API_KEY`. Never commit a key to this repo.
