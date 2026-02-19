-- NOWPayments integration schema for PropertyCost
-- Safe to run multiple times.

create table if not exists nowpayments_transactions (
  id bigserial primary key,
  transaction_id text not null unique,
  provider_invoice_id text,
  provider_payment_id text,
  user_id bigint not null references users(id) on delete cascade,
  credits integer not null default 0,
  status text not null default 'created',
  pack_key text,
  amount_usd numeric(10,2),
  price_currency text not null default 'usd',
  pay_currency text,
  paid_price_amount numeric(16,8),
  paid_currency text,
  actually_paid numeric(24,12),
  outcome_amount numeric(24,12),
  outcome_currency text,
  webhook_count integer not null default 0,
  last_webhook_event_hash text,
  last_payload jsonb,
  paid_at timestamptz,
  last_ipn_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists nowpayments_webhook_events (
  id bigserial primary key,
  event_hash text not null unique,
  payment_id text,
  order_id text,
  invoice_id text,
  status text,
  signature text,
  payload jsonb not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_nowpayments_transactions_user_created
  on nowpayments_transactions(user_id, created_at desc);

create index if not exists idx_nowpayments_transactions_status_created
  on nowpayments_transactions(status, created_at desc);

create index if not exists idx_nowpayments_transactions_invoice
  on nowpayments_transactions(provider_invoice_id);

create index if not exists idx_nowpayments_webhook_events_payment_created
  on nowpayments_webhook_events(payment_id, created_at desc);
