# Salesforce Slack Support Bot

A SaaS Slack bot that allows teams to search their Salesforce support tickets directly from Slack.

## Features

- 🔍 Search support tickets by keyword from Slack
- 🏢 Multi-tenant architecture for marketplace distribution
- 🔒 Secure credential encryption
- 📊 Usage tracking and analytics
- ⚡ Fast SOQL-based queries

## Usage

Once installed in your Slack workspace:

```
/support look through support tickets for customers with login bug
```

## Setup

1. Install dependencies: `npm install`
2. Copy `.env.example` to `.env` and configure
3. Set up PostgreSQL database
4. Run migrations: `npm run migrate`
5. Start the app: `npm start`

## Environment Variables

- `SLACK_CLIENT_ID` - Your Slack app client ID
- `SLACK_CLIENT_SECRET` - Your Slack app client secret
- `SLACK_SIGNING_SECRET` - Your Slack app signing secret
- `DATABASE_URL` - PostgreSQL connection string
- `ENCRYPTION_KEY` - 32-character key for credential encryption
- `APP_URL` - Your app's public URL

## Architecture

- **Express.js** - Web server
- **@slack/bolt** - Slack app framework
- **Knex.js** - Database migrations and queries
- **PostgreSQL** - Multi-tenant data storage
- **Crypto** - Secure credential encryption