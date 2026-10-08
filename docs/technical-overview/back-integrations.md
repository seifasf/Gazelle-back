# Gazelle backend — integrations, webhooks, jobs, utils, scripts

Scope: `Gazelle-back/src/integrations/**`, `src/webhooks/*`, `src/jobs/*`, `src/workers/*`, `src/utils/*`, `scripts/*`, `.github/workflows/*`, `render.yaml`, `docker-compose.yml`. Read-only review; line numbers refer to the working tree on 2026-10-08.

---

## Integrations, webhooks, jobs, utils: function-by-function

### src/integrations/shopify/client.js
Low-level Shopify Admin transport (GraphQL + REST) with manual redirect handling and THROTTLED back-off.

| Name | What it does | Inputs → Outputs | Calls / depends on |
|---|---|---|---|
| `shopifyFetch` (internal) | `fetch` with `redirect:'manual'`, follows up to 4 redirects without turning POST into GET. | url, init → Response | global `fetch` |
| `getShopifyClient` | Resolves admin GraphQL URL + token. Throws if not configured. | — → `{url, token, apiVersion, shopDomain}` | `getShopifyCredentials`, `getValidAccessToken` |
| `shopifyGraphQL` | POSTs a GraphQL query; retries THROTTLED up to 6× (2s·n, max 8s); throws on HTTP or `errors[]`. | query, variables, `{maxRetries}` → `data` | `shopifyFetch`, logger |
| `shopifyRest` | REST call on relative path or absolute URL; throws on non-2xx. No throttle/429 retry. | path, `{method, body, returnHeaders}` → JSON (+headers) | credentials |
| `parseNextLink` (internal) | Extracts `rel="next"` URL from `Link` header. | header → url/null | — |
| `shopifyRestPaginated` | Walks cursor pagination, optional per-page callback, `maxItems` cap. | firstPath, key, `{maxItems,onPage}` → items[] | `shopifyRest` |
| `resetShopifyClient` | No-op kept for compatibility. | — | — |

### src/integrations/shopify/credentials.js
Resolves Shopify credentials from env first, then the `Settings` document; client-credentials token exchange.

| Name | What it does | Inputs → Outputs | Calls / depends on |
|---|---|---|---|
| `normalizeShopDomain` | Strips protocol/path/port, lowercases. | string → domain/null | — |
| `pickAdminShopDomain` | Prefers a `*.myshopify.com` candidate. | ...domains → domain | `normalizeShopDomain` |
| `normalizeShopifyApiVersion` | Forces any version outside 2026-04…2026-07 back to `2026-07`. | version → version | constant `CURRENT_SHOPIFY_API_VERSION` |
| `getShopifyCredentials` | Merges env + Settings (domain, token, client id/secret, webhook secret, location, version). | — → creds object | `Settings`, `config` |
| `usesClientCredentials` (internal) | True when domain + client id + secret exist. | creds → bool | — |
| `fetchClientCredentialsToken` (internal) | `POST /admin/oauth/access_token` (grant `client_credentials`); stores token + expiry in Settings. | creds → token | `fetch`, `Settings` |
| `getValidAccessToken` | Reuses cached client-credentials token until 60s before expiry, else refreshes; else env/static token. | — → token | above |
| `isShopifyConfigured` | Domain + (token or client creds). | — → bool | `getShopifyCredentials` |
| `maskSecret` | Masks a secret for display. | string → masked | — |

### src/integrations/shopify/applyPaymentIncentives.service.js
Disabled stub (no callers).

| Name | What it does | Inputs → Outputs | Calls / depends on |
|---|---|---|---|
| `applyShopifyPaymentIncentives` | Returns payload unchanged. | payload → payload | — |
| `orderHasCodFee` (re-export) | From utils. | — | `utils/shopifyPaymentIncentives` |

### src/integrations/shopify/fulfillShopifyOrder.service.js
Marks a Shopify order fulfilled after OMS verification (queue cleanup only, never drives delivery status).

| Name | What it does | Inputs → Outputs | Calls / depends on |
|---|---|---|---|
| `shopifyOrderGid` (internal) | Builds `gid://shopify/Order/…`; null for manual refs. | order → gid/null | `isManualOrderRef` |
| `markShopifyOrderFulfilled` | Reads fulfillmentOrders; fulfills remaining qty on OPEN/IN_PROGRESS/SCHEDULED via `fulfillmentCreateV2` (notifyCustomer false). Treats "already fulfilled" as skip. | order → `{fulfilled|skipped,…}` | `shopifyGraphQL` |

### src/integrations/shopify/mutations/inventoryAdjust.js
Relative inventory adjustment (unused).

| Name | What it does | Inputs → Outputs | Calls / depends on |
|---|---|---|---|
| `inventoryAdjustQuantities` | `inventoryAdjustQuantities` on `available`. `idempotencyKey` param accepted but not sent. | `{inventoryItemId, locationId, delta, idempotencyKey, reason}` → GraphQL data | `shopifyGraphQL` |

### src/integrations/shopify/mutations/inventorySet.js
Absolute inventory set (OMS is source of truth).

| Name | What it does | Inputs → Outputs | Calls / depends on |
|---|---|---|---|
| `inventorySetQuantities` | `inventorySetQuantities @idempotent(key)` with `changeFromQuantity:null` (no CAS); clamps qty ≥0. Default key = random UUID. | `{locationId, quantities[], reason, referenceDocumentUri, idempotencyKey}` → GraphQL data | `shopifyGraphQL`, `crypto.randomUUID` |

### src/integrations/shopify/mutations/orderCancel.js
Cancels a Shopify order from OMS.

| Name | What it does | Inputs → Outputs | Calls / depends on |
|---|---|---|---|
| `toShopifyOrderGid` | id → Order GID; null for manual refs. | id → gid/null | `isManualOrderRef` |
| `cancelShopifyOrder` | `orderCancel` with `restock:false`, refund to original method, reason mapped (CUSTOMER/INVENTORY/FRAUD/OTHER). "Already cancelled" errors treated as success. | `{shopifyOrderId, reason, staffNote, notifyCustomer, refund}` → `{skipped, job, alreadyCancelled}` | `shopifyGraphQL` |

### src/integrations/shopify/orderMoney.js
Shopify order → OMS shipping/payment field mapping.

| Name | What it does | Inputs → Outputs | Calls / depends on |
|---|---|---|---|
| `isShopifyOrderPickup` | Pickup detection: `pickup_in_store`, hard-coded carrier id, shipping-line source/title/code regex (EN+AR), tags, note(+attrs), fulfillmentOrders `PICK_UP`/`PICKUP_POINT`. | payload, fulfillmentOrders? → bool | `PICKUP_REGEX` |
| `mapShopifyShippingFee` | 0 for pickup; else first finite of total shipping fields; else sum of shipping lines. | payload → EGP | `isShopifyOrderPickup` |
| `mapShopifyPaymentMethod` | `paid/partially_paid` → `online`; everything else → `cod`. | payload → `'online'|'cod'` | — |
| `isShopifyOrderPaid` | financial_status paid/partially_paid. | payload → bool | — |
| `applyShopifyMoneyFields` | Mutates order: pickup/fee, payment method, online-paid stamps (provider, paidAt, amount). Does not save. | order, payload → order | above |

### src/integrations/shopify/orderMoney.test.js
Covers pickup detection (carrier id, EN/AR titles, flag, tags, fulfillmentOrders, normal shipping=false), fee=0 for pickup vs 95 normal, and `applyShopifyMoneyFields` pickup/Bosta behaviour.

### src/integrations/shopify/pushWarehouseStock.service.js
Pushes OMS sellable stock (real − hold) to Shopify `available`.

| Name | What it does | Inputs → Outputs | Calls / depends on |
|---|---|---|---|
| `isRealShopifyInventoryItem` (internal) | Only real `gid://shopify/InventoryItem/…` ids. | id → bool | — |
| `shopifyAvailableFromVariant` | `max(0, realStock − onHoldStock)`. | variant → int | — |
| `resolveShopifyLocationId` | Settings/env location, else first active location (persisted). | — → location GID | `fetchLocations`, `Settings` |
| `syncVariantAvailableToShopify` | Asserts write policy, sets one variant's available, updates `onlineStock`/`shopifyAvailable`. | variantId → `{sku, available, locationId}` | `assertShopifyInventoryWriteAllowed`, `inventorySetQuantities`, `Variant` |
| `pushWarehouseStockToShopify` | Full-catalog push in batches of 25 (350 ms pause); `dryRun` returns plan. | `{dryRun}` → summary | same + `Variant.bulkWrite` |

### src/integrations/shopify/queries/locations.js
| Name | What it does | Inputs → Outputs | Calls / depends on |
|---|---|---|---|
| `fetchLocations` | `locations(first:20)` with id/name/isActive/address. | — → node[] | `shopifyGraphQL` |

### src/integrations/shopify/queries/products.js
Paginated catalog read + option parsing.

| Name | What it does | Inputs → Outputs | Calls / depends on |
|---|---|---|---|
| `parseVariantOptions` | Color/size from option names (EN/AR lists), position fallback, then first/second value fallback. | selectedOptions, productOptions → `{color,size}` | — |
| `fetchAllProducts` | `products(first:50, query:"status:active OR status:draft")`, `variants(first:100)`; adds resolved color/size/image/onlineStock (`inventoryQuantity`)/compareAt. | — → product nodes[] | `shopifyGraphQL` |

### src/integrations/shopify/queries/shop.js
| Name | What it does | Inputs → Outputs | Calls / depends on |
|---|---|---|---|
| `fetchShopInfo` | `shop { name email myshopifyDomain currencyCode primaryDomain }`. | — → shop | `shopifyGraphQL` |

### src/integrations/shopify/setup.service.js
Connection test/status, order & customer imports, order lookup by name.

| Name | What it does | Inputs → Outputs | Calls / depends on |
|---|---|---|---|
| `testShopifyConnection` | Reads shop + locations, stores shop name/domain/health, picks location if unset. | — → `{shop, locations}` | `fetchShopInfo`, `fetchLocations`, `Settings` |
| `getShopifyStatus` | Status payload: auth mode, installed app, counts, last sync/webhook, write policy. | — → status | `Settings`, models, `shopifyGraphQL(currentAppInstallation)` |
| `importRecentShopifyOrders` | `GET /orders.json?status=any&limit=N&order=created_at desc`; creates missing orders, updates names. | `{limit}` → counts | `shopifyRest`, `handleOrdersCreate`, `mapImportedOrderStatus` |
| `importShopifyOrdersSince` | Paginates orders by `created_at_min`/`updated_at_min`; existing → `handleOrdersUpdated`, new → `handleOrdersCreate`; stamps `shopifyLastSyncAt`. | `{since, maxItems, dateField}` → counts | `shopifyRestPaginated`, handlers |
| `importAllShopifyOrders` | Same loop over every order. | `{maxItems}` → counts | same |
| `importOpenShopifyOrders` | Same loop over `status=open&fulfillment_status=unfulfilled` (reserves stock). | `{maxItems}` → counts | same |
| `ensureOrdersLoaded` | Boot: if 0 orders import open ones; else 30-day catch-up + name backfill. | — → summary | above |
| `mapShopifyCustomer` (internal) | REST customer → OMS customer (gender inference). | sc → doc | `resolveGender` |
| `findExistingCustomerForShopifyImport` (internal) | Match by Shopify id, phone regexes, phone+name. | mapped → Customer/null | `phoneMatchRegexes` |
| `importAllShopifyCustomers` | Backfills unknown genders, then paginates `/customers.json` and upserts. | `{maxItems,onProgress}` → counts | `shopifyRestPaginated`, `Customer` |
| `startCustomerImportInBackground` / `getCustomerImportState` | In-memory background runner + state. | → state | above |
| `backfillShopifyOrderNames` | Fills missing `shopifyOrderName` from `/orders.json?fields=id,name,order_number`. | `{maxItems}` → counts | `shopifyRestPaginated` |
| `importShopifyOrderByName` | GraphQL `orders(query:name:#…)` then REST `/orders/:id.json`, fallback REST `?name=`; upserts into OMS. | query → Order/null | `shopifyGraphQL`, `shopifyRest`, `handleOrdersCreate` |
| `fullShopifySync` | Test + catalog sync + recent-order import. | opts → `{catalog, orders}` | above, `syncCatalogFromShopify` |

### src/integrations/shopify/storefrontCatalog.service.js
Fallback catalog sync from public `/{domain}/products.json` (no Admin API).

| Name | What it does | Inputs → Outputs | Calls / depends on |
|---|---|---|---|
| `resolveShopDomain` | env → Settings → hard-coded `gazellefootwear.com`. | settings → domain | `config` |
| `parseStorefrontOptions` (internal) | option1-3 → color/size with extra heuristics. | product, variant → `{color,size}` | `parseVariantOptions` |
| `variantImageUrl` / `mapStorefrontStatus` / `fetchStorefrontPage` (internal) | Image pick; published?active; GET page of 250. | … | `fetch` |
| `syncCatalogFromStorefront` | Upserts products/variants (inventory item id `storefront:<id>` placeholder), sets catalog mode `storefront`. | `{shopDomain}` → counts | `Product`, `Variant`, `Settings` |

### src/integrations/shopify/sync.service.js
Admin catalog mirror (hourly job + boot).

| Name | What it does | Inputs → Outputs | Calls / depends on |
|---|---|---|---|
| `mapShopifyStatus` (internal) | ACTIVE/ARCHIVED/DRAFT → lowercase. | → status | — |
| `syncCatalogFromShopify` | Upserts ACTIVE+DRAFT products (DRAFT stored as `active`), variants matched by GID or case-insensitive SKU; new variants get real/hold 0; overwrites `onlineStock` from Shopify. **Hard-deletes** products + variants not returned by Shopify. | — → `{products, variants, mode}` | `fetchAllProducts`, `Product`, `Variant`, `Settings` |
| `syncCatalog` | Admin if configured, else storefront. | `{preferStorefront}` → result | above |
| `startCatalogSyncInBackground` / `getCatalogSyncState` | In-memory background runner. | → state | `syncCatalog` |

### src/integrations/shopify/syncOrderMoney.service.js
Refreshes money + ship-to from Shopify right before creating a Bosta AWB.

| Name | What it does | Inputs → Outputs | Calls / depends on |
|---|---|---|---|
| `applyShopifyShippingAddress` | Copies shipping (or billing) address onto order unless `shippingAddressLockedAt`. | order, payload → bool | — |
| `syncShopifyMoneyOntoOrder` | `GET /orders/:id.json`, applies money + address, saves; errors logged and swallowed (OMS values used). | order → order | `shopifyRest`, `applyShopifyMoneyFields` |
| `syncShopifyMoneyByOrderId` | Loader wrapper. | orderId → order | above |

### src/integrations/shopify/webhooks.service.js
Registers Shopify webhook subscriptions to `${APP_URL}/webhooks/shopify/<topic-path>`.

| Name | What it does | Inputs → Outputs | Calls / depends on |
|---|---|---|---|
| `listShopifyWebhooks` | `webhookSubscriptions(first:50)` (no callers). | — → list | `shopifyGraphQL` |
| `registerShopifyWebhooks` | `webhookSubscriptionCreate` for 6 topics (JSON); no de-dup against existing subscriptions; stamps registeredAt if any succeeded. | — → `{results, successCount, total}` | `shopifyGraphQL`, `Settings`, `config.APP_URL` |

### src/integrations/shopify/writePolicy.js
Shopify inventory write gate (`Settings.shopifyWritePolicy`, default `oms_only`).

| Name | What it does | Inputs → Outputs | Calls / depends on |
|---|---|---|---|
| `getShopifyWritePolicy` | Reads policy. | — → string | `Settings` |
| `assertShopifyInventoryWriteAllowed` | Throws 403 unless `full`. | — → void | above |
| `enableShopifyInventorySync` | Sets policy `full`. | — → `'full'` | `Settings` |

### src/integrations/shopify/zeroPickupShipping.service.js
Sets Shopify shipping to EGP 0 for warehouse pickup orders.

| Name | What it does | Inputs → Outputs | Calls / depends on |
|---|---|---|---|
| `zeroShopifyShippingForPickup` | Checks `totalShippingPriceSet`; if ≥0 runs `orderEditBegin` → update/add shipping line "Warehouse pickup" 0.00 EGP → `orderEditCommit`; on failure falls back to REST `PUT /orders/:id.json` shipping_lines. | order → `{ok|skipped,…}` | `shopifyGraphQL`, `shopifyRest` |

### src/integrations/bosta/client.js
Bosta HTTP transport.

| Name | What it does | Inputs → Outputs | Calls / depends on |
|---|---|---|---|
| `isBostaConfigured` | `BOSTA_API_KEY` present. | — → bool | `config` |
| `bostaRequest` | `fetch` to `BOSTA_API_BASE_URL + path` with raw key in `Authorization`; query builder; throws with `statusCode` on non-2xx (logs unless `quiet`). No retry/back-off. | path, `{method, body, query, quiet}` → JSON | `fetch`, logger |

### src/integrations/bosta/cities.service.js
| Name | What it does | Inputs → Outputs | Calls / depends on |
|---|---|---|---|
| `fetchBostaCities` | `GET /cities` (1h in-memory cache); stores list in Settings. | `{force}` → cities[] | `bostaRequest`, `Settings` |
| `getBostaCitiesFromDb` | Settings cities. | — → cities[] | `Settings` |
| `fetchBostaDistricts` | `GET /cities/:id/districts` (1h per-city cache). | cityId → districts[] | `bostaRequest` |

### src/integrations/bosta/webhookPayload.js
| Name | What it does | Inputs → Outputs | Calls / depends on |
|---|---|---|---|
| `normalizeBostaWebhookPayload` | Accepts delivery at root/`data`/`delivery`; extracts id, state, tracking, businessReference, type, cod, timeStamp, exception fields. | raw → `{payload, deliveryId, state, …}` | — |
| `bostaWebhookExternalId` | `<deliveryId|tracking>-<stateCode>` (falls back to `Date.now()` when no state). | ids → string | — |
| `appPublicBaseUrl` / `bostaWebhookUrl` | `${APP_URL}/webhooks/bosta`. | appUrl → url | — |

### src/integrations/bosta/states.js
Bosta state/type codes and mapping to OMS statuses.

| Name | What it does | Inputs → Outputs | Calls / depends on |
|---|---|---|---|
| `BOSTA_STATE`, `DEFAULT_STATE_TO_INTERNAL`, `RETURN_STATE_CODES`, `RETURN_EXCEPTION_CODES`, `RETURN_SEARCH_STATES` | Constants (10…105 codes, labels). | — | — |
| `normalizeBostaType` | Type object/number/string → token (10 SEND, 15/30 EXCHANGE, 20 RTO, 25 CUSTOMER_RETURN_PICKUP). | type → token | — |
| `resolveInternalStatusForBosta` | Code+type+exception aware mapping (return-type shipments stay `returning_to_origin`, 41 by type, 47 exceptions, open SEND exceptions → `failed_delivery`). | state, `{type, exceptionCode}` → status | helpers |
| `parseBostaDate`, `extractBostaStateTokens`, `extractBostaStateCode`, `isReturnState`, `extractBostaReturnedAt`, `defaultInternalStatusForState` | Parsing helpers. | … | — |

### src/integrations/bosta/shipments.service.js
Bosta delivery create/update/get/AWB and address resolution.

| Name | What it does | Inputs → Outputs | Calls / depends on |
|---|---|---|---|
| `splitName` (internal) | First/last name split (last defaults `.`). | name → `{firstName,lastName}` | — |
| `isOrderPrepaidForBosta` | online/prepaid method, paid status, or `onlinePaidAt`. | order → bool | — |
| `bostaCodAmountForOrder` | Delegates to `omsCodCollectAmount`. | order → EGP | `utils/omsCod` |
| `BOSTA_DELIVERY_TYPE` / `bostaDeliveryTypeForOrder` | 10 SEND, 20 RTO, 25 CRP (return order), 30 EXCHANGE. | order → code | — |
| `formatItemLines`, `countItems`, `buildPackageDescription` (internal) | Builds AWB description (≤400 chars) incl. COD/exchange/creator/repair tags. | order, variants → string | — |
| `loadVariantsForOrder` (internal) | Loads variant + product titles for outbound + return lines. | order → Map | `Variant`, `Product` |
| `compactCity`, `isCountryLabel`, `CITY_ALIASES`, `resolveBostaCityId` (internal) | City text → Bosta city via Settings list, alias table, fuzzy match. | name → `{cityId, resolvedName, aliased}` | `Settings` |
| `AREA_ALIASES`, `WEAK_AREA_TOKENS`, `normalizeDistrictNeedle`, `addressTokens`, `resolveBostaDistrict` (internal) | Scores districts (covered only) against zone/street tokens; needs score ≥100. | cityId, hints → district/null | `fetchBostaDistricts` |
| `createDelivery` | Validates address/phone/name, COD invariants (prepaid/return → 0), resolves city/district, builds payload (type, specs, receiver, dropOff, `businessReference=order._id`, cod, notes, webhookUrl if public, Flex opt-out fields, CRP `pickupAddress`, exchange `returnSpecs`); `POST /deliveries`. Retries once without Flex fields, once with zone-only address on 4009/3002; maps errors to user messages. | order, customer → Bosta delivery | `bostaRequest`, helpers |
| `updateDeliveryPackageDescription` | `PUT /api/v0/deliveries/:id` with description + COD; retries without `notes`. | deliveryId, order → `{description, data}` | raw `fetch` |
| `updateDeliveryAddressAndCod` | Re-resolves address (duplicated logic) and `PUT /api/v0/deliveries/:id` with dropOff/receiver/COD. | deliveryId, order, customer → result | raw `fetch`, helpers |
| `getDelivery` | Numeric ≥8 digits → `GET /deliveries/business/:tracking`; else map OMS deliveryId?tracking; then quiet probes `/deliveries/business/:key`, `/deliveries/:key`. | key → delivery | `bostaRequest`, `Order` |
| `getAwb` | Tries `/deliveries/mass-awb?ids=` (id, then tracking), `/deliveries/awb`, `/deliveries/:id/awb`. | deliveryId, tracking → `{url}` (data: PDF) | `bostaRequest`, `normalizeAwbPayload` |
| `normalizeAwbPayload` (internal) | URL/base64 → data URL. | raw → `{url}` | — |

### src/integrations/bosta/tracking.service.js
Applies Bosta states to OMS orders (webhook + polling).

| Name | What it does | Inputs → Outputs | Calls / depends on |
|---|---|---|---|
| `isForeignBostaDelivery` (internal) | WooCommerce source / `woo*` refs. | delivery → bool | — |
| `asFiniteNumber`, `extractBostaCollectedAmount`, `extractBostaEventAt` (internal) | COD amount + event time extraction. | payload → number/Date | — |
| `mapBostaStateToInternal` | Built-in mapping for codes 10/11/20/21/22/23/41/47 or when `type` known; else active `BostaStatusMapping` DB row by token; else built-in. | state, meta → status | `BostaStatusMapping`, `states.js` |
| `findOrderForBostaPayload` (internal) | Match by `bostaDeliveryId`, tracking, or 24-hex `businessReference`. | ids → Order/null | `Order` |
| `transitionToward` (internal) | Walks bridge statuses when Bosta skips steps. | orderId, from, to, meta → order | `canTransition`, `orderService.transitionOrderStatus` |
| `processBostaStatusUpdate` | Guards (foreign, linked-id/tracking mismatch, pending_verification/no_response, ready-to-ship ownership), links id/tracking, stamps COD + fee breakdown on delivered, unwinds false delivered, transitions. Transition errors logged and swallowed. | `{deliveryId, state, payload, note}` → order/null | above, `orderService.unwindFalseDeliveredSale`, `pricing.service` |
| `pollStuckOrders` | Up to 100 linked orders not updated within threshold → `getDelivery` → `processBostaStatusUpdate`. | hours → results[] | `getDelivery` |

### src/integrations/bosta/orderStates.service.js
Bulk refresh/backfill of Bosta states.

| Name | What it does | Inputs → Outputs | Calls / depends on |
|---|---|---|---|
| `isForeignBostaDelivery` (internal) | Duplicate of tracking.service helper. | — | — |
| `resolveLiveDelivery` (internal) | `getDelivery` by tracking then id. | order, fallback → delivery | `getDelivery` |
| `linkAndSyncOrder` (internal) | Link guards (same as webhook) + `bostaShipmentStatus='created'` + apply state. | order, delivery, note → result | `processBostaStatusUpdate` |
| `syncOrderStatesFromBosta` | Courier-active orders first (≤150) then others, oldest `lastStatusUpdateAt` first; one `getDelivery` per order. | `{limit, since, prioritizeCourier}` → counters | `resolveLiveDelivery`, `processBostaStatusUpdate` |
| `backfillBostaSince` | `POST /deliveries/search` per state label (Delivered/Returned/Terminated/Exception/Canceled), matches by link/tracking/Mongo ref, then linked refresh. | `{since, endDate, maxPagesPerState}` → counters | `bostaRequest`, `linkAndSyncOrder` |

### src/integrations/bosta/cod.service.js
Delivered COD reconciliation for reports.

| Name | What it does | Inputs → Outputs | Calls / depends on |
|---|---|---|---|
| `deliveryCod`, `deliveryCollectedAt`, `isDeliveredState`, `cairoYmd` (internal) | Field extraction, Cairo date. | — | — |
| `stampOrderFromDelivery` (internal) | Skips Woo, matches COD order by id/tracking/Mongo ref, sets `bostaCollectedAmount/At`. | delivery, range → hit/null | `Order.updateOne` |
| `mapPool` (internal) | Concurrency pool (8). | — | — |
| `syncAndSumDeliveredCod` | Refreshes candidate orders via `getDelivery`, supplemental `POST /deliveries/search state=Delivered`, then aggregates stamped COD. | `{from, to, maxPages}` → `{amount, count, …}` | `getDelivery`, `bostaRequest`, `Order.aggregate` |
| `sumDeliveredCod` | Deprecated alias (no callers). | → same | above |

### src/integrations/bosta/returns.service.js
Mirrors Bosta return deliveries into `BostaReturn` for dashboards.

| Name | What it does | Inputs → Outputs | Calls / depends on |
|---|---|---|---|
| `searchDeliveries` | Pages `POST /deliveries/search` (50/page, ?80 pages). | body, `{maxPages}` → deliveries[] | `bostaRequest` |
| `normalizePhone`, `deliveryTypeMeta`, `receiverMeta` | Helpers. | — | — |
| `findLinkedOrder` | Match by id, tracking, Mongo ref, **or numeric `shopifyOrderId`**. | delivery → orderId/null | `Order` |
| `upsertDocFromDelivery` (internal) | Builds BostaReturn doc for return states/RTO/CRP types. | delivery, orderId → doc/null | `states.js` |
| `syncBostaReturns` | Searches "Returned to business", "Terminated", and `type: RTO`; batch-links orders; bulk upserts. | `{maxPages, from, to}` → counts | `searchDeliveries`, `BostaReturn.bulkWrite` |
| `bostaReturnsForRange` | Aggregates by type (RTO/CRP/exchange/send), excludes repair orders. | `{from,to}` → metrics | `BostaReturn`, `Order` |

### src/integrations/bosta/pricing.service.js
Bosta fee parsing and calculator.

| Name | What it does | Inputs → Outputs | Calls / depends on |
|---|---|---|---|
| `roundEgp`, `readAmount`, `parseFeeLines` (internal) | Amount readers, labeled-line parser. | — | — |
| `parseBostaFeeBreakdown` | Normalises calculator/wallet payloads to `{shippingFee, openPackageFee, nextDayTransferFee, vat, insuranceFee, total, source, fetchedAt}`. | raw, source → breakdown/null | — |
| `parseBostaFeeBreakdownFromDelivery` | Prefers wallet.cashCycle/fee objects; merges `shipmentFees` with pricing insurance. | delivery → breakdown/null | above |
| `mapCalculatorType` (internal) | 25/30 → CRP/EXCHANGE else SEND. | — | — |
| `buildCalculatorParamsForOrder` | Calculator params (pickup city from `process.env.BOSTA_PICKUP_CITY` or `Cairo`). | order → params/null | `bostaCodAmountForOrder`, `bostaDeliveryTypeForOrder` |
| `calculateShipmentFees` | `GET /pricing/shipment/calculator`. | params → breakdown | `bostaRequest` |

### src/integrations/bosta/pricing.service.test.js
Covers calculator fields, labeled fee lines, wallet.pricing, live wallet.cashCycle strings, nested amount objects + VAT derivation, and `shipmentFees` + insurance merging.

### src/integrations/bosta/bostaFees.service.js
Per-order Bosta fee sync (delivery API → calculator).

| Name | What it does | Inputs → Outputs | Calls / depends on |
|---|---|---|---|
| `BOSTA_API_FEE_SOURCES` | `delivery`, `calculator`. | — | — |
| `resolveBostaCourierFeeForOrder` | Breakdown total else zone estimate. | order → EGP | `constants/shippingZones` |
| `isBostaApiFeeBreakdown` | True for API sources (or legacy rows without source). | breakdown → bool | — |
| `breakdownIsFresh`, `orderHasBostaShipment` (internal) | 6h freshness; Bosta-shipped check. | — | — |
| `syncBostaFeesForOrder` | Reuses fresh breakdown; else `getDelivery` parse; else calculator; persists `bostaFeeBreakdown`/`bostaCourierFee`. | order, `{force, allowCalculator}` → breakdown/null | `getDelivery`, pricing.service, `Order.updateOne` |
| `syncBostaFeesForOrders` | Concurrent worker pool (default 5). | orders, opts → counters | above |
| `enrichBostaFeeFields` | Adds live breakdown + `bostaCourierFee` to API payloads (may call Bosta per order). | order, `{refresh}` → object | above |

### src/integrations/paymob/payments.service.js
Records Paymob webhook payments (no order linking).

| Name | What it does | Inputs → Outputs | Calls / depends on |
|---|---|---|---|
| `parseFiniteNumber`, `extractExternalId`, `isPaid`, `extractAmountEgp`, `extractReceivedAt` (internal) | Payload extraction; `isPaid` uses `success`/status strings only. | — | — |
| `recordPaymobPayment` | Creates `PaymobReceived {externalId, amountEgp, receivedAt}`; duplicate key → `duplicate`. | payload → `{recorded, reason?}` | `PaymobReceived` |

### src/integrations/paymob/transactions.service.js
Pulls Paymob Accept transactions for revenue reports.

| Name | What it does | Inputs → Outputs | Calls / depends on |
|---|---|---|---|
| `isPaymobApiConfigured` | `PAYMOB_API_KEY` set. | — → bool | `config` |
| `getAuthToken` (internal) | `POST https://accept.paymob.com/api/auth/tokens`. | — → token | `fetch` |
| `parsePaymobTimestamp` | Naive timestamps treated as Africa/Cairo wall time. | raw → Date | Intl |
| `fetchTransactionsPage` (internal) | `GET /api/acceptance/transactions?page&page_size=50` with retry on 5xx/429/network (4 tries). | token, page → `{results, hasNext}` | `fetch` |
| `isSuccessfulTx` (internal) | success && !pending && !voided && !refunded && !error. | tx → bool | — |
| `sumSuccessfulTransactions` | Pages newest-first, clips to range client-side, upserts `PaymobReceived` per page. | `{from,to,maxPages}` → `{amount,count,pages}` | above, `PaymobReceived.bulkWrite` |
| `syncAndSumPaymobReceived` | Live sync then returns ledger total if ledger has more rows than live. | `{from,to}` → totals | above |

### src/webhooks/shopify.router.js
`POST /webhooks/shopify/:topic` (mounted with raw-body capture in `app.js:34-42`).

| Name | What it does | Inputs → Outputs | Calls / depends on |
|---|---|---|---|
| route handler | Topic from path (`-`?`/`), HMAC check (401 on fail), externalId = `X-Shopify-Webhook-Id` → `X-Shopify-Event-Id` → `<topic>-<id|now>`, enqueue, `200 OK`. | req → 200/401 | `verifyShopifyHmac`, `enqueueShopifyWebhook` |

### src/webhooks/verifyShopifyHmac.js
| Name | What it does | Inputs → Outputs | Calls / depends on |
|---|---|---|---|
| `verifyShopifyHmac` | base64 HMAC-SHA256 of raw body with `SHOPIFY_WEBHOOK_SECRET` (env or Settings); `timingSafeEqual`. No secret → accept in non-production, reject in production. | rawBody, header → bool | `getShopifyCredentials` |

### src/webhooks/shopify.handlers.js
Shopify webhook processing and order ingest (also used by imports).

| Name | What it does | Inputs → Outputs | Calls / depends on |
|---|---|---|---|
| `enrichContactFromShopifyGraphql` (internal) | Admin GraphQL `order{shippingAddress,billingAddress,customer,fulfillmentOrders}` to backfill PII placeholders + pickup detection. | payload, address → `{shippingAddress, fulfillmentOrders}` | `shopifyGraphQL` |
| `resolveVariant` (internal) | Variant by GID/numeric id, then SKU. | line → Variant/null | `Variant` |
| `shopifyOrderNameFromPayload` (internal) | `name` or `#order_number`. | — | — |
| `mapImportedOrderStatus` | cancelled_at → cancelled; closed+fulfilled → delivered; else pending_verification. | payload → status | — |
| `handleOrdersCreate` | Idempotent by `shopifyOrderId`; customer find/create (fallback create); skips COD-fee lines; offer flags; transaction: Order + reserve stock (open orders) + status history; on transaction failure creates a stub order; pushes sellable to Shopify; zeroes pickup shipping; notifies on real-time orders. | payload, `{reserveStock, statusOverride, source}` → Order | customer/order/notification services, `withTransaction`, `zeroShopifyShippingForPickup` |
| `handleOrdersCancelled` | Cancels OMS order (reason `customer_changed_mind`) unless already cancelled. | payload → order/null | `cancelOrder` |
| `handleOrdersUpdated` | Missing → create; cancelled_at → cancel; name, pickup, money fields, ship-to (unless address locked), PII enrich, save; zero pickup shipping. Never maps Shopify fulfilled → delivered. | payload → order | `applyShopifyMoneyFields`, enrich, `zeroShopifyShippingForPickup` |
| `handleProductsUpdate` | Upserts product + variants from REST payload; deletes variants with blank SKU. | payload → Product | `Product`, `Variant` |
| `handleInventoryLevelsUpdate` | Ignores non-warehouse locations; computes available (or `onlineStock + adjustment`); queues inbound ingest; on failure records drift. | payload → variant/null | `queueShopifyInventoryIngest`, `reportOnlineStockDrift` |
| `processShopifyWebhookJob` | Dispatches by topic (`refunds/create` only logged); marks receipt processed; order-topic errors are recorded and **not rethrown**. | `{receiptId, topic}` → result | handlers above |
| `retryFailedShopifyOrderCreates` | Re-runs `handleOrdersCreate` for up to 40 unprocessed order receipts (create **and** updated). | `{limit}` → `{recovered, scanned}` | `WebhookReceipt`, `handleOrdersCreate` |

### src/webhooks/bosta.router.js
`POST /webhooks/bosta`.

| Name | What it does | Inputs → Outputs | Calls / depends on |
|---|---|---|---|
| route handler | Normalises payload, externalId `<id>-<state>`, enqueues; always 200 (even if enqueue fails). No signature/secret check. | req → 200 | `normalizeBostaWebhookPayload`, `bostaWebhookExternalId`, `enqueueBostaWebhook` |

### src/webhooks/paymob.router.js
`POST /webhooks/paymob`.

| Name | What it does | Inputs → Outputs | Calls / depends on |
|---|---|---|---|
| `unwrapPaymobPayload` (internal) | Transaction from `obj`/`transaction`/root. | body → obj | — |
| route handler | HMAC from `?hmac`, header, or body; verified only if `PAYMOB_HMAC_SECRET` set; creates `WebhookReceipt` (`<id>-<status>`), records payment, 200; duplicate → 200; other error → 500. | req → 200/401/500 | `verifyPaymobHmac`, `recordPaymobPayment`, `WebhookReceipt` |

### src/webhooks/verifyPaymobHmac.js
| Name | What it does | Inputs → Outputs | Calls / depends on |
|---|---|---|---|
| `computePaymobHmac` | HMAC-SHA512 (hex) over 20 ordered transaction fields (amount_cents … success). | obj, secret → hex/null | `crypto` |
| `verifyPaymobHmac` | Constant-time compare; false if secret missing. | obj, hmac → bool | above |

### src/jobs/index.js
Agenda job definitions + recurring schedule (see Background jobs).

| Name | What it does | Inputs → Outputs | Calls / depends on |
|---|---|---|---|
| `registerJobs` | Defines 15 Agenda jobs (`JOB_NAMES`). | agenda → void | handlers, Bosta/Shopify services, order/inventory/admin services |
| `scheduleRecurringJobs` | `agenda.every(...)` for 11 recurring jobs. Called only by the API process. | agenda → void | Agenda |

### src/workers/agendaWorker.js
Optional standalone queue processor (`npm run worker`); connects DB, registers jobs, starts Agenda, does **not** schedule recurring jobs. Not deployed by `render.yaml` (the API process runs jobs itself, `server.js:49-53`).

| Name | What it does | Inputs → Outputs | Calls / depends on |
|---|---|---|---|
| `startWorker` (internal) | DB connect + `registerJobs` + `agenda.start`; SIGTERM/SIGINT graceful stop. | — | `connectDatabase`, `createAgenda`, `registerJobs` |

### src/utils/assertCollectFromPriorOrder.js
Validates exchange/return "collect" lines against the prior order.

| Name | What it does | Inputs → Outputs | Calls / depends on |
|---|---|---|---|
| `skuFamily` | Strips trailing `-<size>`. | sku → family | — |
| `buildPriorPools`, `takeFromPools` (internal) | Remaining qty by variant/SKU. | — | — |
| `assertCollectFromPriorOrder` | Throws 400 if a collect line isn't on the prior order or exceeds qty. | items, priorOrder, `{kind}` → true | pools |
| `healCollectToPriorOrder` | Remaps wrong-size collect lines to the same SKU family on the prior order. | items, priorOrder → `{items, changed, fixes}` | pools |

### src/utils/assertCollectFromPriorOrder.test.js
Covers accept/reject wrong size/over-qty and healing to the prior size; `skuFamily`.

### src/utils/computeCustomerRefundAmount.js
| Name | What it does | Inputs → Outputs | Calls / depends on |
|---|---|---|---|
| `computeCustomerRefundAmount` | stored refundAmount → exchange credit → collect line prices → matching prior lines → prior total. | order, priorOrder → EGP | — |

### src/utils/computeCustomerRefundAmount.test.js
Covers each fallback tier (stored, exchange credit, collect lines, prior SKU match, prior total).

### src/utils/excelExport.js
| Name | What it does | Inputs → Outputs | Calls / depends on |
|---|---|---|---|
| `sendExcel` | Sets xlsx headers, sends buffer. | res, `{buffer, filename}` | — |
| `workbookBuffer` | `xlsx.writeBuffer()`. | workbook → buffer | exceljs |
| `styleHeaderRow` | Bold header. | sheet, row | — |
| `addSheetFromRows` | Sheet from columns/rows (no callers). | wb, name, cols, rows → sheet | — |

### src/utils/gender.js
| Name | What it does | Inputs → Outputs | Calls / depends on |
|---|---|---|---|
| `inferGenderFromName` | First-name lookup in EN/AR male/female sets + Arabic suffix heuristic. | name → male/female/unknown | — |
| `resolveGender` | Keeps explicit gender else infers. | gender, name → gender | above |

### src/utils/idempotency.js
| Name | What it does | Inputs → Outputs | Calls / depends on |
|---|---|---|---|
| `enqueueShopifyWebhook` | Inserts `WebhookReceipt` (unique `source+externalId`), stamps `shopifyLastWebhookAt`, `agenda.now(process-shopify-webhook)`; dup key → null. | `{topic, externalId, payload}` → receipt/null | `WebhookReceipt`, `Settings`, Agenda |
| `enqueueBostaWebhook` | Same for Bosta (`bostaLastWebhookAt`, `process-bosta-webhook`). | `{externalId, payload}` → receipt/null | same |

### src/utils/keepAwake.js
| Name | What it does | Inputs → Outputs | Calls / depends on |
|---|---|---|---|
| `parseAwakeHours` | `"8-24"` → `{start,end}` (wrap allowed). | string → obj | — |
| `parseOffDays` | `"fri,sat"` → day keys. | string → string[] | — |
| `isWithinAwakeWindow` | Cairo clock check incl. past-midnight shifts. | date, window → bool | Intl |
| `startKeepAwake` | Every 10 min GETs `${APP_URL}/api/v1/health` inside window (prod + https, or `KEEP_AWAKE=on`). | opts → timer/null | `fetch` |

### src/utils/keepAwake.test.js
Covers hour/off-day parsing fallbacks, Sat–Thu working hours, Friday/night sleep, past-midnight shift attribution.

### src/utils/logger.js
Pino logger (`info` in production, `debug` + stdout transport otherwise). Single default export.

### src/utils/offerOrder.js
| Name | What it does | Inputs → Outputs | Calls / depends on |
|---|---|---|---|
| `isB1g1Tag` / `hasB1g1Tag` | Buy1Get1 tag detection. | tag(s) → bool | — |
| `lineOfferInfo` | `b1g1` (tag) or `sale` (below compare-at). | variant, tags, unitPrice → info | — |
| `orderHasOfferItems` | Any line on offer. | items → bool | — |

### src/utils/offerOrder.test.js
Covers B1G1 tag spellings, sale detection, b1g1 precedence, full price, creator-gift price fallback, order-level flag.

### src/utils/omsCod.js
| Name | What it does | Inputs → Outputs | Calls / depends on |
|---|---|---|---|
| `OMS_COD_FEE_EGP` | 25. | — | — |
| `isOrderPrepaid` | Same rule as `isOrderPrepaidForBosta`. | order → bool | — |
| `omsCodFeeEgp` | 25 on normal COD; 0 for return/exchange/repair/prepaid/zero-total creator. | order → EGP | — |
| `omsCodCollectAmount` | goods + shipping → exchange credit + fee (0 for return/prepaid). | order → EGP | — |
| `enrichOrderMoneyFields` | Adds `codFeeEgp`, `codCollectAmount`. | order → object | — |

### src/utils/omsCod.test.js
Covers +25 fee, Shopify COD ingest math, no fee for prepaid/return/exchange, zero creator gift, repair exact total.

### src/utils/orderRefs.js
| Name | What it does | Inputs → Outputs | Calls / depends on |
|---|---|---|---|
| `isManualOrderRef` | `M-<n>` or `MAN-…`. | value → bool | — |

### src/utils/phone.js
| Name | What it does | Inputs → Outputs | Calls / depends on |
|---|---|---|---|
| `digitsOnly` | Strip non-digits. | → string | — |
| `normalizeEgPhoneDigits` | National 10-digit core. | phone → string | — |
| `phoneMatchRegexes` | Suffix regexes (core, 0core, 20core). | phone → RegExp[] | — |

### src/utils/returnKind.js
| Name | What it does | Inputs → Outputs | Calls / depends on |
|---|---|---|---|
| `classifyReturnKind` | exchange / refund (return order or delivered) / refused. | order → kind | — |

### src/utils/returnKind.test.js
Covers exchange, refund (CRP + post-delivery), refused.

### src/utils/shippingEconomics.js
Shipping loss = customer shipping collected → Bosta API fees (from 2026-09-01).

| Name | What it does | Inputs → Outputs | Calls / depends on |
|---|---|---|---|
| `SHIPPING_LOSS_START_YMD`, `BOSTA_FAILED_RTO_STATUSES` | Constants. | — | — |
| `shippingLossAppliesToRange` | Range end → start date. | `{from,to}` → bool | — |
| `roundMoney`, `isBostaShippingOrder`, `isFailedRtoStatus` | Helpers. | — | — |
| `resolveRealBostaFee` | Breakdown → stored fee → optional fallback. | order, fn → EGP | — |
| `resolveBostaApiFee` | API-sourced breakdown only. | order → EGP | — |
| `computeShippingEconomics` | Totals + summary lines. | totals → economics | — |
| `computeShippingEconomicsFromOrders` | Delivered: collected vs fee; failed/RTO: fee is full loss. | lists → economics | above |
| `loadShippingEconomicsForRange` | Queries orders, syncs fees from Bosta (concurrency 6), computes. | `{from,to,Order}` → economics | `bostaFees.service` |

### src/utils/shippingEconomics.test.js
Covers loss vs gain, invoice-first fee resolution, failed/RTO full loss, ignoring zone estimates, start-date gating.

### src/utils/shopifyPaymentIncentives.js
COD-fee/ONLINE5 helpers; Shopify edits are disabled.

| Name | What it does | Inputs → Outputs | Calls / depends on |
|---|---|---|---|
| constants | `ONLINE5`, 25 EGP, `GAZELLE-COD-FEE`, Arabic title, attr. | — | — |
| `isCodFeeLine` | COD fee line by SKU/title/regex (incl. Releasit). | line → bool | — |
| `orderHasOnlineDiscount`, `isOnlineFiveDiscount` | ONLINE5 detection (test-only callers). | → bool | — |
| `orderHasCodFee` | Additional-fees ≥24.5 or fee line. | payload → bool | — |
| `planPaymentIncentives`, `incentivesNeedShopifyEdit` | Always "no edit" (test-only callers). | → plan/bool | — |
| `shopifyMerchandiseTotal` | total → shipping → Shopify COD fee. | payload, ship → EGP | `orderHasCodFee` |

### src/utils/shopifyPaymentIncentives.test.js
Covers ONLINE5 + fee SKU detection, Releasit fee, "never edit Shopify" plans, merchandise total stripping the fee.

### src/utils/shopifyShippingAddress.js
Handles Shopify PII-stripped addresses.

| Name | What it does | Inputs → Outputs | Calls / depends on |
|---|---|---|---|
| `rawShopifyAddress`, `hasCompleteShopifyAddress` | shipping?billing; address1+city present. | payload → obj/bool | — |
| `mapShopifyShippingAddress` | OMS address with placeholders (`Address not available from Shopify`, city?province, `Unknown`). | payload → address | — |
| `shopifyCustomerPhone` | Phone or `shopify-cust-<id>` / `shopify-order-<id>`. | payload, addr → string | — |
| `isPlaceholderPhone`, `isPlaceholderCustomerName`, `isPlaceholderStreet` | Placeholder checks. | → bool | — |
| `applyKnownCustomerContact` | Fill placeholders from OMS customer. | addr, customer → addr | — |
| `assertContactReadyToConfirm` | 400 unless real name/phone/street/city (street/city skipped for pickup). | order → void | — |

### src/utils/shopifyShippingAddress.test.js
Covers complete address, province fallback, phone placeholder, OMS-customer fill, confirm guard.

### src/utils/transaction.js
| Name | What it does | Inputs → Outputs | Calls / depends on |
|---|---|---|---|
| `withTransaction` | Mongo session + transaction; commit/abort; requires replica set. | fn(session) → result | mongoose |

---

## Third-party services

### Shopify (Admin API, version pinned `2026-07`, clamped to 2026-04…2026-07)
- **Auth**: client-credentials grant `POST https://{shop}.myshopify.com/admin/oauth/access_token` when `SHOPIFY_CLIENT_ID/SECRET` exist (token cached ~24h in `Settings`), else static `SHOPIFY_ACCESS_TOKEN` / Settings token. Header `X-Shopify-Access-Token`.
- **GraphQL** (`/admin/api/{v}/graphql.json`): `products` (catalog), `locations`, `shop`, `currentAppInstallation`, `order` (contact/fulfillmentOrders/shipping total), `orders(query: name:…)`, `fulfillmentCreateV2`, `orderCancel`, `inventorySetQuantities @idempotent` (only stock push path), `inventoryAdjustQuantities` (unused), `orderEditBegin` / `calculatedOrder` / `orderEditUpdateShippingLine` / `orderEditAddShippingLine` / `orderEditCommit` (pickup → 0 EGP), `webhookSubscriptions`, `webhookSubscriptionCreate`. THROTTLED retried up to 6×.
- **REST**: `GET /orders.json` (status=any/open, created_at_min/updated_at_min, name=, fields=, Link pagination), `GET /orders/{id}.json`, `PUT /orders/{id}.json` (pickup shipping fallback), `GET /customers.json`. No 429 handling.
- **Public storefront**: `GET https://{domain}/products.json?limit=250&page=N` (fallback catalog).
- **Webhook topics registered** (`webhooks.service.js:6-13`): `orders/create`, `orders/cancelled`, `orders/updated`, `products/update`, `inventory_levels/update`, `refunds/create` (logged only). Callback `${APP_URL}/webhooks/shopify/{topic-with-dashes}`.
- **HMAC**: raw body captured by `express.json({verify})` (`app.js:34-42`); base64 HMAC-SHA256 with `SHOPIFY_WEBHOOK_SECRET` (env, else `Settings.shopifyWebhookSecret`), `crypto.timingSafeEqual`. No secret → accepted outside production.
- **Idempotency**: `WebhookReceipt` unique (`source`, `externalId`) with `X-Shopify-Webhook-Id`; processed asynchronously by Agenda.
- **Env**: `SHOPIFY_SHOP_DOMAIN`, `SHOPIFY_ACCESS_TOKEN`, `SHOPIFY_CLIENT_ID`, `SHOPIFY_CLIENT_SECRET`, `SHOPIFY_WEBHOOK_SECRET`, `SHOPIFY_API_VERSION`, `SHOPIFY_LOCATION_ID`, `APP_URL`. Settings fallbacks: `shopifyShopDomain`, `shopifyAccessToken`, `shopifyClientId`, `shopifyClientSecret`, `shopifyWebhookSecret`, `shopifyLocationId`, `shopifyWritePolicy`.

### Bosta (`BOSTA_API_BASE_URL`, default `https://app.bosta.co/api/v2`; key in `Authorization`)
- **Endpoints**: `POST /deliveries` (create), `GET /deliveries/business/{tracking}` (preferred lookup), `GET /deliveries/{id}`, `POST /deliveries/search` (state/type/date paging), `GET /deliveries/mass-awb?ids=` (+ legacy `/deliveries/awb`, `/deliveries/{id}/awb`), `PUT /api/v0/deliveries/{id}` (description/COD/address — v2 has no update route), `GET /cities`, `GET /cities/{id}/districts`, `GET /pricing/shipment/calculator`.
- **Delivery types** (`shipments.service.js:45-59`, `states.js:96-117`):
  - `10` SEND — normal delivery; COD = goods + shipping + 25 EGP fee (0 if prepaid).
  - `20` RTO — return-to-origin of a failed delivery; never created by Gazelle, only read in sync/returns.
  - `25` CUSTOMER_RETURN_PICKUP (CRP) — return orders; COD forced 0; `pickupAddress` = drop-off; packageDetails = items to collect.
  - `30` EXCHANGE — deliver new + collect old; `returnSpecs` required; COD = new → credit + shipping. `15` is a legacy alias read-only.
  - Flex opt-out (`isCustomerPayShipping:false`, `customerShippingFee:0`, `businessPaidShipping:true`) sent for COD>0/prepaid/exchange/repair/return; retried without on rejection.
- **Webhook**: `POST /webhooks/bosta` — URL passed per delivery as `webhookUrl` (only when APP_URL is public). Normalised, deduped by `<deliveryId>-<stateCode>`, processed by Agenda `process-bosta-webhook` → `processBostaStatusUpdate`. **No authentication.**
- **Polling**: `bosta-order-states-sync` (3 min, 200 orders), `bosta-polling-fallback` (15 min, ?100 stale orders), `bosta-returns-sync` (30 min, search pages), plus on-demand `backfillBostaSince`, COD (`syncAndSumDeliveredCod`) and fee (`syncBostaFeesForOrder`) pulls from reports.
- **Order matching**: `bostaDeliveryId` → tracking → `businessReference` = Mongo `_id`; WooCommerce deliveries ignored (except `returns.service.js`, which also matches numeric Shopify ids).
- **Env**: `BOSTA_API_KEY`, `BOSTA_API_BASE_URL`, `BOSTA_PICKUP_CITY` (read via `process.env`, not in config schema), `APP_URL`.

### Paymob (Accept)
- **Webhook** `POST /webhooks/paymob`: HMAC-SHA512 hex over 20 ordered fields (`verifyPaymobHmac.js:9-30`), hmac from `?hmac`, `hmac` header, or body; verification skipped (warning only) if `PAYMOB_HMAC_SECRET` is unset. Stores `WebhookReceipt` then `PaymobReceived` (amount only, no order link).
- **API**: `POST https://accept.paymob.com/api/auth/tokens` (`api_key`), `GET /api/acceptance/transactions?page&page_size=50` (newest-first, clipped client-side) for report totals.
- **Env**: `PAYMOB_API_KEY`, `PAYMOB_HMAC_SECRET`; `PAYMOB_PUBLIC_KEY`, `PAYMOB_SECRET_KEY` are declared in config but unused.

### Others
- **MongoDB** (`MONGODB_URI`): replica set required for transactions (`docker-compose.yml`). Agenda uses collection `agendaJobs`.
- **Render** (`render.yaml`) free web service; self keep-awake (`KEEP_AWAKE`, `KEEP_AWAKE_HOURS`, `KEEP_AWAKE_OFF_DAYS`).
- **GitHub Actions** `morning-wake.yml`: curls `/api/v1/health` (var `API_URL`).

---

## Background jobs

All jobs are defined in `src/jobs/index.js`; recurring schedules are set by the API process (`server.js:49-53`). Agenda: `processEvery 30s`, `maxConcurrency 10`, `defaultConcurrency 5` (`config/agenda.js`).

| Job name | Schedule | What it does | Function |
|---|---|---|---|
| `process-shopify-webhook` | On demand (webhook enqueue) | Processes a stored Shopify receipt by topic. | `processShopifyWebhookJob` |
| `process-bosta-webhook` | On demand (webhook enqueue) | Normalises receipt, applies Bosta state; marks `no_matching_order` when unmatched. | `processBostaStatusUpdate` |
| `shopify-outbound-inventory` | On demand (retry after failed stock push) | Forces write policy `full`, pushes variant sellable qty, updates ledger `shopifySyncStatus`. | `enableShopifyInventorySync` + `syncVariantAvailableToShopify` |
| `shopify-inbound-inventory` | Delayed/unique per variant (debounced decreases) | Applies Shopify `available` to warehouse stock. | `order.service.applyShopifyAvailableToWarehouse` |
| `shopify-catalog-sync` | Every 1 hour (+ manual via settings) | Admin/storefront catalog mirror (with stale deletion). | `syncCatalog` |
| `shopify-orders-sync` | Every 5 minutes | Retries failed order receipts, then imports/updates all orders updated in last 14 days. | `retryFailedShopifyOrderCreates` + `importShopifyOrdersSince({dateField:'updated_at'})` |
| `bosta-order-states-sync` | Every 3 minutes | Refreshes up to 200 linked orders from Bosta. | `syncOrderStatesFromBosta` |
| `bosta-polling-fallback` | Every 15 minutes | Polls up to 100 orders stale > `bostaPollingThresholdHours` (default 2h). | `pollStuckOrders` |
| `bosta-returns-sync` | Every 30 minutes | Upserts Bosta returns (maxPages 60). | `syncBostaReturns` |
| `bosta-create-shipment` | Never enqueued (defined only) | Would create Bosta shipment for an order. | `fulfillment.createBostaShipmentForOrder` |
| `check-restock-needed` | Every 24 hours | Restock alerts. | `adminJobs.checkRestockNeeded` |
| `check-slow-movers` | Every 24 hours | Slow-mover alerts. | `adminJobs.checkSlowMovers` |
| `order-delay-callbacks` | Cron `0 5 * * *` (server TZ; UTC on Render) | Processes due delay callbacks. | `order.processDelayCallbacksDue` |
| `release-out-of-stock` | Every 5 minutes | Releases OOS orders now covered by stock. | `order.scanOutOfStockOrdersForRelease` |
| `stock-integrity` | Every 15 minutes | Repairs hold/ledger drift, force-pushes repaired variants to Shopify, OOS scan. | `inventory.repairStockIntegrity`, `forceSyncVariantsToShopify` |

Non-Agenda periodic work: keep-awake self-ping every 10 min (`utils/keepAwake.js`); boot-time catalog refresh, `ensureOrdersLoaded`, Bosta returns sync (`server.js:16-44`).

### Deployment & CI config
- `.github/workflows/morning-wake.yml` — cron `0 5,6 * * 0-4,6` (Sat–Thu 05:00/06:00 UTC) curls `/api/v1/health` with retries; default URL hard-coded to `gazelle-back-qre2.onrender.com`.
- `render.yaml` — single free web service `gazelle-api` (Frankfurt), `npm start`, health `/api/v1/health`; env: NODE_ENV, MONGODB_URI, JWT_SECRET (generated), JWT_EXPIRES_IN, APP_URL, CORS_ORIGIN, SHOPIFY_* (domain/token/webhook secret/version/location), BOSTA_API_KEY/BASE_URL, KEEP_AWAKE_HOURS `8-24`, KEEP_AWAKE_OFF_DAYS `fri`. No worker service; no PAYMOB_* or SHOPIFY_CLIENT_* entries.
- `docker-compose.yml` — local `mongo:7` single-node replica set `rs0` (auto `rs.initiate` in healthcheck), volume `mongo_data`.

---

## Scripts

| Script | Purpose | Writes data? |
|---|---|---|
| `backfill-lifetime-cancelled.js` | Recomputes `Customer.lifetimeCancelled`, flags frequent cancellers `watch`. | Yes (DB) |
| `export-product-cost-sheet.js` | Exports variants to CSV for COGS entry (`exports/`). | No (local file only) |
| `export-shopify-size37-customers.js` | Reads all Shopify orders, exports name/phone of size-37 buyers to `/Users/mac/Desktop/*.xlsx`. | No (Shopify read; local PII file) |
| `import-pricing-sheet.js` | Imports COGS + default factory from CSV (`--dry-run`). | Yes (DB) |
| `import-real-stock-excel.js` | One-time realStock import from a hard-coded Desktop Excel (`--dry-run`). | Yes (DB + Shopify stock push via stockImport service) |
| `migrate-local-shipping-status.js` | Moves `local_shipping` orders off `picked_up_by_bosta`. | Yes (DB) |
| `purge-dummy-pos-users.js` | Deletes two hard-coded POs and `@test.local` "Extra OM" users. | Yes (DB delete) |
| `purge-test-data.js` | Deletes seed/test fixtures; `--all-orders` wipes all orders, receipts, returns, Paymob ledger, orphan customers. | Yes (DB delete) |
| `repair-missed-exchange-collect.js` | Adds missed exchange collect restock ledger rows after 2026-07-20 (`--apply`). | Yes (DB + Shopify stock push) |
| `restore-edited-addresses.js` | Restores verification-edited ship-to addresses and locks them (`--apply`). | Yes (DB) |
| `route-bosta-return-pickups.js` | Moves ready-to-ship Bosta return orders to returning + creates Bosta CRP (`--apply`). | Yes (DB + Bosta create) |
| `seed-factories.js` | Upserts default factories. | Yes (DB) |
| `seed-real-stock-from-shopify.js` | One-time: copies `onlineStock` into `realStock` where 0, with ledger rows (`DRY_RUN`). | Yes (DB) |
| `seed.js` | Admin user (default `changeme123`), Settings doc, Bosta status mappings, factories. | Yes (DB) |
| `setup-production.js` | Logs into prod API, tests Shopify, registers webhooks, syncs catalog + Bosta cities. | Yes (via API: Settings/catalog; Shopify webhook subscriptions) |
| `sync-all-stock-from-shopify.js` | Sets realStock = Shopify `inventoryQuantity` for all ACTIVE products, releases OOS (`DRY_RUN`). | Yes (DB + Shopify stock push) |
| `sync-live-data.js` | Syncs Bosta cities into Settings (header also claims demo orders; not implemented). | Yes (DB) |
| `sync-men-stock-from-shopify.js` | Same as sync-all, Men products only. | Yes (DB + Shopify stock push) |
| `sync-shopify-catalog.js` | Tests connection + runs `syncCatalog`. | Yes (DB, incl. stale deletes) |
| `sync-women-stock-from-shopify.js` | Same as sync-all, Women products only. | Yes (DB + Shopify stock push) |
| `test-all-roles.js` | E2E role/RBAC test via API; creates test users directly in DB; creates manual orders, intakes, transitions. | Yes (DB + API writes) |
| `test-apis.js` | API smoke test; seeds test product/variants/customer/orders in DB; posts unsigned Shopify/Bosta webhooks. | Yes (DB + API writes) |
| `test-extended-features.js` | Manufacturing/accounting/HR smoke test via API (creates/receives a PO). | Yes (API writes) |
| `test-page-apis.js` | GETs every frontend page endpoint after admin login. | No |
| `verify-redesign.js` | Role/stock redesign verification against live catalog; creates test users, manual orders, intakes/adjusts. | Yes (DB + API writes) |

---

## Issues spotted (integrations)

**Webhook authentication / signatures**
- `src/webhooks/bosta.router.js:11-29` — Bosta webhook has no signature, shared secret or IP check. Any POST that names a known tracking number, delivery id, or 24-hex order id (`tracking.service.js:124-151`) can drive order status (incl. `delivered` and the COD stamp at `tracking.service.js:347-360`).
- `src/webhooks/paymob.router.js:23-30` — Paymob HMAC is skipped (warning only) when `PAYMOB_HMAC_SECRET` is unset, and `render.yaml` does not declare that variable.
- `src/webhooks/verifyShopifyHmac.js:6-11` + `integrations/shopify/credentials.js:47` — only `SHOPIFY_WEBHOOK_SECRET`/Settings secret is tried. With the client-credentials app, Shopify signs app-registered webhooks with the app client secret, which is never used as a fallback. In production a mismatch rejects every webhook. In non-production a missing secret accepts everything.
- `src/webhooks/shopify.router.js:11` — if `rawBody` is missing, it falls back to `JSON.stringify(req.body)`. That cannot match Shopify's HMAC, so it always fails closed. Harmless today because `app.js:34-42` always sets `rawBody`.

**Idempotency / lost events**
- `src/utils/idempotency.js:9-27, 40-56` and `src/webhooks/paymob.router.js:40-60` — the receipt is inserted before work is queued or done. If `agenda.now` or `recordPaymobPayment` then throws, the provider's retry hits the unique index and gets "duplicate → 200", so the event is never processed. Paymob returns 500 first, but the retry is still swallowed.
- `src/webhooks/bosta.router.js:23-28` — returns 200 even when enqueue fails, so Bosta never retries. Only the 3/15-minute polling recovers.
- `src/integrations/bosta/webhookPayload.js:83-90` — dedupe key is `<id>-<stateCode>`. Repeated events with the same code (for example several `47` exceptions with different `exceptionCode`/attempts) are dropped as duplicates. A missing state uses `Date.now()`, so those events are never deduped.
- `src/webhooks/shopify.handlers.js:617-622` swallows `orders/*` failures (the job succeeds). Then `retryFailedShopifyOrderCreates` (`:627-651`) replays `orders/updated` receipts through `handleOrdersCreate`. For an existing order that function returns early (`:178-182`), so the receipt is marked processed and the update is silently discarded.
- `src/integrations/bosta/tracking.service.js:424-430` — transition errors are logged and swallowed, so the webhook receipt is marked processed with no retry. `:370` has an empty `catch (_) {}` around fee parsing.
- `src/integrations/bosta/shipments.service.js:709` — `POST /deliveries` has no idempotency key. `services/fulfillment.service.js:176-189` clears an existing link and recreates the shipment whenever `getDelivery` fails, including transient Bosta/network errors, so a duplicate AWB is possible.
- `src/integrations/shopify/mutations/inventorySet.js:51` — the idempotency key defaults to a random UUID per call, so retries are not idempotent. `mutations/inventoryAdjust.js:22-47` accepts `idempotencyKey` but never sends it (file is unused).
- `src/integrations/paymob/payments.service.js:24-42` — the webhook `isPaid` ignores `pending`/`is_voided`/`is_refunded`, which `transactions.service.js:119-127` does check. The two Paymob paths can disagree on what counts as a received payment.
- `src/integrations/shopify/webhooks.service.js:52-79` — re-running registration does not check existing subscriptions (the `listShopifyWebhooks` helper is unused). It relies on Shopify userErrors for duplicates.

**Policy / data-safety**
- `src/jobs/index.js:52-64` and `services/order.service.js:156,175` — every outbound stock push calls `enableShopifyInventorySync()`/`forcePolicyFull`. That flips `shopifyWritePolicy` to `full`, so the `oms_only` default and the 403 gate in `writePolicy.js:10-20` have no effect.
- `src/integrations/shopify/sync.service.js:90-103` — the hourly sync hard-deletes OMS products and variants missing from the Shopify query, including ARCHIVED products, because `queries/products.js:5` filters active/draft. It does not check open orders, ledger rows, or `realStock`.
- `scripts/sync-{all,men,women}-stock-from-shopify.js` write Shopify `inventoryQuantity` (all locations, `queries/products.js:46`) into warehouse `realStock`, and `setRealStockBatch` then pushes it back to Shopify (`order.service.js:1939`).
- `src/integrations/shopify/setup.service.js:235` — the 5-minute orders sync stamps `shopifyLastSyncAt`, the same field `server.js:22-26` uses to decide whether the catalog is stale. The boot-time catalog refresh therefore practically never runs.

**Duplicated logic (Shopify / Bosta paths)**
- Catalog upsert is implemented twice with different rules: `shopify.handlers.js:485-534` (`products/update`) versus `sync.service.js:30-87`.
  - Color/size: option1/option2 in the handler versus `parseVariantOptions` in the sync.
  - DRAFT status: stored as `draft` versus `active`.
  - Blank-SKU variants: deleted versus skipped.
  - The webhook path never sets `compareAtPrice`/`onlineStock`.
  - `storefrontCatalog.service.js:11-12` re-declares the option-name lists from `queries/products.js:60-61`.
- Shipping-address mapping exists three times: `shopify.handlers.js:432-444`, `syncOrderMoney.service.js:11-31`, `utils/shopifyShippingAddress.js:19-39`. They differ on trimming, billing fallback, and placeholders.
- Four near-identical order import loops: `setup.service.js:143-162, 214-231, 256-273, 302-318`.
- `isForeignBostaDelivery` exists in `tracking.service.js:18-30` and `orderStates.service.js:9-15`, plus an inline copy in `cod.service.js:57-66`. `returns.service.js:77-80, 171, 199` still matches by numeric `shopifyOrderId`, which `tracking.service.js:141-143` and `cod.service.js:71-72` explicitly forbid (WooCommerce id collision).
- `shipments.service.js:22-30` `isOrderPrepaidForBosta` duplicates `utils/omsCod.js:5-13` `isOrderPrepaid`. `returns.service.js:31-37` `normalizePhone` duplicates `utils/phone.js:9-14`.
- `shipments.service.js:559-606` versus `:890-922` duplicate the city/district resolution. `:826-843` and `:935-951` duplicate raw v0 `fetch` code that bypasses `bostaRequest`.
- `scripts/seed.js:35-39` seeds DB mappings 46/48/60/103 → `returning_to_origin`, while `states.js:65-70` maps them to `returned_awaiting_receipt`. `mapBostaStateToInternal` (`tracking.service.js:93-117`) prefers the DB row when no `type` is present, so the result depends on payload shape.

**Load / retries**
- No retry or 429 handling in `bosta/client.js:10-58` or `shopify/client.js:124-160` (REST); only GraphQL THROTTLED is retried.
- Polling volume is high:
  - `bosta-order-states-sync` makes up to 200 `getDelivery` calls every 3 min (`orderStates.service.js:222-251`).
  - `bosta-polling-fallback` overlaps it.
  - Returns sync pages up to 60×2 + 20 searches every 30 min (`returns.service.js:138-152`).
  - `shopify-orders-sync` re-paginates 14 days of orders every 5 min (`jobs/index.js:142-143`). Each pickup order triggers a GraphQL check in `zeroShopifyShippingForPickup` (`shopify.handlers.js:464-476`), and placeholder addresses trigger GraphQL enrichment.
- `render.yaml:11, 43-47` — the free plan sleeps nights and Fridays, so recurring jobs stop and Shopify/Bosta webhooks hit a cold start.

**Hard-coded values**
- Shopify pickup carrier id `orderMoney.js:8`.
- Default storefront domain `storefrontCatalog.service.js:8`.
- API version clamp `credentials.js:5, 30-37`: any newer `SHOPIFY_API_VERSION` is silently replaced with 2026-07.
- City and area alias tables `shipments.service.js:244-281, 317-363`.
- Pickup city `Cairo` and `process.env.BOSTA_PICKUP_CITY` outside the config schema, `pricing.service.js:272`.
- `EGP` in `zeroPickupShipping.service.js:78`.
- 14-day window `jobs/index.js:142`.
- Cron `0 5 * * *` labelled "~08:00 Cairo" (`jobs/index.js:190-191`) is 07:00 in winter and 08:00 in summer.
- Render URL in `morning-wake.yml:18`, `setup-production.js:12`.
- Desktop paths in `import-real-stock-excel.js:15`, `export-shopify-size37-customers.js:14-17`.
- `shippingEconomics.js:32` uses `setUTCHours` but `:234` uses local `setHours` for the same end-of-day.

**Dead code**
- Never enqueued: `bosta-create-shipment` job (`jobs/index.js:109-113`).
- No callers: `applyPaymentIncentives.service.js`, `mutations/inventoryAdjust.js`, `listShopifyWebhooks`, `sumDeliveredCod`, `excelExport.addSheetFromRows`.
- Unused config: `PAYMOB_PUBLIC_KEY`, `PAYMOB_SECRET_KEY`.
- Only used by tests: `planPaymentIncentives`, `incentivesNeedShopifyEdit`, `orderHasOnlineDiscount`, `isOnlineFiveDiscount`.

**Secrets / PII**
- `credentials.js:44-47, 100-104` — Shopify access token, client secret and webhook secret are read from and written to the `Settings` document in plaintext.
- `models/WebhookReceipt.js` stores full Shopify, Bosta and Paymob payloads (names, phones, addresses) with no TTL index.
- Default admin password `changeme123`: `scripts/seed.js:46`, `setup-production.js:14`, `test-page-apis.js:11`.
- Test scripts create `@test.local` users with password `testpass123` directly in whatever DB `MONGODB_URI` points to (`test-all-roles.js:65`, `test-apis.js:70-132`, `verify-redesign.js:61-63`).
- `export-shopify-size37-customers.js` writes customer PII to the Desktop.

**One-off scripts that should be removed or archived**
- Tied to a specific date or file: `purge-dummy-pos-users.js`, `repair-missed-exchange-collect.js` (cutoff 2026-07-20), `restore-edited-addresses.js`, `migrate-local-shipping-status.js`, `import-real-stock-excel.js`, `seed-real-stock-from-shopify.js`, `backfill-lifetime-cancelled.js`, `route-bosta-return-pickups.js` (creates Bosta CRPs with `--apply`).
- `sync-{men,women,all}-stock-from-shopify.js` are about 95% identical and should be one parameterised script.
- `sync-live-data.js`'s header describes behaviour (demo orders) it does not have.
