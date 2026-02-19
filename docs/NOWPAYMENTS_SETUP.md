# NOWPayments Setup (PropertyCost)

## 1) SQL

Run migration:

```bash
psql "$DATABASE_URL" -f scripts/sql/nowpayments.sql
```

## 2) Environment variables

Required:

```env
NOWPAYMENTS_API_KEY=your_nowpayments_api_key
NOWPAYMENTS_IPN_SECRET=your_ipn_secret_from_dashboard
```

Recommended:

```env
# Optional override (default: https://api.nowpayments.io/v1)
NOWPAYMENTS_API_BASE=https://api.nowpayments.io/v1

# Optional callback URLs (if not set, APP_URL-based defaults are used)
NOWPAYMENTS_IPN_URL=https://your-domain.com/api/webhooks/nowpayments
NOWPAYMENTS_SUCCESS_URL=https://your-domain.com/account/?np_paid=1&provider=nowpayments
NOWPAYMENTS_CANCEL_URL=https://your-domain.com/pricing/

# Optional behavior
NOWPAYMENTS_PAY_CURRENCY=usdttrc20
NOWPAYMENTS_FIXED_RATE=true
NOWPAYMENTS_FEE_PAID_BY_USER=false
```

`APP_URL` must be a valid `https://...` URL (already used by the project).

## 3) NOWPayments dashboard

1. Get `API Key` and set `NOWPAYMENTS_API_KEY`.
2. Set IPN/webhook endpoint to:
   - `https://your-domain.com/api/webhooks/nowpayments`
3. Set IPN Secret in dashboard and copy it to `NOWPAYMENTS_IPN_SECRET`.
4. Keep webhook method as `POST` and content type JSON.

## 4) Flow in this project

1. Frontend requests `/api/nowpayments/create-checkout`.
2. Backend creates NOWPayments invoice (`/invoice`) and stores pending transaction.
3. User pays on NOWPayments hosted page.
4. NOWPayments sends IPN to `/api/webhooks/nowpayments`.
5. Backend verifies signature and checks amount/currency.
6. Credits are added once (idempotent) only on `finished` status.

## 5) Safety checks implemented

- Signature verification (`x-nowpayments-sig`, HMAC-SHA512).
- Idempotent crediting (no double top-up on duplicate webhooks).
- Status progression logging in `nowpayments_webhook_events`.
- Amount/currency validation before crediting.
- `mismatch` status for suspicious paid notifications.

## 6) Manual test checklist

1. Login and buy smallest pack on `/pricing/`.
2. Complete payment in NOWPayments.
3. Confirm return to `/account/` and credits increase.
4. Confirm DB row:
   - `nowpayments_transactions.status = 'paid'`
   - `paid_at` is set
5. Confirm webhook log exists in `nowpayments_webhook_events`.

## 7) Fallback behavior

Frontend tries NOWPayments first. If checkout creation fails, it falls back to Paddle endpoints.
