# Gazelle OMS - Technical Overview

Snapshot of `Gazelle-back` (API) and `Gazelle-fron` (web app) as of Oct 2026.
This file is the summary. The function-by-function reference is in the five files listed at the bottom.

---

## 1. Project brief

**What it is.** An internal order-management and back-office system for Gazelle, an Egyptian footwear brand that sells on Shopify. Every Shopify order (plus manual orders from Instagram, WhatsApp, phone and so on) lands in the OMS. Staff then call the customer to verify it, the warehouse packs it, and it ships via Bosta, a local courier or store pickup. The OMS then tracks the order until it is delivered or comes back as a return, exchange or refund. It is also the stock source of truth: warehouse stock minus held stock is pushed to Shopify as "available". Smaller modules cover finance (COGS, P&L, expenses, journal), manufacturing (factories, purchase orders), HR (employees, attendance, leave, payroll) and analytics dashboards.

**Users (3 roles).**
- `admin`: everything, including finance, users, settings and analytics.
- `orders_manager`: verification calls, manual, exchange and return orders, shipping lanes, returns and pending refunds.
- `stock_manager`: fulfillment (pick, pack, AWB), warehouse review, return receiving scans, stock intake and adjust, catalog.

**Tech stack.**

| Layer | Tech |
|---|---|
| Frontend | React 19, Vite 8, React Router 7, TanStack Query 5, plain CSS (`global.css`), Recharts, html5-qrcode / BarcodeDetector for scanning. Hosted on Vercel. |
| Backend | Node 20+, Express 4, Mongoose 8 on MongoDB (replica set, used for transactions), Agenda 5 (Mongo-backed job queue), zod (env and some input), pino, helmet, exceljs, bwip-js (barcodes), sharp, multer. Hosted on the Render free plan. |
| Integrations | Shopify Admin API (GraphQL and REST, webhooks with HMAC), Bosta API v2 (shipments, CRP/RTO, webhook and polling), Paymob (payment webhook, HMAC-SHA512). |

**Architecture.**

```
 Shopify store --webhooks--> /webhooks/shopify --+
 Bosta ---------webhooks--> /webhooks/bosta -----+--> services (order, stock, fulfillment, returns, ...)
 Paymob --------webhooks--> /webhooks/paymob ----+         |            |               |
                                                           v            v               v
 React SPA (Vercel) --JWT--> /api/v1/* routes -> controllers      MongoDB      Agenda jobs (sync, polling,
                                                                  (Mongoose)   integrity, OOS release, CRP)
                                                           |
                                                           +--> Shopify Admin API (inventorySetQuantities,
                                                           |    fulfill / cancel orders)
                                                           +--> Bosta API (create SEND / CRP / RTO, track)
```

- **Backend layering:** `routes` (auth and role guards) -> `controllers` (thin request mapping) -> `services` (business rules, transactions) -> `models`. External APIs sit in `src/integrations/*` and inbound webhooks in `src/webhooks/*`.
- **Order status rules:** every status change goes through `services/orderStateMachine.js` + `order.service.transitionOrder`. That code writes `OrderStatusHistory` and, for delivery and ready, the stock ledger.
- **Stock changes:** every stock change is an `InventoryLedger` entry applied in a Mongo transaction (`applyLedgerEntries`), then pushed to Shopify (`enqueueShopifySync`).
- **Background work:** Agenda jobs run in the same process as the API (`server.js`), or optionally in a separate worker (`workers/agendaWorker.js`).
- **Free-plan uptime:** `utils/keepAwake.js` plus a GitHub Action keep the free Render instance awake during Cairo working hours (Sat-Thu).
- **Frontend data:** all data comes through one API client (`src/api/client.js`) and TanStack Query, with polling for queue counts. Role gating in the UI is cosmetic; the backend enforces roles with `requireRoles`.

---

## 2. Folder structure

```
Gazelle-back/
  render.yaml                 Render service definition (free plan, env vars)
  .github/workflows/          morning-wake.yml (wakes the free instance before work)
  scripts/                    one-off maintenance / repair scripts (dry-run by default, --apply to write)
  docs/technical-overview/    this documentation
  src/
    server.js                 boot: DB, Agenda, catalog bootstrap, listen, keep-awake, shutdown
    app.js                    Express app: helmet, CORS, webhooks, /api/v1, error handlers
    config/                   env schema (zod), Mongo connection, Agenda instance
    constants/                enums: order statuses, roles, ledger types, notification types
    middleware/               auth (JWT), rbac (requireRoles, financial field stripping), validate, errors
    models/                   26 Mongoose models (see section 5)
    routes/                   16 routers mounted under /api/v1 (about 150 endpoints)
    controllers/              15 controllers, one per router
    services/                 business logic: order.service (about 3,600 lines), stock, fulfillment,
                              returns, exchange, reports, accounting, HR, notifications, integrity
    integrations/
      shopify/                client, catalog/order sync, inventory push, fulfill, write policy
      bosta/                  client, shipments (SEND/CRP/RTO), tracking, returns sync, fees, cities
      paymob/                 payment and transaction sync
    webhooks/                 Shopify / Bosta / Paymob routers + HMAC verifiers + Shopify handlers
    jobs/index.js             all Agenda job definitions and recurring schedules
    workers/agendaWorker.js   optional standalone job worker
    utils/                    money, phone, dates, policy/AWB printing, Excel, keep-awake, etc.

Gazelle-fron/
  vercel.json / vite.config   SPA hosting and build
  src/
    main.jsx, App.jsx         providers (QueryClient, Auth, Toast), router, error boundary
    api/client.js             single fetch wrapper + every API namespace (ordersApi, inventoryApi, ...)
    auth/                     AuthContext, ProtectedRoute, GuestRoute
    routes/                   lazy page map, route table
    layouts/AppShell.jsx      sidebar, mobile bottom nav, notification bell, idle polling pause
    pages/
      orders/                 lists by lane, verify queue, order detail, manual order, customers
      stock/                  fulfillment, warehouse review, returns scan, catalog, stock adjust,
                              on hold, low stock, discrepancies
      admin/                  dashboards and analytics, ops center, finance, manufacturing, HR,
                              users, settings, audit log
    components/
      orders/                 OrderDetail + action panels (verify, exceptions, pickup, local, Bosta),
                              OrderListTable, MobileOrderCard, PendingRefundCard
      ui/                     modal, toast, sheets, tables, sticky bars, badges
      dashboard/, finance/    charts
    hooks/                    queue counts, idle pause, media queries
    utils/                    role config and nav, money/COD rules, policy printing, scan helpers,
                              order labels/meta
    styles/global.css         all styling (about 5,200 lines)
```

---

## 3. Function-by-function breakdown

There are too many functions to inline here. Each reference file has one table per source file with the columns name, purpose, inputs -> outputs and calls:

| File | Covers |
|---|---|
| [back-core.md](./back-core.md) | `server.js`, `app.js`, config, middleware, constants, all routes + controllers, **data models**, **API endpoints** |
| [back-services.md](./back-services.md) | every file in `src/services/`, plus order lifecycle and stock model write-ups |
| [back-integrations.md](./back-integrations.md) | Shopify / Bosta / Paymob integrations, webhooks, jobs, workers, utils, scripts |
| [front-pages.md](./front-pages.md) | app shell, auth, API client, hooks, utils, every page, **route/role table**, **API client map** |
| [front-components.md](./front-components.md) | every component in `src/components/`, UI flows by component |

---

## 4. Main flows (end to end)

**A. Login**
1. `LoginPage` -> `authApi.login` -> `POST /auth/login` (`auth.controller.login`: bcrypt check, JWT signed with `JWT_SECRET`).
2. The token and user are stored in `localStorage` (`api/client.js`). `AuthContext` re-checks with `GET /auth/me`.
3. `RoleRedirect` sends the user to their home page: admin -> `/admin/dashboard`, orders manager -> `/orders/verify`, stock manager -> `/orders/warehouse`.
4. Every API route uses `middleware/auth.authenticate` + `rbac.requireRoles`.

**B. Shopify order -> verified**
1. Shopify sends `orders/create` -> `webhooks/shopify.router` (HMAC via `verifyShopifyHmac`, `WebhookReceipt` dedupe) -> `shopify.handlers.handleOrdersCreate`.
2. The handler upserts the `Customer`, creates the `Order` in `pending_verification` and calls `stock.service.reserveStockForOrder`. That writes `on_hold_reserve` ledger entries and pushes sellable stock to Shopify.
3. The orders manager opens `/orders/verify` (`VerifyOrdersPage` -> `OrderDetail` -> `VerificationPanel`), calls the customer and picks an outcome. This calls `ordersApi.verify` -> `POST /orders/:id/verify` -> `order.service.verifyOrder`.
4. The outcome moves the order to `verified_ready_for_shipping` (holds topped up), `no_response`, or `cancelOrder` (holds released, order cancelled on Shopify).
5. `orders/updated` webhooks keep money, lines and address in sync (`syncOrderMoney.service`), unless the team edited the address (`shippingAddressLockedAt`).

**C. Manual / exchange / return order**
1. `ManualOrderPage` -> `ordersApi.createManual` -> `POST /orders/manual` -> `order.service.createManualOrder`.
2. A normal, exchange or local order starts in `verified_ready_for_shipping` with holds.
3. A Bosta return goes straight to `returning_to_origin` and books a Bosta CRP pickup (`ensureBostaDeliveryForOrder`). It never enters Fulfillment.
4. Exchange lookups (`GET /orders/exchange-lookup`) prefill the customer and lines from the original order.

**D. Fulfillment (pick, pack, ship)**
1. The stock manager works from `/stock/fulfillment` (`FulfillmentPage`). `fulfillmentApi.pickList` returns the Ready orders, and the scan panel checks SKUs.
2. **Bosta:** `prepareAwbForOrder` / `createBostaShipmentForOrder` (Agenda job `bosta-create-shipment` or inline) creates the Bosta SEND delivery and prints the AWB. The order moves to `awaiting_bosta_pickup`.
3. **Local courier:** `pickAndPackOrder` -> `local_shipping`. Later steps are Delivered, partial delivery, or back-from-courier (`LocalShippingActions`).
4. **Store pickup:** `pickAndPackOrder` -> `delivered`.
5. **Out of stock:** `markOrderOutOfStock` keeps the hold. `releaseOutOfStockOrdersIfRestocked` and the matching job move orders back to Ready in FIFO order when stock arrives.

**E. Bosta tracking -> delivered**
1. `POST /webhooks/bosta` and the polling job (`integrations/bosta/tracking.service`) map the Bosta state through `BostaStatusMapping`, then call `transitionOrderStatus`.
2. The order moves `picked_up_by_bosta` -> `in_transit` -> `delivered`.
3. On `delivered`, `buildDeliveryStockEntries` releases the hold and decrements `realStock`. Bosta COD is recorded (`bostaCollectedAmount`).

**F. Returns, RTO and refunds**
1. A failed delivery or customer return moves to `returning_to_origin`, then `returned_awaiting_receipt` (back at Bosta).
2. The warehouse scans it in on `/stock/returns` (`ReturnsPage`) -> `confirmReturnedToStock`. This increments `realStock` for sold units or releases the hold for unsold ones.
3. The order then ends in `returned_to_stock`, `pending_refund`, `cancelled` or `pending_verification` (exchange).
4. An admin pays pending refunds via `PendingRefundCard` -> `POST /orders/:id/confirm-refund-paid` -> `returned_to_stock`.

**G. Stock sync with Shopify**
1. **Outbound:** after every ledger commit, `enqueueShopifySync` -> `pushWarehouseStock.syncVariantAvailableToShopify` sets the absolute `available` value (`inventorySetQuantities`). There are 3 retries, then a fallback Agenda job.
2. **Inbound:** Shopify `inventory_levels/update` -> `queueShopifyInventoryIngest`. Decreases are debounced 12 s, our own echoes are ignored, and anything else becomes a manual `realStock` adjustment.
3. **Integrity:** the `repairStockIntegrity` job rebuilds `onHoldStock` from the ledger. `DiscrepancyAlert` records drift.

**H. Payments (Paymob)**
- `POST /webhooks/paymob` (HMAC-SHA512) -> `paymob/payments.service.recordPaymobPayment` stores the amount in `PaymobReceived`. It does not link to orders; it feeds the finance and collections totals. `transactions.service` can backfill from the Paymob API.
- An order's "paid online" status comes from Shopify (`financial_status` in `shopify.handlers` / `orderMoney.js` sets `onlinePaymentStatus` and `onlinePaidAt`). Prepaid orders get COD 0 on Bosta.

**I. Admin back office**
- Dashboards: `reports.service` uses `ReportOrder`, a view of orders without repairs.
- COGS: `CogsBatch`, `Variant.cogs`.
- Accounting: `GLAccount`, `JournalEntry`, `BrandExpense` / `MonthlyExpense` -> P&L.
- Manufacturing: `Factory`, `PurchaseOrder`; "receive" does a stock intake.
- HR: `Employee`, `Attendance`, `LeaveRequest`, payroll.

---

## 5. Data layer

**Models (26, in `src/models/`).** Full field lists are in [back-core.md, "Data models"](./back-core.md#data-models).

| Area | Models |
|---|---|
| Orders | `Order` (central document), `ReportOrder` (same collection, excludes repairs), `OrderStatusHistory`, `Customer` |
| Catalog and stock | `Product`, `Variant` (`realStock`, `onHoldStock`, `onlineStock`, `cogs`), `InventoryLedger`, `CogsBatch`, `DiscrepancyAlert` |
| Integrations | `Settings` (singleton, includes Shopify tokens), `BostaStatusMapping`, `BostaReturn`, `PaymobReceived`, `WebhookReceipt` |
| Staff and app | `User`, `Notification` |
| Finance | `GLAccount`, `JournalEntry`, `BrandExpense`, `MonthlyExpense` |
| Manufacturing | `Factory`, `PurchaseOrder` |
| HR | `Employee`, `Attendance`, `LeaveRequest` |

**Key relationships**
- `Order.customerId -> Customer`. `Order.items[].variantId -> Variant -> Product -> Factory`.
- `Order -> Order` self-links: `exchangeFromOrderId`, `returnFromOrderId`.
- `OrderStatusHistory`, `InventoryLedger`, `DiscrepancyAlert`, `Notification`, `JournalEntry` and `BostaReturn` each point to an `Order`. The ledger and alerts also point to a `Variant`.
- `PurchaseOrder -> Factory`, `items[] -> Variant`. `JournalEntry.lines[] -> GLAccount`.
- `Employee -> User`. `Attendance` and `LeaveRequest` -> `Employee`.
- `MonthlyExpense.expenseKey -> BrandExpense.key` is a string join, not an ObjectId.

**Stock invariant:** sellable = `realStock - onHoldStock`. That is the value pushed to Shopify. Every change is an `InventoryLedger` row (`on_hold_reserve`, `on_hold_release`, `real_stock_decrement`, `real_stock_increment_return`, `real_stock_increment_manual`).

**API endpoints.** About 150 routes under `/api/v1`, plus `/webhooks/{shopify,bosta,paymob}` and `GET /api/v1/health`. The full method/route/role/purpose table is in [back-core.md, "API endpoints"](./back-core.md#api-endpoints).

| Mount | Purpose | Main roles |
|---|---|---|
| `/auth` | login, me | public / any |
| `/orders` | lists, counts, detail, verify, manual/repair create, status, address, exchange items, cancel, returns confirm, refunds, exports | A, OM (some SM) |
| `/fulfillment` | pick list, AWB, pick & pack, Bosta shipment, local manifest, OOS | A, SM (some OM) |
| `/inventory` | variants, catalog, intake, adjust, ledger, on-hold, low stock, discrepancies, Excel import/export | A, SM (read: OM) |
| `/customers` | list, detail, risk flag, import | A, OM |
| `/products` | product list, COGS, barcode labels | A (+SM) |
| `/reports` | dashboard summary, delivery / collections / returns / exchanges analytics, P&L | A |
| `/accounting` | chart of accounts, journal, expenses, P&L, top products | A |
| `/manufacturing` | factories, purchase orders, receive | A |
| `/hr` | employees, attendance, leave, payroll | A |
| `/users`, `/settings` | staff accounts; Shopify/Bosta settings and status mappings | A |
| `/integrations`, `/integrations/shopify` | sync triggers, health, setup | A |
| `/notifications` | in-app notifications | any |
| `/reference` | Bosta cities | any |

---

## 6. Issues and gaps (prioritised)

Items marked **(verified)** were checked by hand in the code. The rest come from the file-by-file review; the reference files give the exact line numbers.

### Security (fix first)
1. **Bosta webhook is unauthenticated (verified).** `src/webhooks/bosta.router.js` accepts any POST, so anyone who knows the URL can move orders to delivered or returned. Add a shared secret header or token check.
2. **COGS leak to non-admins (verified).** `rbac.sanitizeFinancialResponse` strips financial fields only from `body.data` or top-level keys. `listOrders` returns `{orders, total}` and `listVariants` returns `{variants, total}`, so `cogs` and `totalCogsSnapshot` reach orders and stock managers.
3. **Shopify HMAC fails open outside production.** No login rate limit. CORS allows all origins when `CORS_ORIGIN` is empty. Shopify tokens and secrets are stored in plaintext in `Settings`.
4. **Frontend:** the JWT is kept in `localStorage`. There is no global 401 handling, so an expired session leaves pages failing instead of returning to login. A corrupted `gazelle_user` value white-screens the app, because it is parsed outside the error boundary. Barcode labels use `document.write` with server HTML.

### Stock and money correctness
5. **"Add intake" in Stock Adjust edit mode doubles stock (verified).** Edit mode seeds the quantities with current `realStock`, and "Add intake" posts them as amounts to add.
6. **The generic status endpoint bypasses business rules (verified).** `PATCH /orders/:id/status` lets admin/OM jump to `cancelled` or `returned_to_stock` without `cancelOrder` / `confirmReturnedToStock` side effects, so holds are not released and Shopify is not updated. The nightly integrity job only partly cleans this up.
7. **Webhook receipts are saved before processing.** In the Paymob and Shopify paths, a failure after the receipt is saved makes the provider's retry look like a duplicate, so the event is lost.
8. **`enqueueShopifySync({forcePolicyFull})` flips the Shopify write policy to `full`,** silently overriding an admin's `oms_only` choice.
9. **Race conditions:**
   - The OOS release can double-release under concurrency.
   - Manual orders can get a double hold at verify, because reserve-at-create plus the verify top-up is not idempotent for manual orders.
   - A failed `getDelivery` can lead to a second Bosta shipment being created.
10. **Catalog sync hard-deletes archived Shopify products.** This can orphan order lines and ledger rows.
11. **COD / refund math is implemented in 3+ places on the frontend** (`policyMoney.js`, `FulfillmentPage`, `ManualOrderPage`, `OrderDiscountPanel`), so the printed policy and the warehouse card can show different amounts to collect.
12. **Fulfillment scan has no repeat-scan de-dup.** One box in front of the camera can count several units.

### Reliability and UX gaps
13. **Lists that cap results on the client:**
    - `ReturnsPage` (50 per lane) and `OrderListTable` kind/date filters (500) filter on the client, so older matches disappear.
    - `OrderQueueNavigator` fetches the newest 100 orders, then sorts oldest-first, so the oldest orders in a queue are never reached.
14. **Mutations with no error feedback:** users, risk flag, Bosta mapping, factories, purchase orders, all HR pages, notifications.
15. **Half-finished analytics drilldowns:**
    - Date ranges are ignored by `OrdersListPage`.
    - "With courier" links to a tab that doesn't exist.
    - "COD left to collect" links to Returns.
16. **Timezone mix:** HR pages use UTC dates, while the rest of the app uses Cairo time.
17. **Unreachable "Convert to Return" for failed deliveries.** The `ExceptionActions` retry mode is behind a `!isOM` branch that no role can reach. `AwaitingBostaActions` is shown to orders managers only, not admins.
18. **Pages in no navigation:** HR (5 pages), Settings, Audit log and Discrepancies are routed but have no nav entry. The audit log can't page past page 1.

### Maintainability
19. **Very large files:**
    - Backend: `order.service.js` (about 3,600 lines).
    - Frontend pages: `ManualOrderPage.jsx` (about 2,360), `FulfillmentPage.jsx` (about 1,580).
    - Frontend components: `OrderListTable.jsx` (about 970), `OrderDetail.jsx` (about 870).
    - Styles: `global.css` (about 5,200).
20. **Dead code:**
    - Pages: `AdminDashboard.jsx` and 5 legacy queue pages.
    - Components: `FinanceCharts.jsx` and 6 unused chart exports.
    - Utils: `routeMeta.js`.
    - API client: 23 functions that are never called.
    - Backend: the unused `validate` middleware and the declared-but-unwritten `online_stock_increment_api` ledger type.
21. **Duplicated helpers:**
    - Unit counts (5 copies).
    - EGP formatters (3).
    - Print helpers (3).
    - Returns-lane counts (2).
    - Status lists.
    - Two cache keys for `/orders/counts` and for the catalog.
22. **Tooling:** `npm run lint` fails with 23 errors on the frontend. Frontend tests cover only `src/utils`. `scripts/` has many one-off repair scripts that should be archived once they've been run.
23. **Accessibility:**
    - Modals have no Escape key or focus trap.
    - Toasts are not keyboard reachable.
    - There are links inside buttons in `MobileOrderCard`.
    - Many labels are not tied to their inputs.

### Suggested order of work
1. Fix #1, #2 and #5 (small changes, high impact).
2. Fix #6 and #7, which protect stock and payment correctness.
3. Fix #11 by making one shared COD function.
4. Fix #13 by moving filtering to the server.
5. Split the large files and remove dead code, then make lint pass.
