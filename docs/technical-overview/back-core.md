# Gazelle backend — core (server, app, config, constants, middleware, models, routes, controllers)

Repo: `Gazelle-back` (Node 20, Express 4, Mongoose 8, Agenda 5, ESM). Files covered: 69 (2 entry, 3 config, 3 constants, 4 middleware, 26 models, 16 routes, 15 controllers). The 3 webhook routers mounted in `app.js` (`src/webhooks/*.router.js`) were also read for the endpoint list.

Conventions seen in all controllers: `async (req, res, next)` with `try { … } catch (err) { next(err) }`; responses are `{ data }` (sometimes `{ data, warning }` or raw service result such as `{ orders, total }`); errors thrown with `err.statusCode` are rendered by `errorHandler`.

---

## Backend core: function-by-function

### src/server.js
| Name | What it does | Inputs → Outputs | Calls / depends on |
|---|---|---|---|
| `ensureCatalogLoaded()` (internal) | Boot-time data bootstrap: re-sync Shopify catalog if empty or >6h stale, import orders on first boot, seed chart of accounts + brand expenses, fire-and-forget Bosta returns sync. Swallows errors (warn). | – → Promise<void> | `Product.countDocuments`, `Settings.findOne`, `syncCatalog`, `ensureOrdersLoaded`, `ensureChartOfAccounts`, `ensureBrandExpenses`, `syncBostaReturns({maxPages:40})` |
| `startServer()` (internal) | Connect DB, create/start Agenda + recurring schedules, kick `ensureCatalogLoaded` (not awaited), listen on `0.0.0.0:PORT`, start keep-awake pinger, install SIGTERM/SIGINT graceful shutdown and global `unhandledRejection`/`uncaughtException` loggers. | – → Promise<void> | `connectDatabase`, `createAgenda`, `registerJobs`, `scheduleRecurringJobs`, `createApp`, `startKeepAwake`, `disconnectDatabase` |
| `shutdown(signal)` (closure) | Idempotent: `server.close` → `agenda.stop` → `disconnectDatabase` → `process.exit(0)`. | signal → exit | Agenda, mongoose |
| top-level | `startServer().catch` → log + `exit(1)`. | | |

### src/app.js
| Name | What it does | Inputs → Outputs | Calls / depends on |
|---|---|---|---|
| `corsOptions()` (internal) | Builds CORS options from comma-separated `CORS_ORIGIN`; empty → `{}` (allow any origin). | config → cors options | `config.CORS_ORIGIN` |
| `createApp()` (export + default) | Builds Express app: `trust proxy 1`, helmet, cors, pino-http; `/webhooks/shopify` (JSON with `req.rawBody` capture), `/webhooks/bosta`, `/webhooks/paymob`; global `express.json()`; `/api/v1` routes; `GET /` info; 404 + error handlers. | – → Express app | `routes/index.js`, webhook routers, `errorHandler`, `notFoundHandler` |

### src/config/agenda.js
| Name | What it does | Inputs → Outputs | Calls / depends on |
|---|---|---|---|
| `createAgenda()` | Singleton Agenda on `MONGODB_URI`, collection `agendaJobs`, processEvery 30s, maxConcurrency 10, default 5. | – → Agenda | `agenda`, `config` |
| `getAgenda()` | Returns singleton or throws if not created. | – → Agenda | – |

### src/config/database.js
| Name | What it does | Inputs → Outputs | Calls / depends on |
|---|---|---|---|
| `bindConnectionListeners()` (internal) | One-time logging of connected/disconnected/reconnected/error events. | – → void | `mongoose.connection`, logger |
| `connectDatabase()` | `strictQuery`, connect with pool (min/max from env), 10s server selection, 45s socket, 60s idle, retryWrites/Reads. | – → Promise | mongoose, config |
| `disconnectDatabase()` | `mongoose.disconnect()` + log. | – → Promise | mongoose |

### src/config/index.js
| Name | What it does | Inputs → Outputs | Calls / depends on |
|---|---|---|---|
| `envSchema` (internal) | Zod schema for env: `NODE_ENV` (default development), `PORT` 4000, `MONGODB_URI` (req), pool sizes, `JWT_SECRET` (min 16), `JWT_EXPIRES_IN` 7d, Shopify (domain/token/client id+secret/webhook secret/api version 2026-07/location), Bosta key+base URL, Paymob keys + HMAC, `APP_URL`, `CORS_ORIGIN`, `USD_TO_EGP` 50, `KEEP_AWAKE*`. | `process.env` → parsed | dotenv, zod |
| `config` (export) | Parsed env; process exits(1) on validation failure. | – → object | – |

### src/constants/index.js
| Name | What it does | Inputs → Outputs | Calls / depends on |
|---|---|---|---|
| `USER_ROLES` | `admin`, `orders_manager`, `stock_manager`. | const | User, Notification |
| `ORDER_STATUSES` / `TERMINAL_ORDER_STATUSES` | 21 order statuses (pending_verification … cancelled); terminal = returned_to_stock, cancelled. | const | Order, OrderStatusHistory, BostaStatusMapping |
| `REFUND_PAYMENT_METHODS` | instapay, vodafone_cash, bank_transfer, cash, other. | const | (Order re-declares inline) |
| `LEDGER_TYPES` | on_hold_reserve/release, real_stock_decrement, real_stock_increment_manual/_return, online_stock_increment_api. | const | InventoryLedger |
| `STATUS_SOURCES`, `RISK_FLAGS`, `CANCELLATION_REASONS`, `VERIFICATION_OUTCOMES`, `SHOPIFY_SYNC_STATUSES`, `ORDER_SOURCES`, `MANUAL_ORDER_SOURCES`, `SHIPPING_METHODS` | Enum lists. | const | models |
| `LOCAL_SHIPPING_FEE`, `DEFAULT_BOSTA_SHIPPING_FEE` | Both 95 EGP. | const | orders.controller |
| `ORDERS_PLACED_FROM_YMD` | OMS cutover day `2026-07-20` for queues. | const | services |
| `JOB_NAMES` | 15 Agenda job names. | const | settings.controller, jobs |
| `PO_STATUSES`, `OPEN_PO_STATUSES`, `FACTORY_AVG_LEAD_TIME_MIN_SAMPLES`, `DEFAULT_FACTORIES` | Manufacturing enums/defaults (5 factories). | const | PurchaseOrder, services |
| `GL_CATEGORIES`, `JOURNAL_SOURCES`, `LEAVE_TYPES`, `LEAVE_STATUSES`, `ATTENDANCE_STATUSES`, `SALARY_TYPES`, `HR_DEPARTMENTS` | Accounting/HR enums. | const | models |

### src/constants/shippingZones.js
| Name | What it does | Inputs → Outputs | Calls / depends on |
|---|---|---|---|
| `SHOPIFY_FREE_SHIPPING_MIN` | 2999 EGP free-shipping threshold. | const | – |
| `compactPlace(value)` | NFKD normalize, strip diacritics, lowercase, keep `[a-z0-9]` + Arabic. | string → string | – |
| `SHOPIFY_SHIPPING_ZONES` | 5 zones (`cairo-50` 95/bosta 50 … `zone5-100` 195/bosta 110, no free) with EN/AR place tokens. | const | – |
| `PLACE_TO_ZONE` (internal) | Map compacted place → zone. | – | `compactPlace` |
| `findShopifyShippingZone(city)` | Exact match, then fuzzy substring (tokens ≥4 chars). | city → zone \| null | `PLACE_TO_ZONE` |
| `resolveShopifyZoneShippingFee(city, goodsTotal)` | Customer shipping fee by zone; free over `freeOver`; unknown city → 95 (hard-coded). | (city, number) → `{fee, zone, free}` | `findShopifyShippingZone` |
| `DEFAULT_BOSTA_COURIER_FEE` | 50. | const | – |
| `resolveBostaCourierFee(orderOrCity)` | What Bosta bills Gazelle; 0 for pickup/local_shipping. | order \| city → number | `findShopifyShippingZone` |

### src/constants/shippingZones.test.js
| Name | What it does | Inputs → Outputs | Calls / depends on |
|---|---|---|---|
| `describe('Bosta courier fee …')` | 3 `node:test` cases: Cairo/Giza = 50, pickup/local = 0, unknown → default. | – | `resolveBostaCourierFee` |

### src/middleware/auth.js
| Name | What it does | Inputs → Outputs | Calls / depends on |
|---|---|---|---|
| `authenticate` | Requires `Authorization: Bearer <jwt>`; verifies with `JWT_SECRET`; loads `User` by `sub` (no passwordHash); rejects inactive; sets `req.user`. 401 otherwise. | req → `req.user` / 401 | `jsonwebtoken`, `User` |
| `optionalAuth` | Runs `authenticate` only if a Bearer header is present. **Unused.** | req → next | `authenticate` |

### src/middleware/errorHandler.js
| Name | What it does | Inputs → Outputs | Calls / depends on |
|---|---|---|---|
| `errorHandler` | Status = `err.statusCode \|\| err.status \|\| 500`; logs ≥500; JSON `{error, stack?}` (stack unless `process.env.NODE_ENV === 'production'`). | err → JSON | logger |
| `notFoundHandler` | 404 `{error: 'Route not found: METHOD path'}`. | req → 404 | – |

### src/middleware/rbac.js
| Name | What it does | Inputs → Outputs | Calls / depends on |
|---|---|---|---|
| `requireRoles(...roles)` | 401 if no `req.user`, 403 if role not in list. | roles → middleware | – |
| `adminOnly` | `requireRoles('admin')`. | middleware | `requireRoles` |
| `stripFinancialFields(obj, role)` | Non-admin: deletes `cogs`, `unitCogs`, `totalCogsSnapshot` at top level and in `items[]` (recursive for arrays). | (obj, role) → plain obj | – |
| `sanitizeFinancialResponse` | Non-admin: monkey-patches `res.json` to strip financial fields from `body.data` (or the whole body if no `data`). | middleware | `stripFinancialFields` |

### src/middleware/validate.js
| Name | What it does | Inputs → Outputs | Calls / depends on |
|---|---|---|---|
| `validate(schema)` | Zod `safeParse({body,query,params})` → 400 with flattened errors, else `req.validated`. **Not used by any route.** | schema → middleware | zod schema |

### src/models/*.js
Each model file only defines a schema + indexes and exports `mongoose.model(...)` (details in **Data models**). Non-trivial extras:

| Name | What it does | Inputs → Outputs | Calls / depends on |
|---|---|---|---|
| `Order.js` → `orderSchema` (named export) | Shared schema reused by `ReportOrder`. | – | constants |
| `Order.js` `items.required()` / `hasItems` validator | Items required unless `isRepairOrder`. | – | – |
| `Order.js` `shippingAddress.required()` | Address required unless `shippingMethod === 'pickup'`. | – | – |
| `ReportOrder.js` `NOT_REPAIR_ORDER` (export) | `{ isRepairOrder: {$ne: true} }`. | const | – |
| `ReportOrder.js` pre hooks `excludeRepair` | On find/findOne/countDocuments/distinct adds `NOT_REPAIR_ORDER`; on aggregate unshifts `$match`. Model bound to `orders` collection, `autoIndex:false`. | query → filtered | `orderSchema.clone()` |
| `Notification.js` `NOTIFICATION_TYPES`, `NOTIFICATION_SEVERITIES` (exports) | Enums for notifications. | const | – |
| `models/index.js` | Barrel re-export of 21 models (omits Notification, BostaReturn, PaymobReceived, ReportOrder). | – | – |

### src/routes/index.js
| Name | What it does | Inputs → Outputs | Calls / depends on |
|---|---|---|---|
| default `router` | Mounts 16 sub-routers under `/api/v1` (auth, orders, inventory, customers, products, reports, users, settings, fulfillment, reference, integrations/shopify, integrations, notifications, manufacturing, accounting, hr). | – | route files |
| `GET /health` inline | `{status:'ok', timestamp}`; no auth. | – → JSON | – |

### src/routes/*.routes.js (other 15 files)
Pure wiring of `authenticate` / `requireRoles` / `adminOnly` / `sanitizeFinancialResponse` to controller handlers (see **API endpoints**). Exception with inline logic:

| Name | What it does | Inputs → Outputs | Calls / depends on |
|---|---|---|---|
| `reference.routes.js` `GET /bosta-cities` inline | If Bosta not configured → `{data:[],configured:false}`; else cities from DB, fallback live fetch. | – → `{data, configured, count}` | `isBostaConfigured`, `getBostaCitiesFromDb`, `fetchBostaCities` |
| `reference.routes.js` `GET /bosta-cities/:cityId/districts` inline | Live Bosta districts for a city. | cityId → `{data, configured, count}` | `fetchBostaDistricts` |
| `reference.routes.js` `POST /bosta-cities/sync` inline | Force refresh cities from Bosta. | – → `{data, count, synced}` | `fetchBostaCities({force:true})` |

### src/controllers/accounting.controller.js
| Name | What it does | Inputs → Outputs | Calls / depends on |
|---|---|---|---|
| `listAccounts` | List GL accounts, optional category. | `query.category` → `{data}` | `accountingService.listAccounts` |
| `createAccount` | Create GL account from raw body. | body → 201 `{data}` | `accountingService.createAccount` |
| `updateAccount` | Update GL account. | `:id`, body → `{data}` | `accountingService.updateAccount` |
| `listJournal` | Paged journal entries by date range. | from,to,limit,skip → result | `listJournalEntries` |
| `createJournal` | Manual journal entry (body + createdBy). | body → 201 `{data}` | `createJournalEntry` |
| `profitAndLoss` | P&L report. | from,to → `{data}` | `getProfitAndLoss` |
| `listBrandExpenses` | List brand expenses by kind. | `query.kind` → `{data}` | `brandExpense.service.listBrandExpenses` (dynamic import) |
| `createBrandExpense` / `updateBrandExpense` / `deleteBrandExpense` | CRUD brand expenses (raw body). | body / `:id` → `{data}` | `brandExpense.service` |
| `getMonthExpenses` | Month breakdown; 400 if no month. | `query.month` → `{data}` | `getMonthExpenseBreakdown` |
| `saveMonthExpenses` | Save month actuals. | `body.month`, `body.items` → `{data}` | `brandExpense.service.saveMonthExpenses` |
| `balanceSheet` | Balance sheet. | – → `{data}` | `getBalanceSheet` |
| `topProducts` | Top products (days default 30, limit 50). | from,to,days,limit → `{data}` | `getTopProducts` |
| `cogsHealth` | COGS health (limit default 200). | limit → `{data}` | `getCogsHealth` |
| `exportPl` / `exportTopProducts` / `exportCogsHealth` / `exportBrandExpenses` | Excel downloads. | query → xlsx | `excelReports.*`, `sendExcel` |

### src/controllers/auth.controller.js
| Name | What it does | Inputs → Outputs | Calls / depends on |
|---|---|---|---|
| `login` | Email/password login → JWT. | `{email,password}` → `{token,user}` | `authService.login` |
| `me` | Current user profile (no try/catch, synchronous). | `req.user` → `{user:{id,name,email,role}}` | – |

### src/controllers/customers.controller.js
| Name | What it does | Inputs → Outputs | Calls / depends on |
|---|---|---|---|
| `listCustomers` | Paged/filtered customers (raw query). | query → result | `customerService.listCustomers` |
| `filterOptions` | Filter dropdown values. | – → `{data}` | `getCustomerFilterOptions` |
| `exportCustomers` | Excel export. | query → xlsx | `exportCustomersExcel`, `sendExcel` |
| `lookupByPhone` | Find customer by phone (`phone` or `q`). | query → `{data \| null}` | `findCustomerByPhone` |
| `getCustomer` | Customer by id. | `:id` → `{data}` | `getCustomerById` |
| `getCustomerOrders` | Customer's orders. | `:id` → `{data}` | `getCustomerShopifyOrders` |
| `updateRiskFlag` | Set risk flag. | `:id`, `body.riskFlag` → `{data}` | `updateCustomerRiskFlag` |

### src/controllers/fulfillment.controller.js
| Name | What it does | Inputs → Outputs | Calls / depends on |
|---|---|---|---|
| `getWarehouseReview` / `exportWarehouseReview` | Warehouse backlog (JSON / Excel). | from,to → `{data}` / xlsx | `warehouseReviewService` |
| `getStockIntakes` / `exportStockIntakes` | Stock intake log (JSON / Excel). | from,to,search,limit,skip | `warehouseReviewService` |
| `exportCurrentStock` | Current stock Excel. | – → xlsx | `exportCurrentStockExcel` |
| `getPickList` | Orders to pick. | – → `{data}` | `fulfillmentService.getPickList` |
| `pickAndPack` | Pick & pack an order (stock move + Bosta). | `:id` → result | `pickAndPackOrder` |
| `prepareAwb` | Create/print AWB; orders_manager only for return orders (403 otherwise). | `:id` → `{data}` | `Order.findById`, `prepareAwbForOrder` |
| `getAwb` | Fetch AWB. | `:id` → `{data}` | `getAwbForOrder` |
| `getShipmentStatus` | Bosta shipment status. | `:id` → `{data}` | `getShipmentStatus` |
| `checkStock` | Stock warnings for an order; 404 if missing. | `:id` → `{data:{warnings}}` | `Order.findById`, `checkStockAvailability` |
| `getOrderSheet` | Printable order sheet. | `:id` → `{data}` | `buildOrderSheet` |
| `markOutOfStock` | Mark order (or lines) OOS. | `:id`, `{note, lines}` → `{data}` | `markOrderOutOfStock` |

### src/controllers/hr.controller.js
| Name | What it does | Inputs → Outputs | Calls / depends on |
|---|---|---|---|
| `listEmployees` | Employees (activeOnly default true). | query → `{data}` | `hrService.listEmployees` |
| `getEmployee` | Profile + KPIs for range. | `:id`, from,to → `{data}` | `getEmployeeProfileWithKpis` |
| `createEmployee` / `updateEmployee` | Create/update from raw body. | body → `{data}` | `hrService` |
| `listAttendance` | Attendance for employee. | `:id`, query → `{data}` | `hrService.listAttendance` |
| `recordAttendance` | Record attendance (`...body` + recordedBy). | `:id`, body → `{data}` | `hrService.recordAttendance` |
| `getKpis` | KPIs for the employee's linked user. | `:id`, from,to → `{data}` | `hrService.getEmployee`, `kpi.service.getEmployeeKpis` |
| `listLeaveRequests` | Paged leave requests. | status, employeeId, limit, skip | `hrService.listLeaveRequests` |
| `createLeaveRequest` | Create leave request (raw body). | body → 201 | `hrService.createLeaveRequest` |
| `reviewLeaveRequest` | Approve/reject. | `:id`, `body.status` → `{data}` | `hrService.reviewLeaveRequest` |
| `payrollSummary` | Payroll for month. | `query.month` → `{data}` | `hrService.getPayrollSummary` |

### src/controllers/integrations.controller.js
| Name | What it does | Inputs → Outputs | Calls / depends on |
|---|---|---|---|
| `getHealth` | Integration health (Shopify/Bosta/etc.). | – → `{data}` | `integrationHealth.service.getIntegrationHealth` |

### src/controllers/inventory.controller.js
| Name | What it does | Inputs → Outputs | Calls / depends on |
|---|---|---|---|
| `listVariants` | Paged variants, search, lowStock. | query → `{variants,total}` | `productService.listVariants` |
| `getVariant` | Variant by id. | `:id` → `{data}` | `getVariantById` |
| `adjustStock` | Manual stock delta with reason. | `:id`, `{quantityDelta, reasonCode}` → `{data}` | `orderService.manualStockAdjustment` |
| `stockIntake` | Single intake. | `{variantId, quantity, reasonCode, note}` → `{data}` | `orderService.stockIntake` |
| `lookupVariantBySku` | SKU/barcode lookup; 404 if none. | `query.sku` → `{data}` | `findVariantBySku` |
| `lookupVariantFamilyBySku` | Sibling sizes (sameColor default true). | sku, sameColor → `{data}` | `findVariantFamilyBySku` |
| `stockIntakeBatch` | Batch intake. | `{items, reasonCode}` → `{data}` | `orderService.stockIntakeBatch` |
| `stockSetBatch` | Set absolute realStock for many variants (reason default `stock_count`). | `{items, reasonCode}` → `{data}` | `orderService.setRealStockBatch` |
| `importRealStockExcel` | Excel → realStock import (needs `req.file`). **Not routed.** | file → `{data}` | `stockImport.service` |
| `getLedger` | Variant ledger. | `:id`, query → result | `getVariantLedger` |
| `listDiscrepancies` | Unresolved alerts. | query → result | `discrepancy.service.listUnresolvedAlerts` |
| `listOnHoldItems` | On-hold pieces (limit 500). | search, limit → result | `inventory.service.listOnHoldItems` |
| `getQueueCounts` | Stock queue badge counts. | – → `{data}` | `getStockQueueCounts` |
| `listCatalog` | Paged catalog with filters + Shopify mode flags. | query → `{…, shopifyCatalogMode, shopifyConfigured}` | `productService.listCatalog`, `Settings` |
| `catalogFilters` | Catalog filter options. | status → `{data}` | `getCatalogFilterOptions` |
| `exportCatalogStock` / `exportInventoryCount` / `exportOutOfStockPieces` | Excel exports. | body.productIds / – → xlsx | `productService.*Excel`, `sendExcel` |
| `getVariantBarcodePng` | Barcode PNG. | `:id` → image/png | `barcodeService.getVariantBarcodePng` |
| `getVariantBarcodeLabels` | Printable label HTML. | `:id`, copies → text/html | `buildBarcodeLabelHtml` |
| `getBarcodeLabelsBatch` | Batch label HTML. | `body.items` → text/html | `buildBarcodeLabelsBatchHtml` |

### src/controllers/manufacturing.controller.js
| Name | What it does | Inputs → Outputs | Calls / depends on |
|---|---|---|---|
| `listFactories` / `createFactory` / `updateFactory` / `deleteFactory` | Factory CRUD (raw body). | query/body/`:id` → `{data}` | `manufacturingService` |
| `listOrderableProducts` | Products orderable from factories. | q, factoryId, includeUnlinked, limit → `{data}` | `listOrderableProducts` |
| `assignProductFactory` | Set product default factory. | `:productId`, `body.factoryId` → `{data}` | `assignProductFactory` |
| `listPurchaseOrders` | Paged POs. | status, factoryId, limit, skip → result | `listPurchaseOrders` |
| `getPurchaseOrder` | PO by id; 404. | `:id` → `{data}` | `getPurchaseOrder` |
| `createPurchaseOrder` | Create PO (`...body` + createdBy). | body → 201 | `createPurchaseOrder` |
| `updatePurchaseOrder` | Update PO (raw body). | `:id`, body → `{data}` | `updatePurchaseOrder` |
| `receivePurchaseOrder` | Receive PO (stock + COGS). | `:id` → `{data}` | `receivePurchaseOrder` |
| `exportPurchaseOrder` | PO Excel (sets headers manually, not `sendExcel`). | `:id` → xlsx | `exportPurchaseOrderExcel` |

### src/controllers/notification.controller.js
| Name | What it does | Inputs → Outputs | Calls / depends on |
|---|---|---|---|
| `list` | Notifications for user's role + unread count. | unreadOnly, limit → `{data:{items,unread}}` | `notificationService.listForUser`, `unreadCount` |
| `unreadCount` | Unread count. | – → `{data:{unread}}` | `notificationService.unreadCount` |
| `markRead` | Mark one read. | `:id` → `{data:{unread}}` | `notificationService.markRead` |
| `markAllRead` | Mark all read. | – → `{data:{unread:0}}` | `notificationService.markAllRead` |

### src/controllers/orders.controller.js
| Name | What it does | Inputs → Outputs | Calls / depends on |
|---|---|---|---|
| `STOCK_MANAGER_ORDER_STATUSES` (internal) | Statuses a stock manager may list. | const | – |
| `clampStatusFilterForRole(role, status)` (internal) | For stock_manager, intersects requested statuses with the allowed set (default all allowed). | (role, csv) → csv | – |
| `listOrders` | Filtered/paged order list (sort by `delayedUntil` when `delayed`), enriched money fields. | query → `{orders,total}` | `orderService.listOrders`, `omsCod.enrichOrderMoneyFields` |
| `getStateCounts` | Per-status counts. | – → `{data}` | `getOrderStateCounts` |
| `createManualOrder` | Manual order (`...body` + actor). | body → 201 `{data}` | `orderService.createManualOrder` |
| `createRepairOrder` | Repair order. | body → 201 `{data}` | `repairOrder.service.createRepairOrder` |
| `findExchangeOrder` | Look up order for exchange + suggested fee. | `q`/`search` → `{data, suggestedShippingFee}` | `findOrderForExchange`, `suggestShippingFeeByCity` |
| `suggestShippingFee` | Fee by city + goods total. | city, goodsTotal/subtotal → `{data}` | `suggestShippingFeeByCity` |
| `getOrder` | Order detail with money + Bosta fee fields; 404. | `:id` → `{data}` | `getOrderById`, `enrichOrderMoneyFields`, `enrichBostaFeeFields` |
| `verifyOrder` | Verification outcome. | `:id`, body → `{data}` | `orderService.verifyOrder` |
| `bulkVerifyOrders` | Verify many. | `{orderIds,outcome,note,shippingMethod}` → `{data}` | `bulkVerifyOrders` |
| `cancelOrder` | Cancel; surfaces Shopify-cancel warning. | `:id`, body → `{data, warning?}` | `orderService.cancelOrder` |
| `confirmReturn` | Warehouse confirms return; validates optional `returnReason` (400). | `:id`, `{returnReason, returnReasonNote, note}` → `{data}` | `confirmReturnedToStock` |
| `confirmRefundPaid` | Admin confirms refund payout. | `:id`, `{paid,amount,paymentMethod,reference,note}` → `{data}` | `orderService.confirmRefundPaid` |
| `getStatusHistory` | Status history. | `:id` → `{data}` | `getOrderStatusHistory` |
| `claimOrder` | Assign order to current user; 409 if taken. | `:id` → `{data}` | `orderService.claimOrder` |
| `exchangeItem` / `removeItem` / `addItem` | Line edits. | `:id`, body → `{data}` | `exchangeService.processExchange/removeOrderItem/addOrderItem` |
| `updateShippingAddress` | ~170-line inline workflow: status guard, shipping-method/fee rules (local 95, pickup 0, Bosta zone fee, repair 0), address merge, lock + verification log, customer name/phone update, Shopify pickup zero-shipping, Bosta AWB update, Bosta return routing. | `:id`, `{shippingMethod,line1,line2,city,zone,phone,fullName}` → `{data, warning?, bostaUpdated?, movedToBostaReturns?}` | `Order`, `Customer`, `suggestShippingFeeByCity`, `zeroShopifyShippingForPickup`, `updateDeliveryAddressAndCod`, `routeBostaReturnPickup` |
| `transitionStatus` | Generic status transition; stock_manager limited to → ready/repaired from awaiting_bosta_pickup/out_of_stock/local_shipping. | `:id`, `{toStatus,note}` → `{data}` | `Order.findById`, `transitionOrderStatus` |
| `delayOrder` | Schedule callback date. | `:id`, body → `{data}` | `orderService.delayOrder` |
| `applyDiscount` | % discount on merchandise. | `:id`, body → `{data}` | `applyOrderDiscount` |
| `partialLocalDelivery` | Partial local delivery + summary. | `:id`, body → `{data}` | `orderService.partialLocalDelivery` |
| `returnLocalShippingToStock` / `returnPickupToStock` | Bring back local / pickup orders to stock. | `:id`, body → `{data}` | `orderService.*` |
| `exportPendingRefunds` | Pending refunds Excel. | – → xlsx | `exportPendingRefundsExcel`, `sendExcel` |

### src/controllers/products.controller.js
| Name | What it does | Inputs → Outputs | Calls / depends on |
|---|---|---|---|
| `listProducts` | Active products (raw `req.query` → limit/skip). | query → `{products,total}` | `productService.listProducts` |
| `updateCogs` | Set variant COGS. | `:variantId`, `body.cogs` → `{data}` | `updateVariantCogs` |
| `addCogsBatch` | Add COGS batch (`...body`). | `:variantId`, body → `{data}` | `productService.addCogsBatch` |
| `cogsHealth` | Same as accounting `cogsHealth` but limit default 2000. | limit → `{data}` | `accountingService.getCogsHealth` |
| `exportCogsHealth` | Excel. | query → xlsx | `excelReports.exportCogsHealthExcel` |

### src/controllers/reports.controller.js
| Name | What it does | Inputs → Outputs | Calls / depends on |
|---|---|---|---|
| `dashboard` / `dashboardSummary` / `dashboardCore` / `dashboardMoney` / `dashboardDetails` | Dashboard stat variants (raw query). | query → `{data}` | `reportsService.getDashboard*` |
| `profitability` | Product profitability + totals/insights. | query → `{data, totals, insights, from, to}` | `getProfitabilityReport` |
| `auditLog` | Audit log. | query → `{data}` | `getAuditLog` |
| `exportProfitability` / `exportAuditLog` | Excel exports. | query → xlsx | `excelReports.*` |
| `topSellers` | Top sellers by units for a month. | month, limit → `{data}` | `getTopSellersByUnits` |

### src/controllers/settings.controller.js
| Name | What it does | Inputs → Outputs | Calls / depends on |
|---|---|---|---|
| `sanitizeSettings(settings)` (internal) | Adds masked copies of Shopify secrets; removes accessToken, webhookSecret, clientSecret (clientId kept raw). | doc → plain | `maskSecret` |
| `getSettings` | Global settings + active Bosta mappings; refreshes Bosta cities if missing/unhealthy. | – → `{data:{settings, bostaStatusMappings}}` | `Settings`, `BostaStatusMapping`, `fetchBostaCities` |
| `updateSettings` | Upsert 5 whitelisted fields. | body → `{data}` | `Settings.findOneAndUpdate` |
| `upsertBostaMapping` | Upsert Bosta state → internal status. | `{bostaState, internalStatus, description}` → `{data}` | `BostaStatusMapping.findOneAndUpdate` |
| `forceShopifySync` | Queue catalog sync job. | – → `{queued}` | `getAgenda().now(SHOPIFY_CATALOG_SYNC)` |
| `forceBostaStatesSync` | With `since`: synchronous backfill + returns sync; else queue job + quick 120-order sync. | `{since,from,to,endDate}` → `{data}` / `{queued, job, quick}` | `backfillBostaSince`, `syncBostaReturns`, `syncOrderStatesFromBosta`, Agenda |

### src/controllers/shopify.controller.js
| Name | What it does | Inputs → Outputs | Calls / depends on |
|---|---|---|---|
| `getStatus` | Shopify connection status. | – → `{data}` | `getShopifyStatus` |
| `connect` | Save Shopify creds (static token or client-credentials mode) into Settings, reset client, test. | `{shopDomain, accessToken, clientId, clientSecret, webhookSecret, locationId, apiVersion}` → `{data:{connected, shop, locations}}` | `Settings`, `normalizeShopDomain`, `resetShopifyClient`, `testShopifyConnection` |
| `testConnection` | Test connection. | – → `{data}` | `testShopifyConnection` |
| `importOrders` | Import orders: `all` / `since`/`days` / `openOnly` / `orderLimit` / default 100 recent (synchronous). | body → `{data:{orders}}` | `setup.service.import*` |
| `importCustomers` | Background customer import (202) or synchronous with `wait:true`. | `{wait, maxItems}` → state | `startCustomerImportInBackground`, `importAllShopifyCustomers` |
| `importCustomersStatus` | Import progress. | – → `{data}` | `getCustomerImportState` |
| `syncCatalog` | Full sync w/ orders, sync wait, or background (202). | `{importOrders, orderLimit, wait}` → `{data}` | `fullShopifySync`, `syncCatalog`, `startCatalogSyncInBackground` |
| `syncStatus` | Catalog sync state. | – → `{data}` | `getCatalogSyncState` |
| `registerWebhooks` | Register Shopify webhooks. | – → `{data}` | `registerShopifyWebhooks` |
| `pushWarehouseStock` | Push warehouse stock to Shopify (dryRun via body/query). | dryRun → `{data}` | `pushWarehouseStockToShopify` |
| `getLocations` | Shopify locations (via test call). | – → `{data}` | `testShopifyConnection` |

### src/controllers/users.controller.js
| Name | What it does | Inputs → Outputs | Calls / depends on |
|---|---|---|---|
| `listUsers` | All users (no passwordHash). | – → `{data}` | `authService.listUsers` |
| `createUser` | Create user (bcrypt 12). | `{name,email,password,role}` → 201 `{data:{id,name,email,role}}` | `authService.createUser` |
| `deactivateUser` | Set `isActive:false`. | `:id` → `{data}` | `authService.deactivateUser` |

---

## Data models

Collections are Mongoose default pluralizations unless noted. `ts` = `timestamps`.

### User (`users`)
Staff accounts. `name` (≤120), `email` (unique, lowercased), `passwordHash`, `role` enum USER_ROLES (`admin|orders_manager|stock_manager`), `isActive` (default true), `lastLoginAt`. ts: createdAt only.

### Customer (`customers`)
End customers (Shopify + manual). `fullName`, `phone` (indexed, **not unique**), `email`, `gender` enum male/female/unknown, `shopifyCustomerId` (unique sparse), `riskFlag` enum none/watch/high_risk/vip, counters `lifetimeOrders/Delivered/RejectedOrReturned/Cancelled`, `addresses[]` {label, line1*, line2, city*, zone, isDefault}. Index `{phone, fullName}`.

### Product (`products`)
Shopify product mirror. `shopifyProductId` (unique), `title`, `handle`, `vendor`, `productType`, `imageUrl`, `tags[]`, `category`, `defaultFactoryId` → Factory, `status` enum active/archived/draft, `lastSyncedAt`. Indexes: title, vendor, productType, handle, tags, `{status,title}`.

### Variant (`variants`)
Sellable SKU + stock buckets. `productId` → Product, `shopifyVariantId` (unique), `shopifyInventoryItemId`, `sku` (idx), `barcode`, `title`, `color`, `size`, `imageUrl`, `compareAtPrice`, `sellingPrice`, `cogs` (financial), **stock**: `onlineStock` (Shopify, can be negative), `shopifyAvailable`, `onHoldStock` (≤0), `realStock` (warehouse, schema min 0), `lowStockThreshold` (5). Indexes: `{productId,sku}`, barcode, title, color, size, `{productId,color,size}`, `{realStock,lowStockThreshold}`.

### Order (`orders`)
Central OMS document (Shopify + manual + exchange/return/repair).
- Identity/source: `shopifyOrderId` (required, unique — manual orders also fill it), `shopifyOrderName`, `orderSource` shopify/manual, `manualSource` (instagram/facebook/whatsapp/phone/website/other).
- Parties: `customerId` → Customer (required), `assignedOrdersManagerId`/`assignedStockManagerId` → User.
- Shipping: `shippingAddress` {label, line1*, line2, city*, zone, phone, fullName} (required unless pickup), `shippingAddressLockedAt/By`, `shippingMethod` bosta/local_shipping/pickup, `shippingFee`, `localShippingNote/MarkedAt`, `localReturnIntent` failed/cancel/exchange.
- Payment: `paymentMethod` cod/online, `onlinePaymentStatus` none/pending/paid/failed + provider/reference/amount/`onlinePaidAt`, `bostaCollectedAmount/At`.
- Status: `internalStatus` enum ORDER_STATUSES (default pending_verification), `lastStatusUpdateAt`, `verifiedAt`, `deliveredAt`, `closedAt`, `returnedFromOutOfStockAt`, `delayedUntil`/`delayNote`/`delayNotifiedOn`, `verificationLog[]` {outcome enum, note, actorUserId → User, createdAt}.
- Bosta: `bostaDeliveryId`, `bostaTrackingNumber`, `bostaShipmentStatus` none/queued/creating/created/failed, `bostaShipmentError`, `bostaFeeBreakdown` {shippingFee, openPackageFee, nextDayTransferFee, vat, insuranceFee, total, fetchedAt, source calculator/delivery}.
- Money: `totalSellingPrice`*, `merchandiseSubtotal`, `discountPercent` 0–100, `discountAmount`, `totalCogsSnapshot` (financial), `exchangeCreditAmount`.
- Lines: `items[]` {variantId → Variant, sku, quantity ≥1, unitSellingPrice, unitCogs, isOnOffer, offerType b1g1/sale, unitCompareAtPrice} (required unless repair); `bostaReturnItems[]` {variantId → Variant, sku, quantity, title, color, size, unitSellingPrice}.
- Flags/links: `isCreatorOrder`, `isOfferOrder`, `isExchangeOrder` + `exchangeFromOrderId` → Order, `isReturnOrder` + `returnFromOrderId` → Order, `isRepairOrder` + `repairItemName`/`repairNote`, `skipCollectRestock`.
- Cancel/return/refund: `cancellationReason`, `returnReason` enum (sizing_fit, product_issue, wrong_item, changed_mind, delivery_issue, refused_at_door, other), `returnReasonNote`, `refundAmount`, `refundPaid`, `refundPaidAt/By`, `refundPaymentMethod` (inline enum), `refundPaymentReference`, `refundAdminNote`.
- Indexes: `{internalStatus,placedAt}`, `{items.variantId,internalStatus}`, `placedAt`, `{deliveredAt,internalStatus}`, `bostaCollectedAt`, `{paymentMethod,onlinePaidAt}`, `{onlinePaymentStatus,onlinePaidAt}` + many single-field `index:true`.

### ReportOrder (view over `orders`)
Clone of `orderSchema`, `autoIndex:false`; pre-hooks force `isRepairOrder != true` on find/findOne/countDocuments/distinct/aggregate. Used for sales/KPI reports.

### OrderStatusHistory (`orderstatushistories`)
Audit trail. `orderId` → Order, `fromStatus` (enum or null), `toStatus`, `source` enum STATUS_SOURCES (shopify_webhook, shopify_import, bosta_webhook, user_action, system), `actorUserId` → User, `note`. Index `{orderId, createdAt:-1}`.

### InventoryLedger (`inventoryledgers`)
Append-only stock movements. `variantId` → Variant, `orderId` → Order, `ledgerType` enum LEDGER_TYPES, `quantityDelta`, `reasonCode`, `actorUserId` → User, `shopifySyncStatus` pending/synced/failed, `shopifySyncError`. Indexes `{variantId,createdAt}`, `{ledgerType,createdAt}`.

### CogsBatch (`cogsbatches`)
Per-variant cost batches. `variantId` → Variant, `batchLabel`, `cogs`, `quantity`, `receivedAt`, `createdBy` → User.

### DiscrepancyAlert (`discrepancyalerts`)
Integrity alerts. `type` enum online_stock_drift/inventory_invariant/orphan_webhook/sync_error, `variantId` → Variant, `orderId` → Order, `expected`/`actual` (Mixed), `message`, `resolvedAt`, `resolvedByUserId` → User. Index `{resolvedAt, createdAt}`.

### BostaStatusMapping (`bostastatusmappings`)
`bostaState` (unique string) → `internalStatus` (ORDER_STATUSES), `isActive`, `description`.

### BostaReturn (`bostareturns`)
Cached Bosta RTO/return deliveries for dashboard. `bostaDeliveryId` (unique), `trackingNumber`, `businessReference`, `typeCode/Value`, `stateCode/Value`, `returnedAt`*, `codAmount`, receiver name/phone, `orderId` → Order, `lastSyncedAt`. Index `{returnedAt, typeCode}`.

### PaymobReceived (`paymobreceiveds`)
Successful Paymob payments ledger. `externalId` (unique), `amountEgp`, `receivedAt`.

### WebhookReceipt (`webhookreceipts`)
Idempotency/audit for inbound webhooks. `source` shopify/bosta/paymob, `externalId`, `topic`, `payload` (Mixed), `processedAt`, `error`. Unique `{source, externalId}`.

### Notification (`notifications`)
Role-targeted in-app notifications. `type` enum NOTIFICATION_TYPES (new_order … general), `roles[]` (USER_ROLES), `title`, `body`, `severity` info/success/warning/danger, `link`, `orderId` → Order, `variantId` → Variant, `readBy[]` → User. Index `{roles, createdAt}`.

### Settings (`settings`)
Singleton (`key:'global'`, unique). Shopify: shop/public domain, `shopifyCatalogMode` admin/storefront/none, **`shopifyAccessToken`, `shopifyClientId`, `shopifyClientSecret`, `shopifyWebhookSecret` (plaintext)**, token expiry, api version, shop name, location, last sync/webhook timestamps, health, `shopifyWritePolicy` oms_only/full. Bosta: last sync/webhook, health, `bostaCities[]`, `bostaPollingThresholdHours` (48). `defaultLowStockThreshold` (5), `manualOrderNextSeq` (M-#### counter).

### Factory (`factories`)
Suppliers. `name`, country, city, contact name/email/phone, `leadTimeDays` (14), `currency`, `notes`, `isActive`. Indexes name, isActive.

### PurchaseOrder (`purchaseorders`)
`poNumber` (unique), `factoryId` → Factory, `status` enum PO_STATUSES, `items[]` {variantId → Variant, sku, title, color, size, quantity ≥1, unitCost, currency}, `totalCost`, `expectedDeliveryDate`, `notes`, `createdBy` → User, `sentAt`, `receivedAt`. Indexes `{factoryId,status}`, `{status,createdAt}`, `{items.variantId,status}`.

### GLAccount (`glaccounts`)
Chart of accounts. `code` (unique), `name`, `category` enum GL_CATEGORIES, `type`, `isActive`.

### JournalEntry (`journalentries`)
`date`, `description`, `reference`, `source` manual/auto_order/auto_delivery, `orderId` → Order, `createdBy` → User, `lines[]` {accountId → GLAccount, debit, credit, note}. No schema-level debit=credit balance check. Indexes date, orderId, source.

### BrandExpense (`brandexpenses`)
Expense catalog. `key` (unique), `name`, `kind` fixed/variable, `amount`, `amountMin/Max`, `currency` EGP/USD, `sortOrder`, `autoComputed`, `isActive`, `deletedAt` (soft delete).

### MonthlyExpense (`monthlyexpenses`)
Actuals per month. `yearMonth` (`YYYY-MM`), `expenseKey` (? BrandExpense.key by string, not ObjectId), `amount`, `currency`, `amountEgp`, `note`, `createdBy` → User. Unique `{yearMonth, expenseKey}`.

### Employee (`employees`)
`userId` → User (unique), `employeeCode` (unique), `department` enum, `jobTitle`, `hireDate`, `salary`, `salaryType` monthly/hourly, `bankAccount`, `emergencyContact {name, phone}`, `isActive`. Index `{department,isActive}`.

### Attendance (`attendances`)
`employeeId` → Employee, `date`, `clockIn/Out`, `hoursWorked`, `status` present/absent/late/half_day, `note`, `recordedBy` → User. Unique `{employeeId, date}`.

### LeaveRequest (`leaverequests`)
`employeeId` → Employee, `type` annual/sick/unpaid/emergency, `startDate`, `endDate`, `daysCount` ?0.5, `reason`, `status` pending/approved/rejected, `reviewedBy` → User, `reviewedAt`.

### (Not a Mongoose model) `agendaJobs`
Agenda job collection configured in `config/agenda.js`.

### Relationships summary
- **Order → Customer** (`customerId`); **Order → User** (assigned managers, `verificationLog[].actorUserId`, `refundPaidBy`, `shippingAddressLockedBy`).
- **Order.items[].variantId → Variant → Product → Factory** (`defaultFactoryId`); `Order.bostaReturnItems[].variantId → Variant`.
- **Order → Order** self-links: `exchangeFromOrderId`, `returnFromOrderId`.
- **OrderStatusHistory → Order, User**.
- **InventoryLedger → Variant, Order, User**; **CogsBatch → Variant, User**; **DiscrepancyAlert → Variant, Order, User**.
- **BostaReturn → Order**; **Notification → Order, Variant, User(readBy)**; **JournalEntry → Order, User, lines[] → GLAccount**.
- **PurchaseOrder → Factory, User, items[] → Variant**.
- **Employee → User**; **Attendance / LeaveRequest → Employee, User**.
- **MonthlyExpense.expenseKey → BrandExpense.key** (string join).
- **BostaStatusMapping.internalStatus**, **WebhookReceipt**, **PaymobReceived**, **Settings** are standalone (no refs). ReportOrder shares the `orders` collection.

---

## API endpoints

Base prefix: `/api/v1` (app.js) + per-router mount (routes/index.js). Roles legend: **A** = admin, **OM** = orders_manager, **SM** = stock_manager, **Auth** = any authenticated active user, **Public** = no auth. "+FinSan" = `sanitizeFinancialResponse` applied to router.

### app.js / routes/index.js (misc + webhooks)
| Method | Full path | Roles | Controller | Purpose |
|---|---|---|---|---|
| GET | `/` | Public | inline (app.js) | API name/status banner |
| GET | `/api/v1/health` | Public | inline (routes/index.js) | Liveness check |
| POST | `/webhooks/shopify/:topic` | Public (Shopify HMAC via `verifyShopifyHmac`; skipped in non-production if no secret) | `webhooks/shopify.router.js` | Enqueue Shopify webhook (topic `a-b` → `a/b`) |
| POST | `/webhooks/bosta` | Public (**no signature check**) | `webhooks/bosta.router.js` | Normalize + enqueue Bosta status webhook; always 200 |
| POST | `/webhooks/paymob` | Public (Paymob HMAC only if `PAYMOB_HMAC_SECRET` set) | `webhooks/paymob.router.js` | Record WebhookReceipt + Paymob payment |

### auth.routes.js — `/api/v1/auth`
| Method | Full path | Roles | Controller | Purpose |
|---|---|---|---|---|
| POST | `/api/v1/auth/login` | Public | `auth.login` | Get JWT |
| GET | `/api/v1/auth/me` | Auth | `auth.me` | Current user |

### orders.routes.js — `/api/v1/orders` (Auth + FinSan)
| Method | Full path | Roles | Controller | Purpose |
|---|---|---|---|---|
| GET | `/api/v1/orders/counts` | A, OM, SM | `getStateCounts` | Status counts |
| POST | `/api/v1/orders/manual` | A, OM | `createManualOrder` | Create manual order |
| POST | `/api/v1/orders/repair` | A, OM | `createRepairOrder` | Create repair order |
| GET | `/api/v1/orders/exchange-lookup` | A, OM | `findExchangeOrder` | Find original order for exchange |
| GET | `/api/v1/orders/shipping-fee-suggest` | A, OM | `suggestShippingFee` | Zone fee suggestion |
| GET | `/api/v1/orders` | A, OM, SM (SM status-clamped) | `listOrders` | List/search orders |
| GET | `/api/v1/orders/export/pending-refunds` | A, OM | `exportPendingRefunds` | Excel |
| POST | `/api/v1/orders/bulk-verify` | A, OM | `bulkVerifyOrders` | Bulk verification |
| GET | `/api/v1/orders/:id` | A, OM, SM | `getOrder` | Order detail |
| GET | `/api/v1/orders/:id/history` | A, OM, SM | `getStatusHistory` | Status history |
| POST | `/api/v1/orders/:id/claim` | A, OM, SM | `claimOrder` | Claim order |
| POST | `/api/v1/orders/:id/verify` | A, OM | `verifyOrder` | Verify outcome |
| POST | `/api/v1/orders/:id/delay` | A, OM | `delayOrder` | Delay/callback |
| POST | `/api/v1/orders/:id/cancel` | A, OM | `cancelOrder` | Cancel |
| POST | `/api/v1/orders/:id/partial-local-delivery` | A, OM | `partialLocalDelivery` | Partial local delivery |
| POST | `/api/v1/orders/:id/local-return-to-stock` | A, OM | `returnLocalShippingToStock` | Local bag back to stock |
| POST | `/api/v1/orders/:id/pickup-return-to-stock` | A, OM, SM | `returnPickupToStock` | Pickup order back to stock |
| POST | `/api/v1/orders/:id/exchange` | A, OM | `exchangeItem` | Exchange a line |
| POST | `/api/v1/orders/:id/remove-item` | A, OM | `removeItem` | Remove line |
| POST | `/api/v1/orders/:id/add-item` | A, OM | `addItem` | Add line |
| PATCH | `/api/v1/orders/:id/shipping` | A, OM | `updateShippingAddress` | Edit address/method/fee |
| POST | `/api/v1/orders/:id/discount` | A, OM | `applyDiscount` | Apply % discount |
| POST | `/api/v1/orders/:id/transition` | A, OM, SM (SM restricted in controller) | `transitionStatus` | Status transition |
| POST | `/api/v1/orders/:id/confirm-return` | A, SM | `confirmReturn` | Warehouse return receipt |
| POST | `/api/v1/orders/:id/confirm-refund-paid` | A | `confirmRefundPaid` | Refund payout confirmed |

### inventory.routes.js — `/api/v1/inventory` (Auth + FinSan)
| Method | Full path | Roles | Controller | Purpose |
|---|---|---|---|---|
| GET | `/api/v1/inventory/catalog` | A, SM, OM | `listCatalog` | Catalog grid |
| GET | `/api/v1/inventory/catalog/filters` | A, SM, OM | `catalogFilters` | Filter options |
| POST | `/api/v1/inventory/catalog/export-stock` | A, SM | `exportCatalogStock` | Excel by product ids |
| GET | `/api/v1/inventory/catalog/export-jard` | A, SM | `exportInventoryCount` | Stock-count (jard) Excel |
| GET | `/api/v1/inventory/out-of-stock-pieces/export` | A, SM, OM | `exportOutOfStockPieces` | OOS pieces Excel |
| GET | `/api/v1/inventory/variants/lookup` | A, SM, OM | `lookupVariantBySku` | SKU/barcode lookup |
| GET | `/api/v1/inventory/variants/lookup-family` | A, SM, OM | `lookupVariantFamilyBySku` | Sibling sizes |
| POST | `/api/v1/inventory/stock-intake` | A, SM | `stockIntake` | Single intake |
| POST | `/api/v1/inventory/stock-intake/batch` | A, SM | `stockIntakeBatch` | Batch intake |
| POST | `/api/v1/inventory/stock-set/batch` | A, SM | `stockSetBatch` | Set absolute realStock |
| GET | `/api/v1/inventory/variants` | A, SM, OM | `listVariants` | Variant list |
| GET | `/api/v1/inventory/variants/:id` | A, SM, OM | `getVariant` | Variant detail |
| GET | `/api/v1/inventory/variants/:id/barcode.png` | A, SM | `getVariantBarcodePng` | Barcode image |
| GET | `/api/v1/inventory/variants/:id/barcode-labels` | A, SM | `getVariantBarcodeLabels` | Label HTML |
| POST | `/api/v1/inventory/barcode-labels/batch` | A, SM | `getBarcodeLabelsBatch` | Batch label HTML |
| GET | `/api/v1/inventory/variants/:id/ledger` | A, SM | `getLedger` | Ledger |
| POST | `/api/v1/inventory/variants/:id/adjust` | A, SM | `adjustStock` | Manual adjustment |
| GET | `/api/v1/inventory/discrepancies` | A, SM | `listDiscrepancies` | Open alerts |
| GET | `/api/v1/inventory/on-hold` | A, SM, OM | `listOnHoldItems` | On-hold pieces |
| GET | `/api/v1/inventory/queue-counts` | A, SM | `getQueueCounts` | Stock queue counts |

### customers.routes.js — `/api/v1/customers` (Auth)
| Method | Full path | Roles | Controller | Purpose |
|---|---|---|---|---|
| GET | `/api/v1/customers` | A, OM | `listCustomers` | List |
| GET | `/api/v1/customers/filter-options` | A, OM | `filterOptions` | Filters |
| GET | `/api/v1/customers/export` | A, OM | `exportCustomers` | Excel |
| GET | `/api/v1/customers/lookup/by-phone` | A, OM | `lookupByPhone` | Phone lookup |
| GET | `/api/v1/customers/:id` | A, OM | `getCustomer` | Detail |
| GET | `/api/v1/customers/:id/orders` | A, OM | `getCustomerOrders` | Customer orders |
| PATCH | `/api/v1/customers/:id/risk-flag` | A, OM | `updateRiskFlag` | Set risk flag |

### products.routes.js — `/api/v1/products` (Auth + FinSan)
| Method | Full path | Roles | Controller | Purpose |
|---|---|---|---|---|
| GET | `/api/v1/products` | A, SM | `listProducts` | Active products |
| GET | `/api/v1/products/cogs-health` | A | `cogsHealth` | COGS health |
| GET | `/api/v1/products/cogs-health/export` | A | `exportCogsHealth` | Excel |
| PATCH | `/api/v1/products/variants/:variantId/cogs` | A | `updateCogs` | Set COGS |
| POST | `/api/v1/products/variants/:variantId/cogs-batches` | A | `addCogsBatch` | Add COGS batch |

### reports.routes.js — `/api/v1/reports` (Auth)
| Method | Full path | Roles | Controller | Purpose |
|---|---|---|---|---|
| GET | `/api/v1/reports/top-sellers` | A, OM | `topSellers` | Top sellers by units |
| GET | `/api/v1/reports/dashboard` | A | `dashboard` | Dashboard stats |
| GET | `/api/v1/reports/dashboard/core` | A | `dashboardCore` | Core KPIs |
| GET | `/api/v1/reports/dashboard/money` | A | `dashboardMoney` | Money KPIs |
| GET | `/api/v1/reports/dashboard/summary` | A | `dashboardSummary` | Summary |
| GET | `/api/v1/reports/dashboard/details` | A | `dashboardDetails` | Details |
| GET | `/api/v1/reports/profitability` | A | `profitability` | Profitability |
| GET | `/api/v1/reports/profitability/export` | A | `exportProfitability` | Excel |
| GET | `/api/v1/reports/audit` | A | `auditLog` | Audit log |
| GET | `/api/v1/reports/audit/export` | A | `exportAuditLog` | Excel |

### users.routes.js — `/api/v1/users` (A)
| Method | Full path | Roles | Controller | Purpose |
|---|---|---|---|---|
| GET | `/api/v1/users` | A | `listUsers` | List users |
| POST | `/api/v1/users` | A | `createUser` | Create user |
| DELETE | `/api/v1/users/:id` | A | `deactivateUser` | Deactivate (soft) |

### settings.routes.js — `/api/v1/settings` (A)
| Method | Full path | Roles | Controller | Purpose |
|---|---|---|---|---|
| GET | `/api/v1/settings` | A | `getSettings` | Settings + Bosta mappings |
| PATCH | `/api/v1/settings` | A | `updateSettings` | Update 5 fields |
| POST | `/api/v1/settings/bosta-mappings` | A | `upsertBostaMapping` | Upsert Bosta?status mapping |
| POST | `/api/v1/settings/shopify/sync` | A | `forceShopifySync` | Queue catalog sync |
| POST | `/api/v1/settings/bosta/sync-states` | A | `forceBostaStatesSync` | Bosta states sync/backfill |

### fulfillment.routes.js — `/api/v1/fulfillment` (Auth)
| Method | Full path | Roles | Controller | Purpose |
|---|---|---|---|---|
| GET | `/api/v1/fulfillment/warehouse-review` | A, SM | `getWarehouseReview` | Backlog |
| GET | `/api/v1/fulfillment/warehouse-review/export` | A, SM | `exportWarehouseReview` | Excel |
| GET | `/api/v1/fulfillment/warehouse-review/intakes` | A, SM | `getStockIntakes` | Intake log |
| GET | `/api/v1/fulfillment/warehouse-review/intakes/export` | A, SM | `exportStockIntakes` | Excel |
| GET | `/api/v1/fulfillment/warehouse-review/stock-export` | A, SM | `exportCurrentStock` | Current stock Excel |
| GET | `/api/v1/fulfillment/pick-list` | A, SM | `getPickList` | Pick list |
| POST | `/api/v1/fulfillment/:id/pick-pack` | A, SM | `pickAndPack` | Pick & pack |
| POST | `/api/v1/fulfillment/:id/prepare-awb` | A, SM, OM (OM: return orders only) | `prepareAwb` | Create/print AWB/CRP |
| POST | `/api/v1/fulfillment/:id/out-of-stock` | A, SM | `markOutOfStock` | Mark OOS |
| GET | `/api/v1/fulfillment/:id/shipment-status` | A, SM, OM | `getShipmentStatus` | Bosta status |
| GET | `/api/v1/fulfillment/:id/stock-check` | A, SM | `checkStock` | Stock warnings |
| GET | `/api/v1/fulfillment/:id/awb` | A, SM | `getAwb` | AWB |
| GET | `/api/v1/fulfillment/:id/order-sheet` | A, SM | `getOrderSheet` | Order sheet |

### reference.routes.js — `/api/v1/reference` (Auth)
| Method | Full path | Roles | Controller | Purpose |
|---|---|---|---|---|
| GET | `/api/v1/reference/bosta-cities` | A, OM, SM | inline | Bosta cities |
| GET | `/api/v1/reference/bosta-cities/:cityId/districts` | A, OM, SM | inline | Districts |
| POST | `/api/v1/reference/bosta-cities/sync` | A | inline | Force city refresh |

### shopify.routes.js — `/api/v1/integrations/shopify` (Auth)
| Method | Full path | Roles | Controller | Purpose |
|---|---|---|---|---|
| GET | `/api/v1/integrations/shopify/status` | A | `getStatus` | Status |
| POST | `/api/v1/integrations/shopify/connect` | A | `connect` | Save creds + test |
| POST | `/api/v1/integrations/shopify/test` | A | `testConnection` | Test |
| POST | `/api/v1/integrations/shopify/sync` | A | `syncCatalog` | Catalog sync |
| GET | `/api/v1/integrations/shopify/sync-status` | A | `syncStatus` | Sync state |
| POST | `/api/v1/integrations/shopify/push-warehouse-stock` | A | `pushWarehouseStock` | Push stock to Shopify |
| POST | `/api/v1/integrations/shopify/register-webhooks` | A | `registerWebhooks` | Register webhooks |
| GET | `/api/v1/integrations/shopify/locations` | A | `getLocations` | Locations |
| POST | `/api/v1/integrations/shopify/import-orders` | A, OM | `importOrders` | Import orders |
| POST | `/api/v1/integrations/shopify/import-customers` | A, OM | `importCustomers` | Import customers |
| GET | `/api/v1/integrations/shopify/import-customers/status` | A, OM | `importCustomersStatus` | Import progress |

### integrations.routes.js — `/api/v1/integrations` (A)
| Method | Full path | Roles | Controller | Purpose |
|---|---|---|---|---|
| GET | `/api/v1/integrations/health` | A | `getHealth` | Integration health |

### notification.routes.js — `/api/v1/notifications` (Auth, any role)
| Method | Full path | Roles | Controller | Purpose |
|---|---|---|---|---|
| GET | `/api/v1/notifications` | Auth | `list` | List for user's role |
| GET | `/api/v1/notifications/unread-count` | Auth | `unreadCount` | Badge count |
| POST | `/api/v1/notifications/:id/read` | Auth | `markRead` | Mark read |
| POST | `/api/v1/notifications/read-all` | Auth | `markAllRead` | Mark all read |

### manufacturing.routes.js — `/api/v1/manufacturing` (A)
| Method | Full path | Roles | Controller | Purpose |
|---|---|---|---|---|
| GET | `/api/v1/manufacturing/factories` | A | `listFactories` | List |
| POST | `/api/v1/manufacturing/factories` | A | `createFactory` | Create |
| PATCH | `/api/v1/manufacturing/factories/:id` | A | `updateFactory` | Update |
| DELETE | `/api/v1/manufacturing/factories/:id` | A | `deleteFactory` | Delete |
| GET | `/api/v1/manufacturing/orderable-products` | A | `listOrderableProducts` | Products for POs |
| PATCH | `/api/v1/manufacturing/products/:productId/factory` | A | `assignProductFactory` | Link product → factory |
| GET | `/api/v1/manufacturing/purchase-orders` | A | `listPurchaseOrders` | List POs |
| POST | `/api/v1/manufacturing/purchase-orders` | A | `createPurchaseOrder` | Create PO |
| GET | `/api/v1/manufacturing/purchase-orders/:id` | A | `getPurchaseOrder` | PO detail |
| PATCH | `/api/v1/manufacturing/purchase-orders/:id` | A | `updatePurchaseOrder` | Update PO |
| POST | `/api/v1/manufacturing/purchase-orders/:id/receive` | A | `receivePurchaseOrder` | Receive PO |
| GET | `/api/v1/manufacturing/purchase-orders/:id/export` | A | `exportPurchaseOrder` | PO Excel |

### accounting.routes.js — `/api/v1/accounting` (A)
| Method | Full path | Roles | Controller | Purpose |
|---|---|---|---|---|
| GET | `/api/v1/accounting/accounts` | A | `listAccounts` | GL accounts |
| POST | `/api/v1/accounting/accounts` | A | `createAccount` | Create GL account |
| PATCH | `/api/v1/accounting/accounts/:id` | A | `updateAccount` | Update GL account |
| GET | `/api/v1/accounting/journal` | A | `listJournal` | Journal |
| POST | `/api/v1/accounting/journal` | A | `createJournal` | Manual entry |
| GET | `/api/v1/accounting/reports/cogs-health` | A | `cogsHealth` | COGS health |
| GET | `/api/v1/accounting/cogs-health` | A | `cogsHealth` | Alias |
| GET | `/api/v1/accounting/reports/pl` | A | `profitAndLoss` | P&L |
| GET | `/api/v1/accounting/reports/pl/export` | A | `exportPl` | Excel |
| GET | `/api/v1/accounting/reports/balance-sheet` | A | `balanceSheet` | Balance sheet |
| GET | `/api/v1/accounting/reports/top-products` | A | `topProducts` | Top products |
| GET | `/api/v1/accounting/reports/top-products/export` | A | `exportTopProducts` | Excel |
| GET | `/api/v1/accounting/reports/cogs-health/export` | A | `exportCogsHealth` | Excel |
| GET | `/api/v1/accounting/cogs-health/export` | A | `exportCogsHealth` | Alias |
| GET | `/api/v1/accounting/expenses` | A | `listBrandExpenses` | Brand expenses |
| POST | `/api/v1/accounting/expenses` | A | `createBrandExpense` | Create |
| PATCH | `/api/v1/accounting/expenses/:id` | A | `updateBrandExpense` | Update |
| DELETE | `/api/v1/accounting/expenses/:id` | A | `deleteBrandExpense` | Delete |
| GET | `/api/v1/accounting/expenses/export` | A | `exportBrandExpenses` | Excel |
| GET | `/api/v1/accounting/expenses/month` | A | `getMonthExpenses` | Month breakdown |
| PUT | `/api/v1/accounting/expenses/month` | A | `saveMonthExpenses` | Save month actuals |

### hr.routes.js — `/api/v1/hr` (A)
| Method | Full path | Roles | Controller | Purpose |
|---|---|---|---|---|
| GET | `/api/v1/hr/employees` | A | `listEmployees` | List |
| POST | `/api/v1/hr/employees` | A | `createEmployee` | Create |
| GET | `/api/v1/hr/employees/:id` | A | `getEmployee` | Profile + KPIs |
| PATCH | `/api/v1/hr/employees/:id` | A | `updateEmployee` | Update |
| GET | `/api/v1/hr/employees/:id/attendance` | A | `listAttendance` | Attendance |
| POST | `/api/v1/hr/employees/:id/attendance` | A | `recordAttendance` | Record attendance |
| GET | `/api/v1/hr/employees/:id/kpis` | A | `getKpis` | KPIs |
| GET | `/api/v1/hr/leave-requests` | A | `listLeaveRequests` | List leave |
| POST | `/api/v1/hr/leave-requests` | A | `createLeaveRequest` | Create leave |
| PATCH | `/api/v1/hr/leave-requests/:id` | A | `reviewLeaveRequest` | Approve/reject |
| GET | `/api/v1/hr/payroll-summary` | A | `payrollSummary` | Payroll |

---

## Issues spotted (core)

### Security
- **Financial-field stripping leaks COGS to non-admins.** `src/middleware/rbac.js:40-44` only strips inside `body.data` or top-level keys of `body`. Handlers that return `{ orders, total }` (`orders.controller.js:71`), `{ variants, total }` (`inventory.controller.js:14`, from `product.service.js:49`) or `{ products, total }` are not covered, so `items[].unitCogs`, `totalCogsSnapshot`, and `Variant.cogs` reach orders/stock managers via `GET /api/v1/orders` and `GET /api/v1/inventory/variants`. It also never recurses into nested objects (for example, populated variants). The fulfillment and customers routers don't apply it at all.
- **The Bosta webhook has no authentication or signature check.** `app.js:44` and `webhooks/bosta.router.js:11` accept any POST and enqueue it as a status update. That lets anyone forge delivery/return states.
- **Paymob HMAC is optional.** `webhooks/paymob.router.js:23-30` accepts unsigned payloads (with only a warning) when `PAYMOB_HMAC_SECRET` is unset, and `config/index.js:26` makes it optional.
- **Shopify HMAC fails open outside production.** `webhooks/verifyShopifyHmac.js:9-10` returns `true` when no secret exists and `NODE_ENV !== 'production'`. `config/index.js:7` defaults `NODE_ENV` to `development`, so a deploy that is missing the env var accepts unsigned webhooks.
- **`/auth/login` has no rate limiting or lockout** (`routes/auth.routes.js:7`). No rate-limit package is in `package.json`.
- **CORS allows any origin when `CORS_ORIGIN` is empty** (`app.js:15`, documented in `config/index.js:28`).
- **Stack traces leak unless `NODE_ENV === 'production'`.** `middleware/errorHandler.js:13` reads `process.env` directly, and the `config` default is `development`.
- **Shopify secrets are stored in plaintext** in the `Settings` document (`models/Settings.js:9-13`), written by `shopify.controller.js:38-43`. `sanitizeSettings` (`settings.controller.js:15`) masks `shopifyClientId` but still returns the raw value.
- **No request validation anywhere.** `middleware/validate.js` exists but no route uses it. Raw `req.body` is spread into services: `orders.controller.js:89`, `accounting.controller.js:49`, `hr.controller.js:56`, `manufacturing.controller.js:96`, `products.controller.js:31`, and direct `req.body` in `createAccount`/`updateAccount`/`createEmployee`/`updateEmployee`/`createFactory`/`updatePurchaseOrder`/`createBrandExpense`. That is mass-assignment risk, depending on service whitelisting.
- **Settings updates skip enum and min validators.** `settings.controller.js:57-67` and `76-81` call `findOneAndUpdate` without `runValidators`, so `upsertBostaMapping` can store an `internalStatus` outside `ORDER_STATUSES`, and `bostaPollingThresholdHours`/`defaultLowStockThreshold` take any value.
- **`DELETE /users/:id` has no self or last-admin guard** (`users.routes.js:12` → `auth.service.js:43-45`). An admin can lock everyone out.
- **Bad `login` input returns 500 instead of 401.** `auth.controller.js:5` passes an unvalidated body, and `auth.service.js:7` calls `email.toLowerCase()`.

### Reliability / error handling
- **A Paymob processing failure can lose the payment.** `webhooks/paymob.router.js:40-46` creates the `WebhookReceipt` before `recordPaymobPayment`. If processing throws, the handler returns 500, but Paymob's retry hits the unique index (11000) and gets "duplicate ignored" (`:55-57`), so the payment is never recorded.
- **Failed Bosta webhooks are always ACKed 200** (`webhooks/bosta.router.js:22-27`). Enqueue failures are lost unless polling picks them up.
- **Shopify webhook idempotency key can be non-deterministic.** `webhooks/shopify.router.js:20` falls back to `${topic}-${Date.now()}` when the webhook-id headers are missing, which defeats dedupe.
- **Invalid ObjectId params return 500.** `errorHandler.js:4` has no mapping for Mongoose `CastError`, and no route validates `:id`.
- **`uncaughtException` is only logged** (`server.js:95-97`), so the process keeps running in an undefined state.
- **`server.close` has no shutdown timeout** (`server.js:78`). Keep-alive connections can block exit.
- **Long synchronous work runs inside HTTP requests:** `shopify.controller.js:98-100` (`all:true` full order backfill, also open to orders_manager via `shopify.routes.js:21`), `shopify.controller.js:130-135` (`maxItems: Infinity` customer import), and `settings.controller.js:106-116` (Bosta backfill). Expect proxy timeouts on Render.
- **Boot-time heavy sync runs in the web process** (`server.js:55`). Catalog sync, order import, seeds, and Bosta returns run on every boot, and Agenda also starts here (`server.js:49-52`) even though `workers/agendaWorker.js` and an npm `worker` script exist to run Agenda separately.

### Dead / duplicated / inconsistent code
- **Dead code:** `optionalAuth` (`middleware/auth.js:25`) and `validate` (`middleware/validate.js`) are unused. `importRealStockExcel` (`inventory.controller.js:110`) has no route and there's no multer middleware, even though `multer` is a dependency.
- **Default-export objects are stale or unused.** `orders.controller.js:577-602` omits `createRepairOrder`, and `inventory.controller.js:273-294` omits `exportOutOfStockPieces`. The routers use `import *`, so these objects are effectively dead.
- **Duplicate endpoints:** `accounting.routes.js:17-18` and `24-25` register `cogs-health` and its export twice. `products.routes.js:11-12` adds a third copy with a different default limit (200 at `accounting.controller.js:163` vs 2000 at `products.controller.js:45`).
- **Duplicated enums:**
  - The `returnReason` set is redefined in `orders.controller.js:199-207` (also in `Order.js:131-139`).
  - `refundPaymentMethod` is inlined at `Order.js:153-156` instead of using `REFUND_PAYMENT_METHODS` (`constants/index.js:27`).
  - The fee `95` is hard-coded at `shippingZones.js:133` instead of `DEFAULT_BOSTA_SHIPPING_FEE`.
- **Fat controller:** `orders.controller.js:297-470` (`updateShippingAddress`) holds the shipping-fee rules, the editable-status list, customer updates, and Shopify/Bosta side effects inline instead of in a service. Controllers also rely heavily on dynamic `await import(...)` (for example `orders.controller.js:69,145-146,299-304`).
- **Redundant `Order` import:** `fulfillment.controller.js:88` dynamically imports `Order` while it is already statically imported at `:4`.
- **Dead param fallbacks:** `accounting.controller.js:113,129` read `req.params.month`, but the routes have no `:month` param. `saveMonthExpenses` doesn't validate `month`, unlike `getMonthExpenses`.
- **Inconsistent stock-manager access:** `listOrders` clamps the statuses a stock manager can list (`orders.controller.js:51`), but `getOrder`/`history`/`claim` (`orders.routes.js:30-36`) let them read any order by id.
- **`models/index.js` barrel is incomplete.** It omits `Notification`, `BostaReturn`, `PaymobReceived`, and `ReportOrder`.
- **Redundant index declarations:** `unique: true` plus `index: true` on `Order.shopifyOrderId` (`Order.js:50`), `BostaReturn.bostaDeliveryId` (`BostaReturn.js:10`), and `PaymobReceived.externalId` (`PaymobReceived.js:6`).
- **Unchecked data invariants:** `JournalEntry` (`JournalEntry.js:22`) doesn't check that debits equal credits. `MonthlyExpense.expenseKey` (`MonthlyExpense.js:10`) joins to `BrandExpense` by free string, with no referential check.
- **Business logic in a route file:** `reference.routes.js:16-61` defines its handlers inline instead of in a controller.
