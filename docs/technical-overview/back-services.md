# Gazelle backend — `src/services/`

Scope: all 29 files in `Gazelle-back/src/services/` (14,347 lines). Based on reading the code as it is in the working tree (it has uncommitted changes to `order.service.js` and `orderStateMachine.js`). Line numbers refer to that working tree.

Shared conventions you will see everywhere:
- Errors are thrown as `new Error(msg)` with `err.statusCode` set (400/404/409/502). Controllers pass them to `next(err)`.
- `withTransaction(fn)` (`utils/transaction.js`) opens a Mongo session, runs `fn(session)`, then commits or aborts. It does **not** retry on transient errors.
- Stock moves always go through `inventory.service.applyLedgerEntries` (ledger row + `$inc` on `Variant`), inside a transaction.
- Anything that has to happen after commit (Shopify push, OOS auto-release, notifications) runs after `withTransaction` returns, mostly through `order.service.afterLedgerApplied`.
- `ReportOrder` (`models/ReportOrder.js`) is a read-only clone of `Order` on the same collection that adds `isRepairOrder != true` to every query. accounting, kpi, reports and brandExpense use it, so repair orders never count as sales.

---

## Backend services: function-by-function

### src/services/order.service.js
The core order workflow (3,595 lines): status transitions, orchestrating stock-ledger moves, Shopify stock sync in both directions, manual/exchange/return orders, queues, refunds and discounts.

**Internal helpers**

| Name | What it does | Inputs → Outputs | Calls / depends on |
|---|---|---|---|
| `recordStatusChange` (L54) | Writes one `OrderStatusHistory` row | `{orderId, from, to, source, actorUserId, note}, session` → void | OrderStatusHistory |
| `REPAIR_BLOCKED_STATUSES` (L64) | Statuses a repair order may never enter (pending, no_response, ready, OOS) | const Set | — |
| `transitionOrder` (L71) | The single place that changes status. Checks the state machine plus extra rules: repair orders can't enter stock lanes; only repair orders may enter `repaired_shoe`; only return pickups can go Ready → `returning_to_origin`. Sets/unsets `verifiedAt`, `returnedFromOutOfStockAt`, `localShippingMarkedAt`, `deliveredAt`, `closedAt`. Writes history. | `order, toStatus, meta, session` → `{fromStatus,toStatus}` | `assertTransition`, `Order.updateOne`, `recordStatusChange` |
| `collectVariantIds` (L141) | Unique variant ids from ledger docs + order items | `ledgerDocs, items` → `string[]` | — |
| `enqueueShopifySync` (L154) | Pushes OMS sellable stock (real − hold) to Shopify for each variant, up to 3 tries with backoff; on failure queues the Agenda job `SHOPIFY_OUTBOUND_INVENTORY`; `strict` makes it throw 502. With `forcePolicyFull` it first **forces the Shopify write policy to `full`**. | `ledgerDocs, {forcePolicyFull, variantIds, strict, maxAttempts}` → `{synced, failed}` | `pushWarehouseStock.syncVariantAvailableToShopify`, `writePolicy.enableShopifyInventorySync/getShopifyWritePolicy`, Agenda |
| `afterLedgerApplied` (L233) | Post-commit hook: negative-stock (factory restock) alerts, Shopify sync, then a `setImmediate` OOS auto-release for any +real ledger (`real_stock_increment_manual`/`_return`) unless `skipOosAutoRelease` | `ledgerDocs, opts` → sync result | `notifyNegativeStockCrossings`, `enqueueShopifySync`, `releaseOutOfStockOrdersIfRestocked` |
| `pushSellableNow` (L280) | Shopify push for explicit ids that never throws; queues Agenda on error | `variantIds` → `{synced, failed, queued?}` | `enqueueShopifySync`, Agenda |
| `recentShopifyOrderQty` (L318) | Units of a variant on Shopify orders placed in the last 3 minutes | `variantId, windowMs` → number | Order |
| `markOnlineStock` (L338) | Sets `Variant.onlineStock` / `shopifyAvailable` | `variantId, available` → void | Variant |
| `executeDelivered` (L743) | Delivery core. Rejects `shopify_webhook`. Releases the remaining hold and decrements real stock (`buildDeliveryStockEntries`), clears leftover holds, moves to `delivered`, bumps `Customer.lifetimeDelivered`, posts the accounting journal (skipped for repair orders). For `bosta_webhook`/`shopify_import` a ledger error is logged and **swallowed**. | `order, {source, actorUserId, note}, session` → order (+`_ledgerDocs`) | inventory builders, `transitionOrder`, `recordDeliveryJournal` |
| `parseCairoDelayDate` (L2020) | Validates YYYY-MM-DD, returns Cairo noon; rejects past dates | string → `{ymd, until}` | Intl |
| `cairoTodayEnd` / `shipAfterNotDueFilter` (L2048/2058) | Mongo filter that hides Ready orders whose ship-after date is in the future | → Date / filter | — |
| `escapeRegex`, `isValidObjectId` (L2705/2709) | Regex escaping and strict ObjectId check | — | — |
| `resolveVariantForLine` (L2717) | Finds a variant by id, falling back to case-insensitive SKU (heals deleted variants) | `line, session` → Variant \| null | Variant |
| `healMissingOrderVariants` (L2743) | Replaces unresolved `items.variantId` with the live variant by SKU and **writes the fix back** | lean order → order | `resolveVariantForLine`, `Order.updateOne` |
| `ordersPlacedFromCutoff` (L2825) | Cairo midnight of `ORDERS_PLACED_FROM_YMD` (cut-over date that hides older orders from queues) | → Date | constants |

**Exported functions**

| Name | What it does | Inputs → Outputs | Calls / depends on |
|---|---|---|---|
| `syncShopifySellableAfterLedger` (L270) | Public wrapper for `afterLedgerApplied` | `ledgerDocs, opts` → sync result | `afterLedgerApplied` |
| `forceSyncVariantsToShopify` (L275) | Shopify push for explicit variant ids (2 tries) | `variantIds, opts` → sync result | `enqueueShopifySync` (used by jobs) |
| `applyShopifyAvailableToWarehouse` (L355) | Inbound Shopify inventory edit → adjusts OMS `realStock` so that real − hold = Shopify available. Ignores echoes of our own push (90 s window) and drops that match recent Shopify orders. Uses `manualStockAdjustment` with reason `shopify_restock`/`shopify_count` and no push back. | `variantId, shopifyAvailable` → `{adjusted, delta…}` \| null | Variant, `recentShopifyOrderQty`, `manualStockAdjustment` |
| `ingestShopifyAvailableIncrease` (L425) | Alias of the above (**never called**) | same | — |
| `queueShopifyInventoryIngest` (L429) | Increases are applied immediately; decreases are debounced 12 s through the Agenda job `SHOPIFY_INBOUND_INVENTORY` (unique per variant) so `orders/create` can reserve first | `variantId, shopifyAvailable` → result \| `{queued}` | Agenda, `applyShopifyAvailableToWarehouse` |
| `verifyOrder` (L460) | Call-center outcome. `customer_cancelled` → `cancelOrder`; `no_response` → `no_response`; other outcomes only add a log entry; `confirmed` → checks the contact is complete, sets shipping method/fee (local = `LOCAL_SHIPPING_FEE`, pickup = 0), clears the delay, reserves stock (manual orders: full `reserveStockForOrder`; Shopify orders: top-up `ensureOrderStockHeld`), moves to `verified_ready_for_shipping`. After commit: Shopify sync, Shopify fulfill (non-manual), notification, Shopify zero-shipping for pickup. | `orderId, actor, {outcome, note, totalCogsSnapshot, shippingMethod}` → order | `assertContactReadyToConfirm`, ledger, `transitionOrder`, `markShopifyOrderFulfilled`, `zeroShopifyShippingForPickup`, notifications |
| `cancelOrder` (L596) | Staff cancels need a note. A staff cancel of a local-shipping order that is in `local_shipping`/`failed_delivery` is redirected to `returnLocalShippingToStock(intent='cancel')`. Otherwise checks the cancellable set (wider for Shopify-driven cancels), releases **all** remaining holds on the order, moves to `cancelled`, records the customer cancellation. If already cancelled it just re-releases orphan holds. After commit: Shopify sync, OOS release, and a Shopify `orderCancel` (refund if paid online) when the cancel came from staff. | `orderId, actor, {reason, note, source}` → order (+`shopifyCancelWarning`) | `buildFullOrderHoldReleaseEntries`, `recordCustomerCancellation`, `cancelShopifyOrder` |
| `unwindFalseDeliveredSale` (L793) | When Bosta says a "delivered" order wasn't delivered: restocks the sold units, re-holds the lines, clears `deliveredAt`/`closedAt`, decrements `lifetimeDelivered`. Does not change status (the caller in `bosta/tracking.service.js` does). | `orderId, {note}` → summary | `buildOutstandingReturnRestockEntries`, `buildMissingHoldEntries` |
| `markDelivered` (L846) | Wraps `executeDelivered` in its own transaction, or reuses `existingSession`. With `existingSession` it skips the Shopify sync and low-stock check. | `orderId, source, actor, note, session?` → order | `executeDelivered`, `afterLedgerApplied`, `checkVariantsLowStock` |
| `partialLocalDelivery` (L871) | Local courier delivered only some units. Validates per-line quantities (needs ≥2 units, at least one delivered and one returned). Delivered units are finalised (hold release + decrement); undelivered units have their hold released. **Replaces `order.items` with the delivered lines only**, recomputes totals/COGS, moves to `delivered`, posts the journal. After commit: Shopify sync and OOS release for the freed SKUs. | `orderId, actor, {deliveries:[{itemId, deliveredQuantity}], note}` → order (+`_partialSummary`) | ledger builders, `transitionOrder`, `recordDeliveryJournal` |
| `returnLocalShippingToStock` (L1063) | Admin confirms the local courier brought the bag back → `back_from_local_shipping`, with `localReturnIntent` = cancel/exchange/failed (refund is stored as `failed`). Also allowed on a delivered local exchange/refund. The hold stays until the warehouse scans. | `orderId, actor, {note, intent, reason}` → order | `transitionOrder` |
| `returnPickupToStock` (L1119) | Store pickup: a Ready return/exchange, or a delivered pickup exchange/refund → `back_from_pickup` | `orderId, actor, {note, intent}` → order | `transitionOrder` |
| `computeCustomerRefundAmount` (re-export, L1175) | Amount owed to the customer (from `utils/computeCustomerRefundAmount.js`) | `order, prior?` → number | util |
| `confirmReturnedToStock` (L1177) | Warehouse "Confirm — in stock" scan. Only for `CONFIRMABLE_RETURN_STATUSES`. Heals collect SKUs to match the original order's sizes. Picks the ledger set: **exchange** (collect +real, then outbound restock or hold release per `exchangeConfirmActions`), **refund pickup** (+real on the collect lines), **plain RTO** (restock decremented units, else release hold). Clears leftover holds. Next status: local intent cancel → `cancelled`; local intent exchange → `pending_verification`; COD refund/credit exchange not yet paid → `pending_refund` (sets `refundAmount`); otherwise `returned_to_stock`. Bumps customer counters. After commit: forced Shopify sync for every SKU, OOS release, and a Shopify cancel when the result is `cancelled`. | `orderId, actor, {note, returnReason, returnReasonNote}` → order | `healCollectToPriorOrder`, `assertCollectFromPriorOrder`, inventory builders, `exchangeConfirmActions` |
| `releaseOutOfStockOrdersIfRestocked` (L1493) | FIFO scan of `out_of_stock` orders (optionally only those containing given variants). An order is released when, for every line, real stock minus holds of *non-OOS, non-terminal* orders covers it; it is then re-held and moved to Ready (source `system`). | `variantIds[], {actorUserId, note}` → `{released[], checked}` | Variant, InventoryLedger aggregate, `ensureOrderStockHeld`, `transitionOrder` |
| `scanOutOfStockOrdersForRelease` (L1655) | Periodic job: the above with no variant filter | → same | jobs |
| `transitionOrderStatus` (L1661) | Generic transition used by fulfillment, Bosta tracking and the `PATCH status` endpoint. `delivered` → `executeDelivered`; `verified_ready_for_shipping` → tops up holds; **every other target only changes status (no ledger)**. Then sync/notify depending on the target. | `orderId, toStatus, meta` → order | `executeDelivered`, `ensureOrderStockHeld`, `transitionOrder`, notifications |
| `reserveStockForOrder` (L1712) | Full `on_hold_reserve` for every line (not idempotent) | `orderId, items, session` → ledger docs | `buildHoldReserveEntries` (used by Shopify ingest and manual orders) |
| `ensureOrderStockHeld` (L1718) | Tops up only the missing hold per line (idempotent) | `orderId, items, session` → ledger docs | `buildMissingHoldEntries` |
| `manualStockAdjustment` (L1724) | Signed `real_stock_increment_manual` in a transaction, then low-stock check, OOS release (if positive) and Shopify sync (non-strict) | `{variantId, quantityDelta, reasonCode, actor, skipOosAutoRelease, skipShopifySync}` → `{variant, ledger…}` | `buildStockIntakeEntries`, `afterLedgerApplied` |
| `stockIntake` (L1762) | Positive-only wrapper (default reason `restock`) | `{variantId, quantity, …}` → same | `manualStockAdjustment` |
| `stockIntakeBatch` (L1790) | Many intakes in **one** transaction; Shopify push right away; OOS release in `setImmediate` | `{items[], reasonCode, actor}` → `{results, shopifySync, shopifyWarning}` | `applyLedgerEntries`, `pushSellableNow` |
| `setRealStockBatch` (L1869) | Sets absolute `realStock` per variant (stock count or Excel import) by writing the delta as a manual ledger row; **one transaction per item**; pushes Shopify; async OOS release | `{items:[{variantId, realStock}], reasonCode, actor}` → `{results, shopifySync, oosReleased(always empty)}` | `buildManualAdjustmentEntry`, `pushSellableNow` |
| `findOrCreateManualCustomer` (L1961) | Finds a customer by exact phone, then by EG phone regex, else creates one; updates name/email | `customer, session` → Customer | Customer, `utils/phone` |
| `allocateManualOrderRef` (L1994) | Atomic `Settings.manualOrderNextSeq` (pipeline upsert) → `M-1000`, `M-1001`… | `session` → string | Settings |
| `createManualOrder` (L2069) | ~530-line manual order factory (normal / creator / exchange / return-refund). Validates the exchange/return link and reason note, checks collect lines against the prior order, resolves variants, annotates offers, computes the exchange price difference (upgrade → total, downgrade → `exchangeCreditAmount`), shipping fee (zone by city / local fixed / pickup 0 / creator custom / exchange via `resolveExchangeShippingFee`), normalises collect lines with prior-order prices and the refund amount. Creates the order already verified: `verified_ready_for_shipping` (or `returning_to_origin` for a Bosta refund), reserves stock (not for returns), writes history, bumps `lifetimeOrders`. After commit: Shopify sync, notifications, and an immediate Bosta CRP for Bosta refunds. | large payload → populated order | many (see text), `ensureBostaDeliveryForOrder` |
| `routeBostaReturnPickup` (L2603) | A Ready return pickup switched to Bosta → `returning_to_origin` plus a CRP | `orderId, actor` → `{order, moved, crpError}` | `transitionOrderStatus`, `ensureBostaDeliveryForOrder` |
| `findOrderForExchange` (L2641) | Looks up the prior order: numeric/# → live Shopify import by name, otherwise a local lookup (manual ref / Mongo id / name) | `query` → lean order | `importShopifyOrderByName`, `healMissingOrderVariants` |
| `suggestShippingFeeByCity` (L2795) | Shopify zone fee for a city | `city, goodsTotal` → number | `resolveShopifyZoneShippingFee` |
| `resolveExchangeShippingFee` (L2803) | Explicit fee → zone by city → prior fee → default | `{shippingFee, priorOrder, city, goodsTotal}` → number | same |
| `getOrderStateCounts` (L2831) | Status counts since the cut-over, plus `fulfillment_ready` (non-pickup ready + repaired_shoe), `pickup_ready`, `delayed`, `refund_orders` | → counts object | Order aggregates |
| `listOrders` (L2887) | Queue/list filters: status (csv), source, method, exchange/return/offer flags, `returnKind` (exchange/refund/refused), placed range, delayed, ready hides future ship-after; search matches order #/tracking/address/SKU/customer. Search drops the cut-over floor. | query → `{orders, total}` | Order, Customer |
| `getOrderById` (L3067) | Populated order; **on read** heals collect SKUs and persists `refundAmount` for pending refunds | `orderId` → order \| null | `healCollectToPriorOrder`, `computeCustomerRefundAmount` |
| `getOrderStatusHistory` (L3145) | History rows, newest first | `orderId` → rows | OrderStatusHistory |
| `claimOrder` (L3149) | Atomically assigns the OM or stock-manager slot if it is empty | `orderId, actor, role` → order \| null | Order |
| `delayOrder` (L3162) | Pending/no-response order → `delayedUntil` (Cairo date) + note (status unchanged) | `orderId, actor, {delayedUntil, note}` → order | `parseCairoDelayDate` |
| `processDelayCallbacksDue` (L3193) | Daily job: notify the OM for delays due today (max 200), mark `delayNotifiedOn` | → `{date, notified}` | `notifyOrderCallbackDue` |
| `applyOrderDiscount` (L3233) | 5–30 % (or 0 to clear) on merchandise only, before courier/AWB, not on exchange/creator/return. Writes a history note. OMS only (no Shopify edit). | `orderId, actor, {percent}` → order | Order, OrderStatusHistory |
| `bulkVerifyOrders` (L3310) | Up to 100 orders, calls `verifyOrder` one by one, collects failures | `ids, actor, {outcome, note, shippingMethod}` → `{ok, failed}` | `verifyOrder` |
| `confirmRefundPaid` (L3352) | `pending_refund` → `returned_to_stock`. `paid=true` stores method/reference/amount; `paid=false` also moves to `returned_to_stock` with a "NOT PAID" note | `orderId, actor, {paid, amount, paymentMethod, reference, note}` → order | `transitionOrder` |
| `exportPendingRefundsExcel` (L3429) | Excel of the pending refunds (name, phone, note, returned items, amount) | → `{buffer, filename, total}` | ExcelJS, `computeCustomerRefundAmount` |

### src/services/orderStateMachine.js
Allowed status transitions (`ORDER_TRANSITIONS`) and the guard helpers.

| Name | What it does | Inputs → Outputs | Calls / depends on |
|---|---|---|---|
| `ORDER_TRANSITIONS` (L7) | Map from status to the next statuses it may move to (full table in the lifecycle section) | const | — |
| `canTransition` (L99) | False if the target is unknown, the source is terminal, or the move isn't listed | `from, to` → bool | `ORDER_STATUSES`, `TERMINAL_ORDER_STATUSES` |
| `isTerminalStatus` (L106) | `returned_to_stock` / `cancelled` | status → bool | constants |
| `assertTransition` (L110) | Throws 400 `Invalid transition` | `from, to` → void | `canTransition` |

### src/services/orderStateMachine.test.js
Tests (node:test): `pending_refund` entry/exit paths and that it isn't terminal; delivered → back_from_local/back_from_pickup; Ready → returning_to_origin; local_shipping → Ready; `repaired_shoe` can go Bosta/local/delivered/cancel, never to stock lanes, and can be pulled back from courier lanes.

### src/services/returnStockPlan.js
Pure rules for what a warehouse return confirm does to stock.

| Name | What it does | Inputs → Outputs | Calls / depends on |
|---|---|---|---|
| `confirmReturnStockEffect` (L5) | Classifies the warehouse effect: `no_change` / `release_hold` / `plus_real` / `plus_real_and_release_hold`, with a reason (skip_collect, refund_pickup, exchange_collect, exchange_rto_collect, sold_rto, never_sold, collect, already_aligned) | `order, {collectRestock, outboundRestock, outboundHold, hasCollectLines}` → `{warehouse, reason}` | — (only used by tests; the order service uses `exchangeConfirmActions`) |
| `exchangeConfirmActions` (L40) | For exchanges: whether to +real the collect, restock the outbound, or release the outbound hold (depends on `deliveredAt` and `skipCollectRestock`) | `order, {outboundRestockLen, hasCollectLines}` → flags | — |
| `CONFIRMABLE_RETURN_STATUSES` (L63) | `returned_awaiting_receipt`, `returning_to_origin`, `back_from_local_shipping`, `back_from_pickup` | const | — |

### src/services/returnStockPlan.test.js
Tests: refused RTO releases hold; sold RTO +real; refund CRP +real; delivered exchange +real collect; undelivered exchange +real and releases hold (and the matching `exchangeConfirmActions`); the confirmable status list.

### src/services/inventory.service.js
The stock ledger engine: applies ledger entries to `Variant` fields and builds the entry sets for each business event.

| Name | What it does | Inputs → Outputs | Calls / depends on |
|---|---|---|---|
| `STOCK_FIELD_MAP` (L8) | Ledger type → Variant field (hold types → `onHoldStock`; decrement/increment types → `realStock`; `online_stock_increment_api` → `onlineStock`) | const | — |
| `netOrderLedgerQty` (L20) | Sum of `quantityDelta` for an order + variant + set of types | `orderId, variantId, types, session` → number | InventoryLedger aggregate |
| `applyLedgerEntry` (internal, L40) | Validates the type; if the variant was deleted, release/return entries write the ledger only (others 404). A negative hold delta is clamped at the variant's current hold (skipped if 0); `realStock` may go negative. Creates the ledger row and `$inc`s the field. | `entry, session` → `{ledger, previous, next, …}` | Variant, InventoryLedger |
| `applyLedgerEntries` (L151) | Applies entries in order; collects `realStock` crossings from ≥0 to <0 into `results._negativeCrossings` | `entries, session` → ledger docs[] | `applyLedgerEntry` |
| `notifyNegativeStockCrossings` (L179) | Post-commit factory-restock alerts | `crossings[]` → void | `notifyFactoryRestockNeeded` |
| `buildHoldReserveEntries` (L197) | `on_hold_reserve +qty` per line | `orderId, items` → entries | — |
| `buildDeliveryEntries` (L210) | Naive release + decrement (marked legacy; **unused**) | same | — |
| `buildDeliveryStockEntries` (L234) | Idempotent delivery: release only the remaining order hold; decrement only units not already sold (net decrement → return) | `orderId, items, session` → entries | `netOrderLedgerQty` |
| `buildMissingHoldEntries` (L281) | Tops up the hold to the line qty | same | `netOrderLedgerQty` |
| `buildPreDeliveryReleaseEntries` (L309) | Naive release (**unused**) | `orderId, items` → entries | — |
| `buildPostDeliveryReturnEntries` (L321) | `real_stock_increment_return +qty` (not idempotent) | same | — |
| `buildOutstandingReturnRestockEntries` (L334) | +real only for sold units not yet returned | `orderId, items, session` → entries | `netOrderLedgerQty` |
| `buildOutstandingHoldReleaseEntries` (L363) | Releases the remaining hold, up to the line qty | same | `netOrderLedgerQty` |
| `buildFullOrderHoldReleaseEntries` (L391) | Releases every variant with net hold > 0 on the order (covers edited/removed lines) | `orderId, session` → entries | InventoryLedger aggregate |
| `reconcileVariantOnHoldFromLedger` (L423) | Sets `Variant.onHoldStock` = sum of positive per-order net holds | `variantId, session` → `{previous, next, changed}` | InventoryLedger, Variant |
| `repairStockIntegrity` (L467) | Job: release orphan holds on cancelled/returned orders, then reconcile `onHoldStock` for every variant | `{actorUserId}` → summary | the above, Order |
| `buildManualAdjustmentEntry` (L544) | Signed `real_stock_increment_manual` | `{variantId, quantityDelta, reasonCode, actor}` → entry | — |
| `buildStockIntakeEntries` (L557) | `[buildManualAdjustmentEntry]` | same → entries | — |
| `listOnHoldItems` (L566) | Open holds by order + SKU (excludes cancelled/returned), with search | `{search, limit}` → `{items, total, totalUnits}` | InventoryLedger, Order, Variant |

### src/services/fulfillment.service.js
Warehouse fulfillment: Bosta AWB/delivery creation, pick & pack per shipping method, pick list, out-of-stock parking, order sheet.

| Name | What it does | Inputs → Outputs | Calls / depends on |
|---|---|---|---|
| `getLogoBase64` | Reads the logo PNG from disk on every call | → dataURL \| null | fs |
| `isForeignBostaDelivery` / `deliveryBelongsToOrder` | Rejects WooCommerce/foreign Bosta deliveries; matches by businessReference = order id (legacy: Shopify id), or by id/tracking | delivery, order → bool | — |
| `clearWrongBostaLink` | Clears the Bosta id/tracking and sets status `none` | `order, reason` → void | Order |
| `checkStockAvailability` (L89) | Warns when `realStock` < line qty | order → warnings[] | Variant (used by controller) |
| `assertBostaShipable` | Not pickup/local; street + city present | order → void | — |
| `ensureBostaDeliveryForOrder` (L128) | Refreshes Shopify money/fee first. If a linked delivery exists: fetch it, keep it (update address/COD/description on Bosta) or clear it when foreign/not found. Otherwise an atomic `creating` claim, then `createDelivery`, saves id/tracking, syncs Bosta fees; marks `failed` on error. **No status change.** | `orderId, actor` → `{deliveryId, trackingNumber, created}` | Bosta `getDelivery/createDelivery/updateDelivery*`, `syncShopifyMoneyOntoOrder`, `syncBostaFeesForOrder` |
| `isBostaReturnPickup` / `moveBostaReturnToReturning` | Return order on Bosta → `returning_to_origin` | — | `transitionOrderStatus` |
| `prepareAwbForOrder` (L350) | Ensures the delivery, moves Ready/repaired → `awaiting_bosta_pickup` (Bosta return → returning), returns the AWB URL | `orderId, actor` → `{url, deliveryId, …}` | `ensureBostaDeliveryForOrder`, `getAwb` |
| `createBostaShipmentForOrder` (L378) | Same status logic without the AWB (source `system`) | → `{deliveryId, trackingNumber}` | same |
| `pickAndPackOrder` (L403) | From Ready/repaired: repair+pickup → `delivered`; pickup → zero Shopify shipping, then refund → `back_from_pickup` or → `delivered`; local → `local_shipping`; Bosta return → `routeBostaReturnPickup`; AWB already exists → `awaiting_bosta_pickup`; otherwise create the shipment | `orderId, actor` → result flags | `transitionOrderStatus`, Bosta, `zeroShopifyShippingForPickup` |
| `getPickList` (L549) | Ready + repaired since the cut-over, ship-after due, excluding Bosta returns; backfills `returnedFromOutOfStockAt` from history (fire-and-forget) | → orders | Order, OrderStatusHistory |
| `markOrderOutOfStock` (L625) | Ready → OOS. Multi-item orders need per-line actions: `remove` (release that order's hold, delete the line), `oos`, `keep`. Recomputes totals/discount; transitions to OOS only if some line is `oos` | `orderId, actor, {note, lines}` → order | ledger, `syncShopifySellableAfterLedger`, `transitionOrderStatus` |
| `getShipmentStatus` (L800) | Bosta/local shipment fields | `orderId` → object | Order |
| `getAwbForOrder` (L821) | AWB for an existing Bosta delivery | `orderId` → `{url, …}` | `getAwb` |
| `buildOrderSheet` (L842) | Printable sheet data with a Code128 per line | `orderId` → `{order, customer, items, logoBase64}` | bwip-js, `barcodeValueForVariant` |

### src/services/exchange.service.js
Item edits before shipment (statuses pending / no_response / ready / OOS).

| Name | What it does | Inputs → Outputs | Calls / depends on |
|---|---|---|---|
| `recalcMerchandiseTotals` / `totalUnits` / `assertEditable` | Totals with discount re-applied; unit count; status guard | order → void | — |
| `processExchange` (L51) | Swaps a line to another variant: checks free stock (real − hold), releases the old variant's hold and reserves the new one (full line qty), reprices, re-flags offers | `orderId, actor, {fromItemId, toVariantId, note}` → order | `applyLedgerEntries`, `refreshOrderOfferFlag`, `syncShopifySellableAfterLedger` |
| `removeOrderItem` (L146) | Removes or reduces a line (never to 0 units in total); releases `min(qty, variant.onHoldStock)` | `orderId, actor, {itemId, note, quantity}` → order | same |
| `addOrderItem` (L237) | Adds/increments a line if there is free stock; reserves the hold | `orderId, actor, {variantId, quantity, note}` → order | same |

### src/services/repairOrder.service.js
Repair orders: an in-house repaired shoe sent back to the customer. No items, no stock.

| Name | What it does | Inputs → Outputs | Calls / depends on |
|---|---|---|---|
| `badRequest` | 400 error factory | msg → Error | — |
| `createRepairOrder` (L21) | Validates customer/shoe/amount/method/address; creates a manual order `M-…` with `isRepairOrder`, `items: []`, status `repaired_shoe`, `totalSellingPrice` = amount collected; writes history; bumps `lifetimeOrders`; notifies | payload → populated order | `allocateManualOrderRef`, `findOrCreateManualCustomer`, `notifyRepairOrderReady` |

### src/services/offerOrder.service.js
Offer (discounted / tagged) line flags.

| Name | What it does | Inputs → Outputs | Calls / depends on |
|---|---|---|---|
| `annotateOfferItems` (L9) | Sets `isOnOffer` / `offerType` / `unitCompareAtPrice` per line from the variant's compare-at price and product tags | `items, session` → bool (is offer order) | Variant, Product, `utils/offerOrder` |
| `refreshOrderOfferFlag` (L40) | Re-annotates the changed lines and re-derives `order.isOfferOrder` (skips exchange/return orders) | `order, changedLines, session` → order | same |

### src/services/customer.service.js
Customer CRM: lookup, find-or-create, segments, filters, Excel export.

| Name | What it does | Inputs → Outputs | Calls / depends on |
|---|---|---|---|
| `escapeRegex`, `parseOptionalNumber`, `hasOrderItemFilters`, `normalizeSizeToken`, `sizeEqualsRegex` | Query helpers (Arabic digits, leading zeros) | — | — |
| `findCustomerIdsByOrderFilters` (L59) | Customer ids from orders matching size/color/SKU/product/status/date/method (items and collect lines) | filters → ids[] | Order, Variant, Product |
| `findCustomerIdsByCity` / `buildCustomerFieldParts` / `resolveFilteredCustomerQuery` | City ids; field filters; intersects the id sets | — | — |
| `customerCity` | Default address city | customer → string | — |
| `findCustomerByPhone` (L258) | EG phone variants → customer (fallback: past order phone) + last address/order | `phone` → `{customer, shippingAddress, lastOrder}` \| null | Customer, Order |
| `findOrCreateCustomer` (L327) | Shopify ingest: by `shopifyCustomerId` → phone → phone+name, else create; patches fields; **always `$inc lifetimeOrders`** | payload → Customer | `findCustomerByPhone` |
| `getCustomerShopifyOrders` (L386) | Live Shopify order history (REST), enriched with OMS status/tracking; local fallback | `customerId` → `{source, orders}` | `shopifyRest` |
| `getCustomerById` (L452) | Customer + last 20 orders + delivery reliability % | id → object | — |
| `updateCustomerRiskFlag` (L473) | Sets `riskFlag` | id, flag → Customer | — |
| `recordCustomerCancellation` (L484) | `$inc lifetimeCancelled` **and** `lifetimeRejectedOrReturned`; sets `watch` when cancels > 2 | `customerId, session` → Customer | — |
| `FREQUENT_CANCEL_THRESHOLD` = 2, `VIP_ORDER_THRESHOLD` = 4 | Thresholds | const | — |
| `buildCustomerSegmentFilter` (L512) | vip / green / red Mongo filters | segment → filter \| null | — |
| `listCustomers` (L548) | Filtered, paginated; a gender filter loads **all** matches into memory (gender inferred from the name) | query → `{customers, total}` | `resolveGender` |
| `getCustomerFilterOptions` (L578) | sizes/colors/cities/products | → object | — |
| `exportCustomersExcel` (L607) | Excel with last-order info | query → `{buffer, filename, total}` | ExcelJS |

### src/services/notification.service.js
In-app notifications per role (best-effort, never throws).

| Name | What it does | Inputs → Outputs | Calls / depends on |
|---|---|---|---|
| `createNotification` (L9) | Creates a `Notification` and swallows errors | `{type, roles, title, …}` → doc \| null | Notification |
| `notifyNewOrder` / `notifyOrderVerified` / `notifyRepairOrderReady` / `notifyOrderCallbackDue` / `notifyFailedDelivery` / `notifyReturnToOrigin` / `notifyDiscrepancy` | Domain-event wrappers with fixed roles/severity/link | order/variant → doc | `createNotification` |
| `notifyFactoryRestockNeeded` (L131) | "Factory restock needed" (deduped 24 h per variant) | `variantId, {orderId, realStock}` → doc | Variant |
| `notifyLowStockIfNeeded` (L165) | If `realStock` < 0: factory alert **plus** a separate "Negative stock" alert (6 h dedupe) | `variantId` → doc | above |
| `checkVariantsLowStock` (L198) | Loops `notifyLowStockIfNeeded` | ids → void | — |
| `listForUser` / `unreadCount` / `markRead` / `markAllRead` | Notification center by role, `readBy` array | user → list/count | Notification |

### src/services/discrepancy.service.js
Stock discrepancy alerts.

| Name | What it does | Inputs → Outputs | Calls / depends on |
|---|---|---|---|
| `checkVariantInvariant` (L6) | Replays the whole ledger in memory and compares it to the hold/real fields (**unused**) | `variantId` → `{issues, ledgerCount}` | InventoryLedger |
| `createDiscrepancyAlert` (L47) | Creates an alert | payload → doc | DiscrepancyAlert |
| `listUnresolvedAlerts` (L51) | Paginated open alerts | → `{alerts, total}` | — |
| `resolveAlert` (L65) | Marks resolved | id, user → doc | — |
| `reportOnlineStockDrift` (L73) | Alerts and notifies when Shopify available → `Variant.onlineStock` (called from the Shopify inventory webhook) | `variantId, shopifyQty` → alert \| null | `notifyDiscrepancy` |

### src/services/adminJobs.service.js
Agenda job bodies for admin alerts.

| Name | What it does | Inputs → Outputs | Calls / depends on |
|---|---|---|---|
| `checkRestockNeeded` (L12) | Nightly: variants with `realStock` < 0 and no open PO → admin "Restock needed" (24 h dedupe) | → `{checked, notified}` | Variant, PurchaseOrder, Notification |
| `checkSlowMovers` (L54) | Daily: active variants with stock and 0 deliveries in 30 days (7 d dedupe) | → `{checked, notified}` | Order, Variant |

### src/services/auth.service.js
JWT login and user admin.

| Name | What it does | Inputs → Outputs | Calls / depends on |
|---|---|---|---|
| `login` (L6) | bcrypt check, `lastLoginAt`, signs JWT `{sub, role}` | email, pw → `{token, user}` | bcrypt, jwt |
| `createUser` (L34) | Hashes the password (cost 12) and creates the user | payload → User | — |
| `listUsers` / `deactivateUser` | List without the hash; `isActive=false` | — | User |

### src/services/barcode.service.js
Code128 stickers (58×40 mm).

| Name | What it does | Inputs → Outputs | Calls / depends on |
|---|---|---|---|
| `LABEL_WIDTH_MM` / `LABEL_HEIGHT_MM` | 58 / 40 | const | — |
| `barcodeValueForVariant` (L14) | Shopify barcode, else the exact SKU | variant → string | — |
| `renderCode128Png` (L25) | bwip-js PNG | text, opts → Buffer | bwip-js |
| `getVariantBarcodePng` (L46) | PNG + label info | variantId → object | Variant |
| `buildBarcodeLabelHtml` (L72) | Printable HTML, 1–200 copies | variantId, copies → html | `buildLabelSheetHtml` |
| `buildBarcodeLabelsBatchHtml` (L86) | Multi-SKU sheet (≤200 per SKU, ?800 total) | items → html | same |
| `buildLabelSheetHtml` / `escapeHtml` (internal) | HTML/CSS print layout; embeds each PNG once | rows → html | — |

### src/services/accounting.service.js
Chart of accounts, journals, decision P&L (based on delivered orders), balance sheet, top products, COGS health.

| Name | What it does | Inputs → Outputs | Calls / depends on |
|---|---|---|---|
| `pct`, `buildDecisionInsights` (internal) | Margin ratios + text insights | numbers → `{insights, ratios}` | — |
| `operationalPlFromOrders` (internal, L128) | Delivered orders in range: revenue, COGS (snapshot or line COGS), missing-COGS units, splits by source/shipping/payment, COD fee (EGP 25), Bosta fees (breakdown/API/zone), shipping economics | `{from, to}` → object | ReportOrder, `utils/shippingEconomics`, `utils/omsCod`, `shippingZones` |
| `listAccounts` / `createAccount` / `updateAccount` | GLAccount CRUD | — | GLAccount |
| `listJournalEntries` (L354) | Paginated journals + totals per source | range → `{entries, total, summary}` | JournalEntry |
| `createJournalEntry` (L406) | Manual entry; must balance (±0.01) | payload → doc | — |
| `getProfitAndLoss` (L425) | Journal categories + brand expenses + operational P&L → net income (adds customer shipping and COD fees), waterfall, insights | range → P&L object | `getBrandExpensesForRange`, `operationalPlFromOrders` |
| `getBalanceSheet` (L586) | **Runs a 15-order journal backfill on every read**, then account balances grouped by category | → grouped balances | `backfillMissingDeliveryJournals` |
| `backfillMissingDeliveryJournals` (L676) | Posts missing `auto_delivery` journals for recent delivered orders | `{limit}` → `{created, scanned}` | `recordDeliveryJournal` |
| `getTopProducts` (L704) | SKU revenue/margin/sell-through + idle stock + decisions | range → object | ReportOrder, Variant |
| `recordDeliveryJournal` (L884) | Best-effort and idempotent per order: Dr AR / Cr revenue (4001 Shopify, **4002 "Online Sales" for manual**), Dr COGS 5001 / Cr Inventory 1100. Never throws. Writes **without a session**. | `order, actor` → doc \| null | `getAccountByCode`, JournalEntry |
| `getCogsHealth` (L937) | Active variants ranked missing/loss/thin/ok/strong | `{limit}` → `{summary, insights, variants}` | Variant |

### src/services/chartOfAccounts.seed.js
Seeds the default chart of accounts.

| Name | What it does | Inputs → Outputs | Calls / depends on |
|---|---|---|---|
| `CHART_OF_ACCOUNTS` | 27 accounts (1100…6009) | const | — |
| `ensureChartOfAccounts` (L33) | Inserts all only if the collection is empty | → `{seeded, count}` | GLAccount |
| `getAccountByCode` (L42) | Active account by code | code → doc | — |

### src/services/brandExpense.service.js
Brand OpEx templates (fixed/variable), monthly actuals, range totals for the P&L.

| Name | What it does | Inputs → Outputs | Calls / depends on |
|---|---|---|---|
| `AUTO_COMPUTED_EXPENSE_KEYS` | `shipping-loss` | const | — |
| `formatEgp`, `isAutoComputedExpense`, `usdToEgpRate`, `slugKey` (internal) | Helpers | — | config |
| `computeMonthShippingLoss` (internal, L25) | Shipping economics for a month (Cairo bounds) | `YYYY-MM` → economics | `loadShippingEconomicsForRange`, ReportOrder |
| `toEgp` (L53) | USD → EGP at the configured rate | amount, currency → number | — |
| `listYearMonthsInRange` (L59) | `YYYY-MM` list | from, to → string[] | — |
| `listBrandExpenses` / `createBrandExpense` / `updateBrandExpense` / `deleteBrandExpense` | Template CRUD (soft delete) | — | BrandExpense |
| `getMonthExpenseBreakdown` (L189) | Lines for one month: fixed = template or override, variable = entry or 0, shipping loss = auto; revenue context (UTC month bounds) + insights | `YYYY-MM` → breakdown | MonthlyExpense, `computeMonthShippingLoss` |
| `saveMonthExpenses` (L326) | Upserts monthly actuals (ignores auto lines) | `YYYY-MM, items, user` → breakdown | MonthlyExpense |
| `getBrandExpensesForRange` (L380) | Sums months; fixed costs prorated by days; excludes auto shipping loss from OpEx | `{from, to}` → totals | `getMonthExpenseBreakdown` per month |

### src/services/brandExpenses.seed.js
Seeds the default brand expense templates.

| Name | What it does | Inputs → Outputs | Calls / depends on |
|---|---|---|---|
| `BRAND_EXPENSE_SEED` | Default templates (incl. `shipping-loss` auto) | const | — |
| `DEFAULT_USD_TO_EGP` = 50 | Deprecated FX constant | const | — |
| `ensureBrandExpenses` (L59) | Creates missing templates; one-time migrations (shipping-loss auto, website → variable EGP, USD → EGP) | → `{created, migrated, total}` | BrandExpense |

### src/services/excelReports.service.js
Excel wrappers around the report services.

| Name | What it does | Inputs → Outputs | Calls / depends on |
|---|---|---|---|
| `exportProfitabilityExcel` | Profitability rows + totals + courier fees | range → `{buffer, filename}` | `getProfitabilityReport` |
| `exportPlExcel` | P&L summary + top expense accounts | range → same | `getProfitAndLoss` |
| `exportTopProductsExcel` | Top products sheet | range → same | `getTopProducts` |
| `exportCogsHealthExcel` | COGS health + JSON summary row | → same | `getCogsHealth` |
| `exportAuditLogExcel` | Status history + ledger sheets | range → same | `getAuditLog` |
| `exportBrandExpensesExcel` | Month × expense lines | range → same | `getBrandExpensesForRange` |

### src/services/hr.service.js
Employees, attendance, leave, payroll.

| Name | What it does | Inputs → Outputs | Calls / depends on |
|---|---|---|---|
| `computeHours`, `nextEmployeeCode` (internal) | Hours between clock-in/out; `EMP-{count+1}` | — | Employee |
| `listEmployees` / `getEmployee` / `updateEmployee` | CRUD (update passes `data` straight through) | — | Employee |
| `createEmployee` (L35) | Links an existing user or creates one (bcrypt), then the employee profile (no transaction) | payload → Employee | User |
| `listAttendance` / `recordAttendance` | Attendance list; upsert per day (server-local midnight) | — | Attendance |
| `listLeaveRequests` / `createLeaveRequest` / `reviewLeaveRequest` | Leave CRUD | — | LeaveRequest |
| `getPayrollSummary` (L155) | Monthly gross: hourly × hours or salary/22 × days | `YYYY-MM` → rows | Attendance (one query per employee) |
| `getEmployeeProfileWithKpis` (L193) | Profile + KPIs + attendance + leaves | id, range → object | `getEmployeeKpis` |

### src/services/kpi.service.js
Per-employee KPIs from history and the ledger.

| Name | What it does | Inputs → Outputs | Calls / depends on |
|---|---|---|---|
| `dateFilter` (internal) | `createdAt` range | — | — |
| `getEmployeeKpis` (L17) | OM: verified/cancelled counts, assigned orders, cancel rate, average verify hours. Stock manager: transitions to `picked_up_by_bosta` by this actor, manual stock adjustments, resolved discrepancies. | `userId, {from, to}` → KPIs | OrderStatusHistory, InventoryLedger, DiscrepancyAlert, ReportOrder |

### src/services/integrationHealth.service.js
Integrations health page.

| Name | What it does | Inputs → Outputs | Calls / depends on |
|---|---|---|---|
| `ordersCutoff` (internal) | Cut-over date | → Date | constants |
| `getIntegrationHealth` (L14) | Shopify status/policy/last webhook, Bosta config/health/webhook failures, Paymob config, queue counts | → object | Settings, WebhookReceipt, Order, Shopify/Bosta helpers |

### src/services/manufacturing.service.js
Factories, purchase orders (POs) and the PO Excel export.

| Name | What it does | Inputs → Outputs | Calls / depends on |
|---|---|---|---|
| `logoBase64Raw`, `writeRow`, `money`, `sizeSortKey`, `productDisplayTitle`, `itemColor/Size/Sku`, `groupPoItemsByProduct`, `getLogoImage`, `optimizeImageBuffer` (sharp 72 px JPEG), `embedSheetImage`, `fetchImageAsBase64` (process cache 45 min), `prefetchProductImages` (3.5 s budget), `addDays` | Excel/image helpers | — | fs, sharp, fetch |
| `factoryLeadTimeStats` / `attachFactoryStats` | Average received-PO lead time per factory (needs a minimum number of samples) | → Map | PurchaseOrder aggregate |
| `nextPoNumber` / `computeTotalCost` | `PO-YYYYMMDD-####` from the latest of the day; → qty × cost | — | PurchaseOrder |
| `listFactories` / `createFactory` / `updateFactory` / `deleteFactory` | CRUD (delete blocked if there are open POs) | — | Factory |
| `listOrderableProducts` (L304) | Active products (filtered by factory, linked or unlinked) + variants | `{q, factoryId, includeUnlinked, limit}` → products | Product, Variant |
| `assignProductFactory` (L381) | Sets `Product.defaultFactoryId` | ids → product | — |
| `linkProductsToFactory` (internal) | Links still-unassigned products of the PO lines | variantIds, factoryId → count | — |
| `listPurchaseOrders` / `getPurchaseOrder` | List/detail (populated) | — | PurchaseOrder |
| `enrichItems` (internal) | Snapshots SKU/title/color/size per line | items → items | Variant |
| `createPurchaseOrder` (L466) | Resolves the factory from the products when not given (must be exactly one), expected date = lead time, status `draft` | payload → PO | above |
| `updatePurchaseOrder` (L537) | Edits status/items/date/notes unless closed; stamps `sentAt` | id, patch → PO | — |
| `receivePurchaseOrder` (L564) | `stockIntake` per line (reason `factory_receive`), then status `received` | id, actor → PO | `order.service.stockIntake` |
| `exportPurchaseOrderExcel` (L601) | Factory-style sheet grouped by product/color with images | id → `{buffer, filename}` | ExcelJS |

### src/services/product.service.js
Catalog/variant reads, SKU lookup, COGS, stock exports.

| Name | What it does | Inputs → Outputs | Calls / depends on |
|---|---|---|---|
| `listVariants` (L7) | Search (**unescaped regex**), active only, negative-stock filter | query → `{variants, total}` | Variant, Product |
| `getVariantById` | Populated variant | id → variant | — |
| `updateVariantCogs` (L62) | Sets `cogs` (`userId` unused) | id, cogs → variant | — |
| `addCogsBatch` (L72) | Creates a CogsBatch and overwrites `Variant.cogs` | payload → batch | CogsBatch |
| `getVariantLedger` (L84) | Ledger rows for a variant | id, page → `{entries, total}` | InventoryLedger |
| `displayOptions`, `escapeRegex`, `sortSizes` (internal) | Helpers | — | — |
| `findVariantBySku` (L107) | Exact SKU → barcode → prefix match | sku → variant | — |
| `findVariantFamilyBySku` (L153) | All sizes of the product (optionally same color) | sku → `{matched, product, variants}` | — |
| `listCatalog` (L200) | Product-grouped catalog with SKU-vs-name search heuristics and variant filters | query → `{catalog, totals, page}` | Product, Variant |
| `getCatalogFilterOptions` / `listProducts` / `getStockQueueCounts` | Filter lists; product list; negative-stock and open-discrepancy counts | — | — |
| `exportCatalogStockExcel` / `exportInventoryCountExcel` / `exportOutOfStockPiecesExcel` | Stock sheets (selected products, full count "?????", OOS shortfall per SKU) | → `{buffer, filename}` | ExcelJS |

### src/services/reports.service.js
Executive dashboard (core/money/details, 45 s in-memory cache), profitability, audit log, top sellers.

| Name | What it does | Inputs → Outputs | Calls / depends on |
|---|---|---|---|
| `parseDate`, `formatYmdInTz`, `zonedDayBound`, `startOfBusinessDay`, `endOfBusinessDay`, `nowDate`, `listYmdInclusive`, `rangeForPreset`, `ordersMetricsRange`, `dateToStringCairo` | Cairo-calendar range helpers; order metrics clamped to the cut-over | — | Intl |
| `paymobReceivedForRange` | Live Paymob sync + sum (45 s race), ledger fallback | range → `{amount, count, source}` | `paymob/transactions.service`, PaymobReceived |
| `codCollectedForRange` | Live Bosta COD sync (45 s race), fallback to OMS `bostaCollectedAmount` | range → same | `bosta/cod.service` |
| `codLeftToCollect` | Open Bosta COD (delivered-unpaid or still with the courier) in range | range → same | ReportOrder |
| `bostaReturnCountForRange` | Bosta returns cache (10 s sync race) | range → counts | `bosta/returns.service` |
| `deliveredCountForRange` | Delivered count | range → n | — |
| `gazelleReturnCountForRange`, `returnsForRange`, `employeeKpisForRange` | **Defined but never called** | — | — |
| `dailyBreakdownForRange`, `paymentSplitForRange`, `topProductsForRange`, `deliveryPerformanceForRange`, `moneyCollectedVsExpectedForRange`, `refundsDetailForRange`, `exchangeSkuStatsForRange`, `mixFromCounts`, `orderMixForRange`, `returnsAnalyticsForRange` | Dashboard providers: per-day placed/paid/COD/returns; COD/online split; top products; delivery success and transit times; collected vs expected cash; refund detail (gender/reason/days after delivery); exchange collect SKUs/sizes; payment/channel mix; returns analytics | range → objects | ReportOrder, OrderStatusHistory |
| `pct`, `round1`, `roundMoney`, `medianOf`, `hoursBetween`, `daysBetween` | Math helpers | — | — |
| `dashboardCacheKey`, `setBoundedCache` | 40-entry FIFO caches, TTL 45 s | — | — |
| `ordersPlacedCutoff`, `warehouseReturnsSnapshot`, `warehouseConfirmsByKind` | Open return lanes count; `returned_to_stock` transitions split refused/exchange/refund | — | — |
| `buildDashboardCore` / `buildDashboardMoney` / `buildDashboardSummary` / `buildDashboardDetails` | Compose the providers (`allSettled`, defaults on failure) | range → payload | above |
| `getDashboardCore` / `getDashboardMoney` / `getDashboardSummary` / `getDashboardDetails` / `getDashboardStats` (exported) | Cached entry points; `getDashboardStats` = summary + details | query → payload | above |
| `getProfitabilityReport` (L2018) | Delivered lines by SKU, margins/decisions, Bosta fees (fallback **50** per order) | `{from, to, groupBy}` → `{totals, products, insights}` | ReportOrder |
| `getAuditLog` (L2181) | Latest status history + ledger rows | range, page → object | — |
| `getTopSellersByUnits` (L2197) | Units delivered in a Cairo month, rolled up per product | `{month, limit}` → products | ReportOrder, Variant |

### src/services/stockImport.service.js
Imports the warehouse pivot Excel into `realStock`.

| Name | What it does | Inputs → Outputs | Calls / depends on |
|---|---|---|---|
| `norm`, `normColor`, `TITLE_ALIASES`, `resolveTitleBase`, `cellNumber` (internal) | Normalisation; hard-coded color and title alias tables | — | — |
| `parseStockLabel` (L72) | `"Title - 38, Brown"` / reversed → `{titleBase, size, color}` | label → object | — |
| `parseRealStockExcelBuffer` (L114) | Finds the pivot sheet; rows from row 5 (col A label, col D qty) | buffer → `{sheetName, rows}` | ExcelJS |
| `buildVariantIndex`, `matchByProductSizeColor`, `matchVariant` (internal) | Multi-key variant index; exact → swapped → alias → fuzzy unique product | — | Variant |
| `importRealStockFromExcelBuffer` (L256) | Matches rows; `apply` → `setRealStockBatch(reason excel_import)`; report of unmatched/ambiguous | buffer, `{actor, apply}` → report | `order.service.setRealStockBatch` |
| `importRealStockFromFile` (L332) | Reads the file and calls the above (script) | path, opts → report | fs |

### src/services/warehouseReview.service.js
Warehouse backlog and stock-entered reports.

| Name | What it does | Inputs → Outputs | Calls / depends on |
|---|---|---|---|
| `dayKey`, `queueDate`, `daysWaiting`, `statusLabel`, `flattenOrder`, `escapeRegex` (internal) | Row helpers | — | — |
| `getWarehouseBacklog` (L64) | Pending + Ready orders (no cut-over filter), grouped by queue day with waiting days | `{from, to}` → `{totals, dailySummary, orders}` | Order |
| `exportWarehouseBacklogExcel` | 2-sheet Excel | query → `{buffer, filename, data}` | ExcelJS |
| `listStockIntakes` (L195) | Positive manual and return ledger rows (UTC day bounds), search by product/SKU | query → `{entries, total, unitsEntered}` | InventoryLedger |
| `exportStockIntakesExcel` / `exportCurrentStockExcel` | Excel exports (the latter delegates to `product.exportInventoryCountExcel`) | — | — |

---

## Order lifecycle (from the code)

### Statuses
`pending_verification`, `no_response`, `verified_ready_for_shipping` (UI: "Ready to ship"), `repaired_shoe`, `out_of_stock`, `awaiting_bosta_pickup`, `picked_up_by_bosta`, `in_transit`, `local_shipping`, `failed_delivery`, `delivered`, `returning_to_origin`, `returned_awaiting_receipt` (UI: "Back at Bosta"), `back_from_local_shipping`, `back_from_pickup`, `pending_refund`, and the terminal `returned_to_stock` and `cancelled`.

### Allowed transitions (`orderStateMachine.js`)
| From | To |
|---|---|
| pending_verification | verified_ready_for_shipping, no_response, cancelled |
| no_response | pending_verification, verified_ready_for_shipping, cancelled |
| verified_ready_for_shipping | awaiting_bosta_pickup, local_shipping, picked_up_by_bosta, delivered, back_from_pickup, returning_to_origin (return pickups only), out_of_stock, cancelled |
| repaired_shoe | awaiting_bosta_pickup, picked_up_by_bosta, local_shipping, delivered, cancelled |
| out_of_stock | verified_ready_for_shipping, cancelled |
| awaiting_bosta_pickup | picked_up_by_bosta, in_transit, delivered, failed_delivery, returning_to_origin, verified_ready_for_shipping, repaired_shoe, out_of_stock, pending_verification, cancelled |
| local_shipping | delivered, cancelled, pending_verification, verified_ready_for_shipping, repaired_shoe, in_transit, failed_delivery, returning_to_origin, back_from_local_shipping, returned_to_stock |
| picked_up_by_bosta | in_transit, delivered, failed_delivery, returning_to_origin |
| in_transit | delivered, failed_delivery, returning_to_origin |
| failed_delivery | in_transit, returning_to_origin, delivered, back_from_local_shipping, returned_to_stock |
| back_from_local_shipping / back_from_pickup | returned_to_stock, pending_verification, cancelled, pending_refund |
| returning_to_origin | returned_awaiting_receipt, returned_to_stock, pending_refund |
| returned_awaiting_receipt | returned_to_stock, pending_refund |
| pending_refund | returned_to_stock, cancelled |
| delivered | returning_to_origin, returned_awaiting_receipt, back_from_local_shipping, back_from_pickup, failed_delivery, in_transit |
| returned_to_stock, cancelled | (none) |

Extra rules in `transitionOrder`: repair orders may never enter pending/no_response/ready/OOS; only repair orders may enter `repaired_shoe`; Ready → `returning_to_origin` only when `isReturnOrder`. `executeDelivered` rejects `source = shopify_webhook` (a Shopify fulfillment is not a delivery).

### Which code moves orders
- **Ingest (Shopify)**: `webhooks/shopify.handlers.js` creates the order in `pending_verification` and calls `reserveStockForOrder` (stock is held at ingest).
- **Verify**: `verifyOrder` / `bulkVerifyOrders` → `no_response`, `verified_ready_for_shipping` (holds topped up; Shopify fulfilled), or `cancelOrder`. `delayOrder` only sets a callback date.
- **Manual orders**: `createManualOrder` creates them already verified. Normal/creator/exchange/local/pickup → `verified_ready_for_shipping` with holds. A Bosta refund → `returning_to_origin` with no hold and an immediate CRP. Local/pickup refunds → Ready, then back_from_local / back_from_pickup.
- **Repair orders**: `createRepairOrder` → `repaired_shoe` (no items). Then ships like a Ready order through pick & pack (Bosta/local/pickup → delivered) without stock moves.
- **Ship via Bosta**: `prepareAwbForOrder` (print AWB), `createBostaShipmentForOrder` (job) or `pickAndPackOrder` → `awaiting_bosta_pickup`. After that, Bosta webhooks/polling (`integrations/bosta/tracking.service.js` → `transitionOrderStatus`, bridging intermediate steps) move it to `picked_up_by_bosta` → `in_transit` → `delivered` / `failed_delivery` / `returning_to_origin` / `returned_awaiting_receipt`. A false "delivered" is corrected with `unwindFalseDeliveredSale`.
- **Ship via local courier**: `pickAndPackOrder` → `local_shipping`. Then `markDelivered` / `transitionOrderStatus('delivered')`, `partialLocalDelivery` (? delivered with the delivered lines only), or `returnLocalShippingToStock` → `back_from_local_shipping` (intent cancel/exchange/failed). A staff `cancelOrder` on a local order in courier hands is redirected there too.
- **Store pickup**: `pickAndPackOrder` → `delivered` (refund pickups → `back_from_pickup`). A pickup exchange after handoff uses `returnPickupToStock` → `back_from_pickup`.
- **Out of stock**: `markOrderOutOfStock` (Ready → `out_of_stock`, hold kept, optional removal of wrong lines). `releaseOutOfStockOrdersIfRestocked` (after intake, return, cancel, partial delivery) and the job `scanOutOfStockOrdersForRelease` move it back to Ready (FIFO). Staff can also move it back manually (`transitionOrderStatus`, stock managers limited to → Ready/repaired from awaiting_bosta/OOS/local).
- **Returns / RTO**: `confirmReturnedToStock` (warehouse scan) from `returning_to_origin`, `returned_awaiting_receipt`, `back_from_local_shipping`, `back_from_pickup` → `returned_to_stock`, `pending_refund` (COD refund or credit exchange not yet paid), `cancelled` (local intent cancel; also cancels on Shopify) or `pending_verification` (local intent exchange).
- **Refund payout**: `confirmRefundPaid` → `returned_to_stock` (both "paid" and "not paid").
- **Exchanges**: before shipment, `exchange.service` edits lines in place (swap/add/remove with hold moves). After delivery, a new manual exchange order (`createManualOrder isExchangeOrder`) delivers the new pair and collects the old one (`bostaReturnItems`); the collect is restocked at `confirmReturnedToStock`.
- **Cancel**: `cancelOrder` (staff from pending/no_response/ready/repaired/OOS/local; Shopify-driven also from Bosta lanes and failed_delivery). Releases all holds and cancels on Shopify.
- **Generic**: `transitionOrderStatus` (used by the `PATCH /orders/:id/status` controller, fulfillment and Bosta tracking) for any allowed move. Only `delivered` and `verified_ready_for_shipping` touch the ledger.

---

## Stock model (from the code)

### Fields (`Variant`)
- `realStock`: physical units in the warehouse. **May go negative** ("open stock" or oversold); a crossing below 0 triggers a factory-restock alert.
- `onHoldStock`: units reserved by open orders. Never negative (a negative release is clamped at the current value).
- Sellable = `realStock − onHoldStock`. This is the number pushed to Shopify `available`.
- `onlineStock` / `shopifyAvailable` / `lastSyncedAt`: mirror of the last Shopify value (written by pushes and inbound webhooks).

### Ledger types (`InventoryLedger`, applied only via `applyLedgerEntries` inside a transaction)
| Type | Field | Sign | When |
|---|---|---|---|
| `on_hold_reserve` | onHoldStock | + | Shopify ingest (`reserveStockForOrder`), manual order create, verify (manual: full reserve; Shopify: top-up), OOS release / move to Ready (top-up), add/swap item |
| `on_hold_release` | onHoldStock | − | Delivery (remaining hold), cancel (all holds on the order), partial delivery (undelivered units), return confirm of a never-sold order, remove/swap item, OOS "remove line", integrity repair |
| `real_stock_decrement` | realStock | − | Delivery only (`buildDeliveryStockEntries`: units not already sold) |
| `real_stock_increment_return` | realStock | + | Warehouse return confirm (sold RTO, exchange collect, refund pickup), `unwindFalseDeliveredSale` |
| `real_stock_increment_manual` | realStock | ± | Stock intake (single/batch, PO receive), absolute stock set (count / Excel import / Shopify sync scripts), inbound Shopify admin edits (`shopify_restock`/`shopify_count`) |
| `online_stock_increment_api` | onlineStock | ± | Declared in the field map and checked by `checkVariantInvariant`, but no code writes it |

Idempotency comes from per-order net sums (`netOrderLedgerQty`): delivery, hold top-up, outstanding hold release and outstanding restock only move what is missing. The exceptions are `buildHoldReserveEntries`, `buildPostDeliveryReturnEntries` and the direct entries in `exchange.service`, which are not idempotent.

So a unit's typical life is: reserve at ingest → (verify top-up) → release + decrement at delivery → +real at return confirm. A refused or never-delivered order only has its hold released at the warehouse confirm (the hold stays during the RTO), so real stock never moves.

### Shopify sync
- **Outbound** (OMS → Shopify): after every committed ledger change, `afterLedgerApplied` / `enqueueShopifySync` / `pushSellableNow` calls `syncVariantAvailableToShopify`, which uses `inventorySetQuantities` to set the absolute sellable value at the Shopify location. It retries up to 3 times, then queues the Agenda job `SHOPIFY_OUTBOUND_INVENTORY`. Stock intake and stock set push straight away; status-only transitions to OOS re-push too. `enqueueShopifySync` turns the write policy to `full` before pushing.
- **Inbound** (Shopify → OMS): the Shopify inventory webhook calls `queueShopifyInventoryIngest`. Increases are applied right away; decreases are debounced 12 s (`SHOPIFY_INBOUND_INVENTORY` job) so `orders/create` can reserve first. `applyShopifyAvailableToWarehouse` then ignores echoes of our own push (90 s) and drops explained by recent Shopify orders; otherwise it writes a manual realStock adjustment so that real − hold matches Shopify. The webhook also calls `reportOnlineStockDrift`.
- **Integrity**: `repairStockIntegrity` (job) releases holds left on cancelled/returned orders and rebuilds `onHoldStock` from the ledger. `listOnHoldItems` shows the open holds.

---

## Issues spotted (services)

**Stock and order correctness**
- `order.service.js:1661-1709` + `controllers/orders.controller.js:472-505`: the generic `transitionOrderStatus` only touches the ledger for `delivered` and `verified_ready_for_shipping`. Admins/OMs can send `local_shipping`, `back_from_*` or `pending_refund` straight to `cancelled`, and `local_shipping`/`failed_delivery`/`back_from_*` straight to `returned_to_stock`. That skips `cancelOrder`/`confirmReturnedToStock`: holds are not released (only cleaned later by the integrity job), returns are not restocked, there is no Shopify cancel and no refund handling.
- `order.service.js:540-545`: `verifyOrder` reserves the **full** quantity for manual orders (`reserveStockForOrder`, not idempotent). A manual order pulled back from `awaiting_bosta_pickup`/`local_shipping` to `pending_verification` keeps its hold, so verifying it again holds the stock twice. `ensureOrderStockHeld` would be the correct call.
- `exchange.service.js:98-116, 192-209`: `processExchange` releases the full line qty and `removeOrderItem` releases `min(qty, variant.onHoldStock)`. Both use the variant-wide hold rather than this order's net hold (unlike `markOrderOutOfStock`, which uses `netOrderLedgerQty`), so they can release holds that belong to other orders.
- `order.service.js:1493-1652`: in `releaseOutOfStockOrdersIfRestocked` the "fully stocked" check runs outside the transaction; inside it only the status is re-checked. Concurrent runs can release more OOS orders than there is stock. It is also an N+1: `competingPipelineHold` (L1539-1568) runs `Order.findById` per ledger group for every line of every candidate.
- Two OOS release passes are started for the same event, which makes the race above likely: `confirmReturnedToStock` (L1440-1458: `afterLedgerApplied` schedules one via `setImmediate`, then an explicit awaited call) and `manualStockAdjustment` (L1744-1757: explicit call, then `afterLedgerApplied` without `skipOosAutoRelease`). The comment at L1447 says "skipOos on afterLedger", but that option is not passed.
- `order.service.js:754-778`: `executeDelivered` catches ledger errors *inside* the transaction for `bosta_webhook`/`shopify_import` and continues. Entries already applied stay and the transaction commits partially; a caught transient/WriteConflict error leaves the session unusable.
- `utils/transaction.js` (used by every service): no retry on `TransientTransactionError`. Concurrent reservations on the same Variant (`$inc` in parallel webhooks) fail with a write conflict instead of retrying.
- `order.service.js:175-176`: `enqueueShopifySync` with `forcePolicyFull` (the default in `afterLedgerApplied`) calls `enableShopifyInventorySync()` on every stock move, so the admin's `shopifyWritePolicy` (e.g. `oms_only`, shown in `integrationHealth.service.js:47`) is silently overridden.
- `fulfillment.service.js:154-189`: if every `getDelivery` lookup throws (e.g. a Bosta outage or 404 on v2), `live` is null, the link is cleared and a **new** Bosta delivery is created. That risks duplicate shipments/AWBs for one order.
- `manufacturing.service.js:564-598`: `receivePurchaseOrder` calls `stockIntake` per line, each in its own transaction, and sets `received` only at the end. A mid-way failure plus a retry double-counts stock, and two concurrent receives both pass the status check. It also passes `syncToShopify: false` (L591), which `stockIntake` does not accept, so Shopify is pushed anyway.
- `order.service.js:1869-1956`: `setRealStockBatch` uses one transaction per item, so a 404 mid-batch leaves the earlier rows applied. `oosReleased` is always returned empty (L1944, L1956). In `stockImport`, two Excel rows matching the same variant → the last one wins silently.

**Accounting and reporting consistency**
- `order.service.js:783, 1030` → `accounting.service.js:884-935`: `recordDeliveryJournal` is called inside the delivery transaction but writes without the session. An aborted delivery still leaves an `auto_delivery` journal. `unwindFalseDeliveredSale` (L793-844) and returns never reverse that journal.
- `accounting.service.js:897`: manual orders are booked to 4002 "Online Sales" and Shopify (online) orders to 4001 "Shoe Sales". The account naming looks inverted.
- `accounting.service.js:588-593`: `getBalanceSheet` writes journals (backfill) on every GET.
- Courier-fee fallbacks differ: `reports.service.js:2112-2116` uses a hard-coded 50 per order, while `accounting.service.js:241-245` uses `resolveBostaCourierFee`. The COD fee 25 is hard-coded at `accounting.service.js:165`.
- Timezones are mixed: Cairo bounds in reports/order, but server-local `setHours` at `accounting.service.js:136, 361, 432, 711`, `reports.service.js:2025`, `brandExpense.service.js:389, 397-399`, `customer.service.js:80` and `hr.service.js:107`; UTC bounds at `brandExpense.service.js:260-261` and `warehouseReview.service.js:202-203`. On Render (UTC) the date ranges are off by 2–3 hours.
- `kpi.service.js:84-87`: the stock-manager "pick-packed" KPI counts transitions to `picked_up_by_bosta` by that user. Those come from Bosta webhooks (no actor); pick & pack produces `awaiting_bosta_pickup`/`local_shipping`/`delivered`, so this KPI is effectively always 0.
- `customer.service.js:484-489`: a cancellation increments both `lifetimeCancelled` and `lifetimeRejectedOrReturned`, which inflates the "red" segment ratio (L528-533).
- `reports.service.js:1383-1399` / `1784`: "warehouse confirms" and the refund rate count `returned_to_stock` transitions. COD refunds reach that status only at payout (`confirmRefundPaid`, including "not paid"), and local cancel/exchange confirms never do. `warehouseReturnsSnapshot` (L1361-1373) omits `back_from_pickup` and `pending_refund`.
- `order.service.js:3352-3417`: `confirmRefundPaid(paid=false)` still closes the order as `returned_to_stock`; there is no way to keep it open.

**Dead or duplicated code**
- Unused exports or code: `reports.service.js` `employeeKpisForRange` (L637, so the `kpiService` import is only used there), `gazelleReturnCountForRange` (L357), `returnsForRange` (L371); `inventory.service.js` `buildDeliveryEntries` (L210) and `buildPreDeliveryReleaseEntries` (L309) are imported in `order.service.js:17,20` but never called, nor is `netOrderLedgerQty` (L27); `order.service.js:425` `ingestShopifyAvailableIncrease`; `discrepancy.service.js:6` `checkVariantInvariant` (which also loads the whole ledger into memory); the `online_stock_increment_api` ledger type is never written; `stockImport.service.js:3` imports `Product` without using it; `returnStockPlan.confirmReturnStockEffect` is only used by tests.
- Duplicated logic: find-or-create customer (`customer.service.js:327` vs `order.service.js:1961`); prior-order collect price lookup written twice inside `createManualOrder` (L2214-2246 and L2345-2374); `prepareAwbForOrder` vs `createBostaShipmentForOrder` (`fulfillment.service.js:350-401`); `recalcMerchandiseTotals` (`exchange.service.js:16`) re-implemented in `fulfillment.service.js:743-759`; `escapeRegex` in 5 files; the cut-over date helper in 4 places (`order.service.js:2825`, `reports.service.js:1357`, `integrationHealth.service.js:10`, and inline in fulfillment/product/order export); Cairo day bounds re-implemented inline in `reports.service.js:2220-2231`.
- Triple negative-stock alerts for the same SKU: `notifyLowStockIfNeeded` sends a factory alert **and** a "Negative stock" alert (`notification.service.js:173-190`), and `adminJobs.checkRestockNeeded` sends a third "Restock needed".

**Reads that write, swallowed errors, and code smells**
- Reads with side effects: `getOrderById` (`order.service.js:3093-3139`) and `findOrderForExchange` → `healMissingOrderVariants` (L2777-2787) write to orders during GETs; `getPickList` uses a fire-and-forget `updateOne(...).catch(() => {})` (`fulfillment.service.js:603-606`).
- Swallowed errors: `createNotification` and `recordDeliveryJournal` return null on any error; `notifyOrderVerified` inside `catch {}` (`order.service.js:2555-2558, 2567-2569`); `reportOnlineStockDrift(...).catch(() => null)` in the webhook. The `Promise.race` timeouts in `reports.service.js:188-191, 229-232, 329-332` do not cancel the underlying Paymob/Bosta syncs, which keep running in the background.
- Very long functions that should be split: `createManualOrder` (~530 lines, `order.service.js:2069-2597`), `confirmReturnedToStock` (~305, L1177-1483), `buildDashboardCore` (~345, `reports.service.js:1402-1745`), `exportPurchaseOrderExcel` (~215, `manufacturing.service.js:601-817`), `ensureBostaDeliveryForOrder` (~200, `fulfillment.service.js:128-329`), `operationalPlFromOrders` (~210, `accounting.service.js:128-337`). `order.service.js` as a whole (3.6k lines) mixes workflow, Shopify sync, list queries and Excel export.
- Code smells: an `import` statement in the middle of `order.service.js:1169`; `logger` re-imported dynamically while already imported (`order.service.js:731`); redundant dynamic re-imports of already-imported modules (`order.service.js:3430-3434`); a misplaced doc comment (`order.service.js:1959` describes `allocateManualOrderRef` above `findOrCreateManualCustomer`); a no-op ternary `isPlaceholderPhone(phone) → phone : phone` (`customer.service.js:344`); `updateVariantCogs` ignores `userId` with no audit trail (`product.service.js:62`).
- Missing input validation or safety: `product.service.js:12` builds a `$regex` from raw `search` (invalid-regex 500s / ReDoS), while every other search escapes it. `hr.service.js:88` and `manufacturing.service.js:282-288` pass request bodies straight to `create`/`findByIdAndUpdate` (mass assignment). `hr.service.js:13` (`EMP-{count+1}`) and `manufacturing.service.js:259-267` (`nextPoNumber`) generate sequence numbers with races and duplicates.
- Data in code: `stockImport.service.js:32-55` hard-codes title aliases that map across colors (e.g. `women beige fabric floral ballerina` → `women black fabric floral ballerina`, L54; `women beige bush` → `women havana bush`, L47), so an import can write stock to the wrong colorway.
- Memory: `listCustomers` with a gender filter (`customer.service.js:568`) and `exportCustomersExcel` load every matching customer; `manufacturing.service.js:112` `productImageCache` is an unbounded process Map; `getWarehouseBacklog` (`warehouseReview.service.js:65`) loads all pending/ready orders with no cut-over filter.
- `partialLocalDelivery` (`order.service.js:1010`) overwrites `order.items` with the delivered subset, so the original undelivered lines survive only in a free-text note.
