[README (1).md](https://github.com/user-attachments/files/32187278/README.1.md)
# PropertyCost — Real Estate Analytics Platform

[![Live demo](https://img.shields.io/badge/Live%20demo-mypropertycost.com-0A66C2?style=flat-square)](https://mypropertycost.com/)
[![Node.js](https://img.shields.io/badge/Node.js-22%2B-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org/)
[![Express](https://img.shields.io/badge/Express-5-000000?style=flat-square&logo=express)](https://expressjs.com/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-data-4169E1?style=flat-square&logo=postgresql&logoColor=white)](https://www.postgresql.org/)

> A full-stack web application for evaluating residential real-estate decisions. Users can model mortgages, ownership costs, rental cash flow and investment returns; save calculations; stress-test assumptions; and receive AI-assisted deal analysis with exportable PDF reports.

**Live product:** [mypropertycost.com](https://mypropertycost.com/)

## Why this project

Most online real-estate calculators answer one narrow question. PropertyCost combines calculations into a decision workflow: a user enters assumptions, sees transparent financial metrics, compares alternative scenarios, saves the work to an account and can request a structured AI analysis. The product targets the US real-estate market and is built as an SEO-friendly, monetizable web application rather than a demo.

## Key features

- **11 calculation engines:** mortgage, rent vs. buy, cash flow, break-even rent/price, ownership cost, mortgage overpayment, property sale, property taxes, renovation ROI, property IRR, and property vs. alternative investment.
- **Scenario analysis:** generates valid, non-duplicate variations of a base deal and recomputes the financial result for each scenario.
- **AI-assisted analysis:** produces deal verdicts, Q&A, deeper scenario analysis and optimizer recommendations through a Redis-backed BullMQ queue.
- **Account workspace:** email/password registration, Google OAuth, saved calculation history, cached analysis results and portfolio summaries.
- **Credit-based premium workflow:** checkout integration with Paddle and NOWPayments; payment webhooks credit the account exactly once.
- **PDF reports:** generates downloadable reports from a completed analysis.
- **Content and SEO layer:** calculator landing pages, topic hubs, guides, canonical URLs, structured data, sitemap, robots.txt and redirects from legacy URLs.
- **Production safeguards:** Helmet CSP with request nonces, CSRF validation, server-side input validation, secure cookies, Redis-backed rate limits and idempotent payment processing.

## Architecture

```mermaid
flowchart TD
    A[Browser: HTML, CSS, JS] --> B[Express API]
    B --> C[Calculation engine]
    B --> D[(PostgreSQL)]
    B --> E[(Redis)]
    E --> F[BullMQ worker]
    F --> G[OpenAI API]
    B --> H[Paddle / NOWPayments]
    H --> I[Verified webhooks]
    I --> D
```

### How a calculation becomes an analysis

1. The browser collects deal inputs and calls the Express API with a CSRF token.
2. `compute.js` validates the inputs and calculates financial metrics deterministically; the same calculation code is used by the scenario engine.
3. An authenticated user can save inputs and results to PostgreSQL.
4. The scenario engine creates meaningful changes to the original assumptions, recalculates each variation and stores or returns the comparison.
5. For an AI feature, the API builds a constrained prompt from the calculation/scenario data and puts it in BullMQ. The client can poll the job-status endpoint instead of keeping a request open.
6. The completed output is stored/cached, displayed in the account UI and can be exported as a PDF report.

## Tech stack

| Area | Technologies |
| --- | --- |
| Backend | Node.js, Express 5 |
| Frontend | Vanilla JavaScript, HTML5, CSS3, Chart.js |
| Data | PostgreSQL (`pg`), Redis |
| Auth | `bcrypt`, server sessions, Google OAuth 2.0 |
| Async jobs | BullMQ + Redis |
| AI | OpenAI API |
| Payments | Paddle, NOWPayments webhooks |
| Security | Helmet/CSP nonces, CSRF tokens, Redis rate limiting, secure HTTP-only cookies |
| Email | Resend |
| Tests | Native Node.js test runner |

## Important backend modules

| Module | Responsibility |
| --- | --- |
| `jsForAuth/server.js` | Express application, API composition, security middleware, premium workflows, reports and static-site delivery |
| `jsForAuth/compute.js` | Pure, server-side financial calculation engine |
| `jsForAuth/scenarioEngine.js` | Scenario generation and calculation-specific stress tests |
| `jsForAuth/auth.js` | Registration, login/logout, session renewal and CSRF-token endpoint |
| `jsForAuth/google.js` | Google OAuth flow with state verification |
| `jsForAuth/aiQueue.js` / `worker.ai.js` | BullMQ producer/worker, retry policy, deduplication and OpenAI calls |
| `jsForAuth/rateLimit.js` | Per-IP and per-user limits with a local fallback if Redis is unavailable |
| `jsForAuth/calculator.js` | Persistent calculation-history API |
| `scripts/smoke-api.js` | Production-readiness API smoke check |

## Run locally

### Prerequisites

- Node.js 22+
- PostgreSQL database containing the application schema
- Redis instance
- An OpenAI API key for AI features

```bash
git clone https://github.com/Proggertopper/AIPropertyCostCalculatorWithAnalytics.git
cd AIPropertyCostCalculatorWithAnalytics
npm install
```

Create `.env` locally and **never commit it**:

```env
NODE_ENV=development
HOST=127.0.0.1
PORT=3000
APP_URL=http://127.0.0.1:3000
TRUST_PROXY=false

DATABASE_URL=postgresql://USER:PASSWORD@HOST:5432/DATABASE
REDIS_URL=redis://:PASSWORD@HOST:6379
SESSION_SECRET=replace-with-a-long-random-secret

OPENAI_API_KEY=your_key

# Optional integrations
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_REDIRECT_URI=http://127.0.0.1:3000/auth/api/google/callback
RESEND_API_KEY=
EMAIL_FROM=
EMAIL_TO=
PADDLE_API_KEY=
PADDLE_CLIENT_TOKEN=
PADDLE_WEBHOOK_SECRET=
NOWPAYMENTS_API_KEY=
NOWPAYMENTS_IPN_SECRET=
```

Start the web server and, in another terminal, the AI worker:

```bash
node jsForAuth/server.js
node jsForAuth/worker.ai.js
```

Open `http://127.0.0.1:3000`.

> **Note:** the deployed application uses an existing PostgreSQL schema. The repository currently includes a separate NOWPayments migration in `scripts/sql/nowpayments.sql`; the remaining production schema is provisioned with the application database.

## Testing

```bash
npm test
```

The test suite verifies deterministic financial outputs, scenario validity/uniqueness and rate-limit behavior including the Redis-failure fallback.

For a running local or staging deployment:

```bash
SMOKE_BASE_URL=http://127.0.0.1:3000 npm run smoke:api
```

## Payment-webhook setup

NOWPayments configuration and verification flow are documented in [docs/NOWPAYMENTS_SETUP.md](docs/NOWPAYMENTS_SETUP.md). The webhook implementation verifies the HMAC signature, validates payment amount/currency and records crediting idempotently to prevent duplicate top-ups.

## Production deployment notes

- The app is intended to run behind HTTPS reverse proxy infrastructure.
- In production, sessions use a `__Host-` cookie with `Secure`, `HttpOnly` and `SameSite=Lax` attributes.
- `TRUST_PROXY` defaults to two hops in production for a load-balancer → Nginx → Node deployment.
- Set `APP_URL` to the canonical HTTPS domain before enabling OAuth or payments.
- Keep database, Redis and provider credentials outside the repository.

## Resume-ready summary

> Built and deployed **PropertyCost**, a full-stack Node.js/Express real-estate analytics platform. Implemented 11 server-side financial calculators, PostgreSQL persistence, Redis-backed sessions/rate limiting, Google OAuth, CSRF/CSP security controls, BullMQ asynchronous AI processing, payment webhooks with idempotent crediting, PDF reporting, automated tests, and an SEO-oriented content architecture.

## Disclaimer

PropertyCost provides informational software outputs based on user-provided assumptions. It is not financial, legal or tax advice.
