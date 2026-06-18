# Gazelle ERP / Order Management System
## Software Requirements Specification & System Architecture Document

| Field | Value |
|---|---|
| Document Type | Software Requirements Specification (SRS) & System Architecture |
| System Name | Gazelle ERP/OMS |
| Integrations | Shopify Admin API (GraphQL), Bosta Shipping API |
| Version | 1.0 |
| Status | Draft for Development |

---

## Table of Contents

1. Introduction and Scope
2. System Overview and Core Logic
3. Functional Requirements
4. Database Schema Design
5. State Machine and Inventory Lifecycle
6. API Integration Architecture
7. Non-Functional Requirements
8. Glossary

---

## 1. Introduction and Scope

### 1.1 Purpose

Gazelle ERP/OMS is an internal operations platform that sits between the Shopify storefront and the physical warehouse/shipping reality of the business. Its purpose is to give staff a single interface to validate, fulfill, track, and financially analyze every order, without requiring direct access to the Shopify admin panel.

### 1.2 Problem Statement

Shopify's native inventory model decrements stock at the moment of checkout and only re-increments it through manual or app-triggered intervention. For a cash-on-delivery (COD) heavy market, this produces a structural mismatch: a large share of orders are cancelled, rejected at the door, or returned after the storefront has already told other customers the item is unavailable. Gazelle ERP/OMS resolves this by treating "sold on Shopify" and "physically gone from the warehouse" as two distinct, independently tracked states, reconciled automatically as the shipment's real-world outcome becomes known through Bosta.

### 1.3 Scope

In scope: order validation workflow, dual-inventory tracking, Shopify product/variant sync, Bosta shipment creation and tracking, customer CRM, COGS and margin tracking, role-based dashboards.

Out of scope: payment gateway processing (handled natively by Shopify), the customer-facing storefront itself, accounting/tax filing, and supplier/purchase-order management (treated as a future phase).

### 1.4 Actors

| Actor | Description |
|---|---|
| Admin | Business owner or operations lead. Full system and financial visibility. |
| Orders Manager | Validates orders with customers, manages exceptions (cancellations, exchanges, refunds). |
| Stock Manager | Owns physical warehouse accuracy and fulfillment execution. |
| Shopify | External system of record for catalog, checkout, and payment. |
| Bosta | External system of record for last-mile shipping and COD collection. |

---

## 2. System Overview and Core Logic

### 2.1 Dual-Inventory Model

The system maintains three numbers per variant, all owned by Gazelle ERP/OMS and pushed outward to Shopify only on the "online stock" dimension:

| Quantity | Meaning | Who decrements it | Who increments it |
|---|---|---|---|
| `online_stock` | What Shopify shows as purchasable | Shopify, automatically, at checkout | Gazelle, via API call, on cancel/fail/return |
| `on_hold_stock` | Physically present but reserved against an unresolved order | Gazelle, when an order is created | Gazelle, when the order resolves (delivered or released) |
| `real_stock` | Physically present and unreserved units in the warehouse | Gazelle, only on confirmed Delivered | Gazelle, on manual warehouse adjustment or restock |

The invariant the system must always hold is:

```
real_stock (before reservation) = real_stock (current, unreserved) + on_hold_stock
```

A unit is only permanently removed from the warehouse's books when Bosta confirms delivery. Until then, it is "real but spoken for."

### 2.2 Lifecycle Summary

| Trigger | online_stock | on_hold_stock | real_stock | Notes |
|---|---|---|---|---|
| Order placed on Shopify | -1 (by Shopify itself) | +1 | unchanged | Webhook `orders/create` informs Gazelle; Gazelle does not touch online_stock here, Shopify already did |
| Order verified by Orders Manager | unchanged | unchanged | unchanged | Status transition only, queues item for Stock Manager |
| Pushed to Bosta / picked up | unchanged | unchanged | unchanged | AWB created, physical handoff to courier |
| Bosta confirms Delivered | unchanged | -1 | -1 | Sale is now final in both ledgers |
| Bosta confirms Failed/Returned, or Orders Manager cancels/refunds pre-delivery | +1 (Gazelle calls Shopify) | -1 | unchanged | Unit returns to sellable, real_stock untouched because it was never removed |

### 2.3 Product Source of Truth

Shopify remains the single source of truth for product existence, titles, images, options, variants, and selling price. Gazelle never creates a product locally; it only consumes Shopify's product/variant feed via webhook and periodic reconciliation sync, and attaches Gazelle-only fields (COGS, real_stock, on_hold_stock) to the synced variant record by SKU and Shopify variant ID.

---

## 3. Functional Requirements

Each epic below is written as a set of discrete, independently testable capabilities.

### 3.1 Admin

**Epic A1: Global Visibility**

- A1.1 — View a consolidated dashboard showing total orders by status, daily/weekly/monthly revenue, and delivery success rate.
- A1.2 — Drill into any order, customer, or product from the dashboard without role restriction.
- A1.3 — View system audit logs of inventory adjustments, status changes, and user actions, filterable by date, user, and entity.

**Epic A2: Financial and Profitability Management**

- A2.1 — Enter and edit the COGS for a given product variant, optionally per batch (since manufacturing cost can change between production runs).
- A2.2 — View, per order and in aggregate, gross margin computed as `(selling_price - cogs) * quantity`, factoring in Bosta's COD/shipping fee if it is deducted from the business.
- A2.3 — View profitability reports segmented by product, category, and time period, exportable to CSV.
- A2.4 — Restrict COGS and margin data from being visible to the Orders Manager and Stock Manager roles at the API authorization layer, not just the UI layer.

**Epic A3: User and Role Administration**

- A3.1 — Create, deactivate, and reassign roles for Orders Manager and Stock Manager accounts.
- A3.2 — View a per-user activity log (orders validated, orders fulfilled, average handling time).

**Epic A4: Configuration**

- A4.1 — Manage Shopify and Bosta API credentials/connection health from a settings screen, with a manual "force resync" action.
- A4.2 — Define and edit the canonical list of internal order statuses and their mapping to Bosta webhook states.

### 3.2 Orders Manager

**Epic O1: Order Verification Queue**

- O1.1 — View an incoming queue of orders in `Pending Verification` status, sorted by order age (oldest first by default).
- O1.2 — Open an order to see the full customer profile, shipping address, items, and any prior order history with that customer (to flag repeat COD-rejecters).
- O1.3 — Call or message the customer (the system logs the contact attempt and outcome, but does not need to embed telephony itself) and record a verification outcome: Confirmed, No Response, Customer Requested Changes, Customer Cancelled.
- O1.4 — Move a confirmed order to `Verified / Ready for Shipping`, which makes it visible to the Stock Manager queue.
- O1.5 — Edit an order's shipping address or contact phone number prior to verification, with the edit reflected back so Bosta receives accurate data at shipment-creation time.

**Epic O2: Exception Handling**

- O2.1 — Cancel an order pre-fulfillment, with a required reason code (Customer Changed Mind, Duplicate Order, Out of Stock, Fraud Suspected, Other). Cancelling triggers the on_hold release and Shopify online_stock increment described in Section 2.2.
- O2.2 — Process a size/variant exchange before shipment: release the on_hold unit of the original variant, place a new on_hold reservation on the requested variant, and re-verify availability before confirming the exchange to the customer.
- O2.3 — Process a refund request, distinguishing between pre-delivery (full stock release) and post-delivery returns (which additionally trigger a real_stock increment once the returned item physically re-enters the warehouse, confirmed by the Stock Manager).
- O2.4 — View and act on Bosta's `Failed Delivery` webhook notifications, deciding whether to re-attempt delivery, reschedule, or convert to `Returned to Stock`.

**Epic O3: Customer Relationship Tracking**

- O3.1 — View a customer's lifetime value, total orders, total successful deliveries, total rejected/returned orders, and a computed "delivery reliability score."
- O3.2 — Flag a customer profile (e.g., "high-risk COD," "VIP") visible to Admin and Orders Manager, used to optionally require pre-payment or extra verification on future orders.
- O3.3 — Track delivery success rate as a team-level and individual-order-manager-level metric for performance review by Admin.

### 3.3 Stock Manager

**Epic S1: Fulfillment Queue**

- S1.1 — View orders in `Verified / Ready for Shipping` status as a pick list, groupable by SKU to support batch picking.
- S1.2 — Mark an order's items as physically picked and packed, which generates the shipment request to Bosta (Section 6.2) and transitions the order to `Picked up by Bosta` once Bosta confirms pickup.
- S1.3 — Print or retrieve the Bosta AWB/shipping label for a verified order.

**Epic S2: Physical Inventory Management**

- S2.1 — Perform manual real_stock adjustments (restock from a new production batch, damage write-off, stocktake correction), each requiring a reason code and creating an immutable ledger entry.
- S2.2 — Confirm physical receipt of a `Returned to Stock` item, which is the action that actually increments real_stock for post-delivery returns (the system does not assume the item is back just because Bosta marked it returned; this requires explicit warehouse confirmation to avoid phantom stock).
- S2.3 — View a low-stock alert list based on real_stock falling under a configurable per-variant threshold.
- S2.4 — View discrepancy reports where on_hold_stock and real_stock arithmetic does not reconcile, to catch sync bugs before they cause overselling.

---

## 4. Database Schema Design

The schema below is written in a relational style (PostgreSQL-oriented), since the dual-inventory invariant and financial reporting requirements benefit from transactional integrity and constraint enforcement. Each table includes a brief note on relations.

### 4.1 `users`

| Column | Type | Notes |
|---|---|---|
| id | UUID, PK | |
| name | VARCHAR(120) | |
| email | VARCHAR(255), UNIQUE | |
| password_hash | VARCHAR(255) | |
| role | ENUM('admin','orders_manager','stock_manager') | |
| is_active | BOOLEAN, default true | |
| created_at | TIMESTAMPTZ | |
| last_login_at | TIMESTAMPTZ | |

### 4.2 `customers`

| Column | Type | Notes |
|---|---|---|
| id | UUID, PK | |
| full_name | VARCHAR(120) | |
| phone | VARCHAR(20), indexed | Primary dedup key alongside name, since guest checkout customers may reuse phone numbers across orders |
| email | VARCHAR(255), nullable | |
| risk_flag | ENUM('none','watch','high_risk','vip'), default 'none' | Set by O3.2 |
| lifetime_orders | INTEGER, default 0 | Denormalized counter, maintained by trigger or application logic for fast dashboard reads |
| lifetime_delivered | INTEGER, default 0 | |
| lifetime_rejected_or_returned | INTEGER, default 0 | |
| created_at | TIMESTAMPTZ | |

### 4.3 `customer_addresses`

| Column | Type | Notes |
|---|---|---|
| id | UUID, PK | |
| customer_id | UUID, FK → customers.id | |
| label | VARCHAR(50) | e.g. "Home", "Work" |
| address_line1 | VARCHAR(255) | |
| address_line2 | VARCHAR(255), nullable | |
| city | VARCHAR(100) | Should align with Bosta's supported city enum |
| zone | VARCHAR(100), nullable | |
| is_default | BOOLEAN | |

### 4.4 `products`

| Column | Type | Notes |
|---|---|---|
| id | UUID, PK | |
| shopify_product_id | VARCHAR(64), UNIQUE | Stored as Shopify GID, e.g. `gid://shopify/Product/...` |
| title | VARCHAR(255) | Synced, read-only from Gazelle's perspective |
| category | VARCHAR(100), nullable | |
| status | ENUM('active','archived','draft') | Mirrors Shopify product status |
| last_synced_at | TIMESTAMPTZ | |

### 4.5 `variants`

| Column | Type | Notes |
|---|---|---|
| id | UUID, PK | |
| product_id | UUID, FK → products.id | |
| shopify_variant_id | VARCHAR(64), UNIQUE | Shopify GID |
| shopify_inventory_item_id | VARCHAR(64) | Needed for the inventory mutations described in Section 6.1 |
| sku | VARCHAR(100), indexed | |
| title | VARCHAR(255) | e.g. "Red / Large" |
| selling_price | DECIMAL(10,2) | Synced from Shopify |
| cogs | DECIMAL(10,2), default 0 | Admin-managed, never synced from Shopify |
| online_stock | INTEGER | Mirrors Shopify's available quantity; updated by webhook and by Gazelle's own outbound calls |
| on_hold_stock | INTEGER, default 0 | Gazelle-owned, CHECK (on_hold_stock >= 0) |
| real_stock | INTEGER, default 0 | Gazelle-owned, CHECK (real_stock >= 0) |
| low_stock_threshold | INTEGER, default 5 | Used by S2.3 |
| last_synced_at | TIMESTAMPTZ | |

### 4.6 `orders`

| Column | Type | Notes |
|---|---|---|
| id | UUID, PK | |
| shopify_order_id | VARCHAR(64), UNIQUE | |
| customer_id | UUID, FK → customers.id | |
| shipping_address_id | UUID, FK → customer_addresses.id | |
| internal_status | ENUM(...) | See Section 5.1 for the full state list |
| bosta_delivery_id | VARCHAR(64), nullable | Populated once pushed to Bosta |
| bosta_tracking_number | VARCHAR(64), nullable | |
| assigned_orders_manager_id | UUID, FK → users.id, nullable | |
| assigned_stock_manager_id | UUID, FK → users.id, nullable | |
| total_selling_price | DECIMAL(10,2) | Denormalized snapshot at order time, since selling_price on a variant can change later |
| total_cogs_snapshot | DECIMAL(10,2) | Snapshotted at verification time so later COGS edits do not retroactively change historical margin reports |
| cancellation_reason | VARCHAR(100), nullable | |
| placed_at | TIMESTAMPTZ | |
| verified_at | TIMESTAMPTZ, nullable | |
| delivered_at | TIMESTAMPTZ, nullable | |
| closed_at | TIMESTAMPTZ, nullable | Set when the order reaches any terminal state |

### 4.7 `order_items`

| Column | Type | Notes |
|---|---|---|
| id | UUID, PK | |
| order_id | UUID, FK → orders.id | |
| variant_id | UUID, FK → variants.id | |
| quantity | INTEGER | |
| unit_selling_price | DECIMAL(10,2) | Snapshot |
| unit_cogs | DECIMAL(10,2) | Snapshot |

### 4.8 `order_status_history`

| Column | Type | Notes |
|---|---|---|
| id | UUID, PK | |
| order_id | UUID, FK → orders.id | |
| from_status | VARCHAR(50), nullable | |
| to_status | VARCHAR(50) | |
| source | ENUM('shopify_webhook','bosta_webhook','user_action','system') | |
| actor_user_id | UUID, FK → users.id, nullable | Null when source is a webhook |
| note | TEXT, nullable | |
| created_at | TIMESTAMPTZ | |

This table is the audit trail referenced in A1.3 and is the basis for the state machine transition log in Section 5.

### 4.9 `inventory_ledger`

| Column | Type | Notes |
|---|---|---|
| id | UUID, PK | |
| variant_id | UUID, FK → variants.id | |
| order_id | UUID, FK → orders.id, nullable | Null for manual warehouse adjustments |
| ledger_type | ENUM('on_hold_reserve','on_hold_release','real_stock_decrement','real_stock_increment_manual','real_stock_increment_return','online_stock_increment_api') | |
| quantity_delta | INTEGER | Signed |
| reason_code | VARCHAR(100), nullable | Required for manual adjustments (S2.1) |
| actor_user_id | UUID, FK → users.id, nullable | |
| created_at | TIMESTAMPTZ | |

Every mutation to `online_stock`, `on_hold_stock`, or `real_stock` on the `variants` table must be accompanied by exactly one row in this ledger within the same database transaction. This is the mechanism that makes the discrepancy reports in S2.4 possible, and it gives Admin a complete, replayable audit trail of where every unit went.

### 4.10 Relational Summary

```
customers 1---* customer_addresses
customers 1---* orders
products  1---* variants
orders    1---* order_items  *---1 variants
orders    1---* order_status_history
variants  1---* inventory_ledger  *---0..1 orders
users     1---* order_status_history (as actor)
users     1---* inventory_ledger (as actor)
```

---

## 5. State Machine and Inventory Lifecycle

### 5.1 Canonical Order States

| State | Description | Terminal? |
|---|---|---|
| `pending_verification` | Order received from Shopify, awaiting Orders Manager contact | No |
| `verified_ready_for_shipping` | Customer confirmed, queued for Stock Manager | No |
| `picked_up_by_bosta` | Stock Manager handed the package to the courier, Bosta has the AWB | No |
| `in_transit` | Bosta has scanned the package as moving toward the customer | No |
| `delivered` | Bosta confirmed successful delivery | Yes |
| `failed_delivery` | Bosta attempted delivery and it did not succeed (refused, unreachable, address issue) | No |
| `returning_to_origin` | Bosta is moving the package back to the warehouse | No |
| `returned_to_stock` | Stock Manager has physically confirmed receipt of the returned item | Yes |
| `cancelled` | Order cancelled by Orders Manager before pickup | Yes |

### 5.2 Step-by-Step Sequence: Happy Path (Delivered)

1. Customer checks out on Shopify. Shopify decrements `online_stock` for the purchased variant and fires the `orders/create` webhook.
2. Gazelle receives the webhook, creates an `orders` row in `pending_verification`, creates matching `order_items`, and inserts an `inventory_ledger` row of type `on_hold_reserve` for each line item, incrementing `on_hold_stock` by the ordered quantity. `real_stock` is untouched.
3. Orders Manager opens the order from the verification queue, calls the customer, and records `Confirmed`. Order moves to `verified_ready_for_shipping`. A row is appended to `order_status_history`.
4. Stock Manager picks the item physically, marks it packed. Gazelle calls the Bosta delivery-creation endpoint (Section 6.2), stores `bosta_delivery_id` and `bosta_tracking_number`, and moves the order to `picked_up_by_bosta` once Bosta confirms the courier has the package.
5. Bosta's webhook reports the package as in motion. Gazelle maps this to `in_transit`. No inventory change occurs at this step; the unit is still `on_hold`, not yet `real_stock`-decremented.
6. Bosta's webhook reports `Delivered`. Gazelle:
   - Sets `orders.internal_status = 'delivered'`, sets `delivered_at`.
   - Inserts an `inventory_ledger` row of type `on_hold_release` (on_hold_stock -1) and a row of type `real_stock_decrement` (real_stock -1) for each line item, within a single transaction.
   - Does **not** call Shopify, because `online_stock` was already correctly decremented at checkout and the sale is now final.

### 5.3 Step-by-Step Sequence: Failure Path (Cancelled / Rejected / Returned)

1. Steps 1–2 are identical to the happy path: webhook received, order created, `on_hold_stock` incremented.
2a. **Pre-shipment cancellation (O2.1):** Orders Manager cancels the order from `pending_verification` or `verified_ready_for_shipping`. Gazelle inserts an `on_hold_release` ledger row (`on_hold_stock` -1) and an `online_stock_increment_api` ledger row, then asynchronously calls the Shopify inventory-adjustment mutation to push `online_stock` +1. Order moves to `cancelled`.
2b. **Post-shipment failure (Bosta-reported):** Bosta's webhook reports `Failed Delivery`. Gazelle moves the order to `failed_delivery` and notifies the Orders Manager queue (O2.4). If the Orders Manager decides not to retry, the order is moved to `returning_to_origin`, mirroring Bosta's own return-to-origin movement.
3. Once Bosta confirms the package has physically arrived back at the business's pickup point, the order is held in `returning_to_origin` and the Stock Manager is notified.
4. **Critical control point:** the system does **not** increment `real_stock` automatically off Bosta's webhook alone. The Stock Manager must perform an explicit physical confirmation (S2.2). Only on that confirmation does Gazelle:
   - Insert an `on_hold_release` ledger row (`on_hold_stock` -1).
   - Insert a `real_stock_increment_return` ledger row (`real_stock` +1, since the unit was never actually removed from the warehouse books, this restores it to unreserved availability).
   - Insert an `online_stock_increment_api` ledger row and call Shopify to push `online_stock` +1.
   - Move the order to `returned_to_stock`.

This two-step confirmation (courier says returned, then warehouse confirms receipt) exists specifically to prevent "phantom stock," where the system believes an item is sellable again before it has actually been physically counted back into the warehouse.

### 5.4 Exchange Sub-Flow (O2.2)

An exchange is modeled as a controlled compound transaction rather than a special state:

1. Release the on_hold reservation on the original variant (`on_hold_release`, -1).
2. Check `online_stock` (or, more precisely, `real_stock - on_hold_stock` for the warehouse's true sellable view) on the requested replacement variant.
3. If available, create a new `on_hold_reserve` (+1) on the replacement variant and update the relevant `order_items` row to point at the new variant and price snapshot.
4. If not available, the exchange request stays open and the Orders Manager is prompted to offer an alternative or process a refund instead.

### 5.5 Text-Based State Diagram

```
[Shopify orders/create webhook]
        |
        v
 pending_verification ----(cancel)----------------------------> cancelled
        |
   (verified)
        v
 verified_ready_for_shipping ----(cancel)---------------------> cancelled
        |
   (picked & packed, AWB created)
        v
 picked_up_by_bosta
        |
   (Bosta: in motion)
        v
   in_transit
        |
   +----+--------------------------------+
   |                                      |
(Bosta: delivered)                (Bosta: failed delivery)
   |                                      v
   v                              failed_delivery
delivered (terminal)                     |
                                 (retry exhausted / RTO)
                                          v
                                returning_to_origin
                                          |
                            (Stock Manager confirms receipt)
                                          v
                                returned_to_stock (terminal)
```

---

## 6. API Integration Architecture

### 6.1 Shopify Integration

**Authentication:** Custom/private app using an Admin API access token with the `read_products`, `write_products`, `read_orders`, and `write_inventory` scopes at minimum.

**API surface:** The integration must use the GraphQL Admin API exclusively. Shopify's REST inventory endpoints are in maintenance mode for custom apps and are not guaranteed to receive future feature parity, so all inventory reads and writes should go through GraphQL.

**Webhooks to subscribe:**

| Topic | Purpose in Gazelle |
|---|---|
| `orders/create` | Triggers order ingestion (Section 5.2, step 2) |
| `orders/cancelled` | Catches cancellations initiated from the Shopify admin side, so Gazelle stays in sync even if a cancellation did not originate in the OMS UI |
| `orders/updated` | Catches address or line-item edits made directly in Shopify |
| `refunds/create` | Secondary signal for refund-driven exceptions, cross-checked against Gazelle's own refund workflow (O2.3) |
| `products/update` | Keeps the local `products`/`variants` cache (title, price, status) in sync |
| `inventory_levels/update` | Used defensively to detect external inventory edits made outside Gazelle (e.g., a staff member adjusting stock directly in Shopify admin), which should raise a discrepancy alert rather than be silently trusted |

All webhook payloads must be HMAC-verified against the app's shared secret before processing, and handlers should be idempotent, since Shopify can redeliver the same webhook.

**Outbound inventory mutation:** When Gazelle needs to push an `online_stock` increment (cancellation, return, exchange), it calls the `inventoryAdjustQuantities` mutation against the variant's `shopify_inventory_item_id` and the relevant location ID, applying a relative delta rather than an absolute set. This is the correct mutation for a system that is not the sole source of truth for inventory (Shopify's checkout flow is also writing to the same value), since the alternative absolute-set mutation (`inventorySetQuantities`) is documented as intended only for systems that act as the sole source of truth and is not appropriate here.

A representative request:

```graphql
mutation AdjustOnlineStock($input: InventoryAdjustQuantitiesInput!) {
  inventoryAdjustQuantities(input: $input) {
    userErrors { field message }
    inventoryAdjustmentGroup {
      createdAt
      reason
      changes { name delta }
    }
  }
}
```

with `input.changes` containing the `inventoryItemId`, `locationId`, and a `delta` of `+1` (or the relevant returned quantity), `input.name` set to `"available"`, and `input.reason` set to a Gazelle-defined value such as `"correction"` or `"restock"` for audit purposes. Current API versions require an idempotency key on this mutation (passed via the `@idempotent` directive), which should be generated as a deterministic value derived from the `inventory_ledger` row ID so that retried calls after a network failure cannot double-apply the same adjustment.

**Sync job:** In addition to webhooks, a scheduled reconciliation job (hourly is reasonable for a single-location warehouse) re-pulls the full product/variant catalog and `online_stock` levels via GraphQL and reconciles any drift against the `variants` table, logging a discrepancy alert (S2.4) rather than silently overwriting Gazelle-owned fields like `cogs`, `real_stock`, or `on_hold_stock`.

### 6.2 Bosta Integration

**Authentication:** Bosta issues a per-business API key from the dashboard's API Integration page, sent as a bearer/header credential on every request.

**Shipment creation (push verified order → Bosta):** When a Stock Manager marks an order as picked and packed (S1.2), Gazelle calls Bosta's delivery-creation endpoint with the delivery type (send/COD), package specs, drop-off/pickup address, the COD amount if applicable, the receiver's name/phone/address pulled from `customer_addresses`, Gazelle's own `order.id` as a business reference for reconciliation, and a webhook/notification URL pointing back at Gazelle's Bosta-webhook receiver. Bosta returns a delivery ID and a tracking number, both of which are persisted on the `orders` row (`bosta_delivery_id`, `bosta_tracking_number`).

**Inbound webhook (status changes → Gazelle):** Gazelle exposes a single webhook receiver endpoint that Bosta calls on every status change for a tracked delivery. The handler must:

1. Verify the payload references a known `bosta_delivery_id`.
2. Map Bosta's reported state to one of Gazelle's canonical internal statuses (Section 5.1) via a configurable lookup table (A4.2), since Bosta's exact status vocabulary should be confirmed against the live API documentation for the business's current integration tier and kept in a table rather than hardcoded in application logic, precisely so it can be corrected without a code deployment if Bosta changes their state naming.
3. Append an `order_status_history` row with `source = 'bosta_webhook'`.
4. Trigger the corresponding inventory-ledger mutation described in Section 5 (decrement `real_stock` on delivered; nothing automatic beyond flagging `returning_to_origin` on failed/returned, pending the Stock Manager's manual confirmation).

**Polling fallback:** Because webhook delivery is never 100% guaranteed, a scheduled job should periodically call Bosta's tracking/get-delivery endpoint for any order stuck in a non-terminal state for longer than a configurable threshold (e.g., 48 hours with no update), to catch missed webhooks rather than letting an order silently stall.

**AWB retrieval:** The AWB/airway-bill print endpoint is called on demand from the Stock Manager's fulfillment screen (S1.3) using the stored `bosta_delivery_id`.

### 6.3 Internal Sync Service Architecture

```
                    ┌────────────────────┐
                    │   Shopify Store     │
                    └─────────┬──────────┘
                              │ webhooks (HMAC verified)
                              ▼
                    ┌────────────────────┐
                    │  Webhook Ingress    │  (idempotent handlers,
                    │  (Gazelle API)      │   write to a durable queue)
                    └─────────┬──────────┘
                              ▼
                    ┌────────────────────┐
                    │   Job Queue /       │  (e.g. background worker
                    │   Worker Layer      │   process, retries with
                    │                     │   backoff on outbound calls)
                    └─────────┬──────────┘
                              ▼
              ┌───────────────────────────────┐
              │     Application Database        │
              │  (orders, variants, ledger, ...)│
              └───────────────┬─────────────────┘
                              ▼
                    ┌────────────────────┐
                    │  Outbound Connectors │
                    │  - Shopify GraphQL   │
                    │  - Bosta REST        │
                    └────────────────────┘
                              ▲
                              │ webhooks
                    ┌────────────────────┐
                    │     Bosta            │
                    └────────────────────┘
```

All outbound calls to Shopify or Bosta that result from an internal event (cancellation, return confirmation, shipment creation) should be queued and executed by a worker with retry-and-backoff, rather than performed synchronously inside the request that triggered them. This keeps the Orders Manager and Stock Manager UI responsive and ensures a transient Shopify or Bosta outage cannot block a staff member from completing their workflow step; the eventual API call is simply retried until it succeeds, with its outcome reflected back into the relevant `order_status_history` and `inventory_ledger` rows.

---

## 7. Non-Functional Requirements

| Category | Requirement |
|---|---|
| Authorization | Financial fields (`cogs`, margin reports) must be enforced as Admin-only at the API/query layer, not filtered client-side only |
| Idempotency | All webhook handlers and all outbound Shopify/Bosta mutations must be safely retryable without double-applying inventory changes |
| Auditability | Every inventory quantity change must have a corresponding `inventory_ledger` row; every order status change must have a corresponding `order_status_history` row |
| Consistency | Inventory ledger writes and the corresponding `variants` quantity update must occur within a single database transaction |
| Availability | Webhook ingress should acknowledge receipt quickly and defer processing to a queue, so a slow downstream step cannot cause Shopify/Bosta to consider the webhook failed and stop retrying |
| Data integrity | `on_hold_stock` and `real_stock` must be database-constrained to never go negative |
| Observability | Discrepancy alerts (S2.4) should be surfaced proactively, not only discoverable through manual report-running |

---

## 8. Glossary

| Term | Definition |
|---|---|
| AWB | Airway Bill — the shipping label/document generated by Bosta for a shipment |
| COD | Cash on Delivery |
| COGS | Cost of Goods Sold |
| On Hold | A unit that is physically in the warehouse but reserved against an unresolved order |
| RTO | Return to Origin — the courier's process of bringing a failed/rejected shipment back to the sender |
| SKU | Stock Keeping Unit, the variant-level identifier |
