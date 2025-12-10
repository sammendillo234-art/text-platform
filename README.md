# Cakehouse Marketing Platform

Compliant SMS & Email marketing platform for cannabis dispensaries with white-label support.

## Features

- **Multi-tenant architecture** - White-label ready with tenant isolation
- **Compliance engine** - TCPA, CAN-SPAM, cannabis-specific rules
- **SMS via Telnyx** - 10DLC ready with webhook handling
- **Email via AWS SES** - High deliverability
- **Message queue** - BullMQ for reliable delivery
- **Quiet hours enforcement** - Per-recipient timezone
- **Opt-out management** - Automatic keyword detection
- **Age verification** - Required for cannabis compliance
- **POS integration ready** - Treez, iHeartJane, Dutchie

## Quick Start

### Prerequisites

- Node.js 18+
- PostgreSQL 14+
- Redis 6+
- Telnyx account with 10DLC approved

### Installation

```bash
# Clone and install
cd cakehouse-marketing
npm install

# Configure environment
cp .env.example .env
# Edit .env with your credentials

# Create database
createdb cakehouse_marketing
psql cakehouse_marketing < src/db/schema.sql

# Start development server
npm run dev
```

### Telnyx Setup

1. Log into [Telnyx Mission Control](https://portal.telnyx.com)
2. Go to **Messaging** > **Messaging Profiles**
3. Create a new profile or use existing
4. Set webhook URL: `https://yourdomain.com/webhooks/telnyx`
5. Copy your API key and Messaging Profile ID to `.env`

### Webhook URL

For local development, use ngrok:

```bash
ngrok http 3000
# Use the https URL as your webhook: https://xxxx.ngrok.io/webhooks/telnyx
```

For production:
```
https://api.yourdomain.com/webhooks/telnyx
```

## API Endpoints

### Webhooks

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/webhooks/telnyx` | Telnyx event webhook |

### Contacts

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/contacts` | List contacts |
| POST | `/api/contacts` | Create contact |

### SMS

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/sms/send` | Send single SMS |

### Campaigns

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/campaigns` | Create campaign |
| POST | `/api/campaigns/:id/send` | Send campaign |

### System

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/health` | Health check |
| GET | `/api/queue/stats` | Queue statistics |

## Compliance Features

### SMS (TCPA)

- ✅ Express written consent verification
- ✅ Quiet hours (9pm-8am recipient local time)
- ✅ STOP/UNSUBSCRIBE keyword handling
- ✅ Opt-out confirmation messages
- ✅ Rate limiting per recipient
- ✅ Consent timestamp & method tracking

### Cannabis-Specific

- ✅ Age verification (21+) required
- ✅ State-specific rule engine (CA, MI, etc.)
- ✅ Content scanning for health claims
- ✅ Minor-appeal term detection

### Email (CAN-SPAM)

- ✅ Physical address requirement
- ✅ Unsubscribe mechanism
- ✅ Age-gated signup flows

## Multi-Tenant Setup

Each tenant (dispensary client) has:
- Isolated data via PostgreSQL Row Level Security
- Own branding & custom domain
- Own Telnyx phone numbers per location
- Separate API keys

### Creating a Tenant

```sql
INSERT INTO tenants (name, slug, company_name, company_address)
VALUES ('The Cake House', 'cakehouse', 'Cake House LLC', '123 Main St, San Diego, CA 92101');
```

## Project Structure

```
cakehouse-marketing/
├── config/
│   └── index.js           # Configuration
├── src/
│   ├── api/               # API routes (future expansion)
│   ├── db/
│   │   ├── index.js       # Database connection
│   │   └── schema.sql     # Full schema
│   ├── services/
│   │   ├── compliance/    # Compliance engine
│   │   ├── email/         # Email service (TODO)
│   │   ├── queue/         # BullMQ job queues
│   │   └── sms/
│   │       └── telnyx.js  # Telnyx SMS service
│   ├── utils/
│   │   └── logger.js      # Winston logger
│   ├── webhooks/
│   │   └── telnyx.js      # Telnyx webhook handler
│   └── index.js           # Main application
├── .env.example
├── package.json
└── README.md
```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `PORT` | Server port (default: 3000) |
| `DATABASE_URL` | PostgreSQL connection string |
| `REDIS_URL` | Redis connection string |
| `TELNYX_API_KEY` | Telnyx API key |
| `TELNYX_PUBLIC_KEY` | For webhook verification |
| `TELNYX_MESSAGING_PROFILE_ID` | Default messaging profile |
| `AWS_REGION` | AWS region for SES |
| `AWS_ACCESS_KEY_ID` | AWS credentials |
| `AWS_SECRET_ACCESS_KEY` | AWS credentials |
| `JWT_SECRET` | JWT signing secret |

## Next Steps

1. **10DLC Registration** - Register your SMS campaign with TCR
2. **Add Email Service** - Implement AWS SES integration
3. **Build Dashboard** - React admin interface
4. **POS Integrations** - Connect Treez/iHeartJane webhooks
5. **Billing** - Stripe integration for white-label clients

## License

Proprietary - The Cake House
