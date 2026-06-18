# Gazelle ERP/OMS — Backend

Internal operations platform for Shopify e-commerce: order validation, dual-inventory tracking, and Bosta shipping integration.

## Stack

- Node.js + Express
- MongoDB + Mongoose
- Agenda (MongoDB-backed job queue)
- Shopify GraphQL Admin API
- Bosta REST API

## Prerequisites

- Node.js 20+
- MongoDB **replica set** (required for inventory transactions)
  - **Atlas**: use your cluster URI with database name `gazelle_oms`
  - **Local**: `docker compose up -d` then set `MONGODB_URI=mongodb://localhost:27017/gazelle_oms?replicaSet=rs0`

## Setup

```bash
cp .env.example .env
# Edit .env with your credentials
npm install
npm run dev          # API server
npm run dev:worker   # Agenda worker (separate terminal)
```

## Processes

| Command | Purpose |
|---------|---------|
| `npm start` | HTTP API + webhook ingress |
| `npm run worker` | Background jobs (Shopify/Bosta outbound, sync, polling) |

Deploy both processes in production (e.g. Render web service + background worker).

## API

Base path: `/api/v1`

- `POST /api/v1/auth/login` — staff login
- `GET /api/v1/orders` — order queues (role-filtered)
- `POST /webhooks/shopify/:topic` — Shopify webhooks (HMAC verified)
- `POST /webhooks/bosta` — Bosta status webhooks

See [Gazelle-ERP-OMS-SRS.md](./Gazelle-ERP-OMS-SRS.md) for full requirements.

## Inventory atomicity

Every stock mutation writes an `inventory_ledger` entry and updates `variants` stock fields in a **single MongoDB transaction**. Transactions fail on standalone MongoDB — always use a replica set.
