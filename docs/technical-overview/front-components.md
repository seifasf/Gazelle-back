# Gazelle frontend … `src/components/**` and `src/styles/*`

Scope: 53 JSX files under `src/components/` (8,758 lines) plus `src/styles/global.css` (5,176 lines). Read-only audit; line numbers refer to the working tree on 2026-10-08 (`OrderDetail.jsx` has uncommitted edits).

Conventions used below: `ordersApi.*`, `inventoryApi.*`, `fulfillmentApi.*`, `customersApi.*`, `shopifyApi.*`, `notificationsApi.*` come from `src/api/client.js`. "Invalidates" lists the TanStack Query keys refreshed after a mutation. `useConfirmModal` / `useToast` are the in-house hooks from `components/ConfirmModal.jsx` and `components/Toast.jsx`.

---

## Frontend components: function-by-function

### src/components/BrandLogo.jsx
Purpose: Gazelle logo `<img>` (used by `LoginPage`, `AppShell`).

| Name | What it does | Props/Inputs → Output | Calls / depends on |
|---|---|---|---|
| `BrandLogo` | Renders `/gazelle-logo.png` (915…915) with a variant class. | `{variant='sidebar', className}` → `<img class="brand-logo brand-logo--{variant}">` | — |

### src/components/ConfirmModal.jsx
Purpose: promise-based confirmation dialog used by almost every order action.

| Name | What it does | Props/Inputs → Output | Calls / depends on |
|---|---|---|---|
| `ConfirmModal` | Fixed overlay + card with Cancel / Confirm; backdrop click cancels. | `{open,title,message,confirmLabel,danger,onConfirm,onCancel,loading}` → dialog or `null` | inline styles |
| `useConfirmModal` | Hook returning `confirm(opts)` that resolves `true/false`, plus the `modal` element to render. | `confirm({title,message,confirmLabel,danger})` → `Promise<boolean>`; `{confirm, modal}` | `ConfirmModal` (never passes `loading`) |

### src/components/DataStates.jsx
Purpose: shared loading / error / empty / pagination widgets.

| Name | What it does | Props/Inputs → Output | Calls / depends on |
|---|---|---|---|
| `LoadingState` | Spinner + label, `role=status`. | `{label}` → div | — |
| `ErrorState` | Error message + optional retry button, `role=alert`. | `{message,onRetry}` → div | — |
| `EmptyState` | Inbox icon, title, message, optional action node. | `{message,title,action}` → div | `IconInbox` |
| `Pagination` | "Showing a…b of N" + Prev/Next. | `{page,total,pageSize,onPageChange}` → div | — |

### src/components/ErrorBoundary.jsx
Purpose: top-level render error boundary (used in `App.jsx`).

| Name | What it does | Props/Inputs → Output | Calls / depends on |
|---|---|---|---|
| `ErrorBoundary` (class) | Catches render errors, logs to console, shows message + "Reload page" (`window.location.reload`). | `{children}` → children or error page | React `Component` |

### src/components/IntegrationHealthCard.jsx
Purpose: Shopify / Bosta / Paymob health summary (Settings, AdminDashboard, OpsCommandCenter).

| Name | What it does | Props/Inputs → Output | Calls / depends on |
|---|---|---|---|
| `StatusDot` (local) | ?/? + label coloured ok/warn. | `{ok,label}` → span | — |
| `IntegrationHealthCard` | Compact tile grid (incl. pending-verify / ready-to-ship counts) or full panel with sync/webhook times, Bosta webhook URL/error, failed shipments. | `{health, compact}` → card(s) or `null` | `formatDate`, `Link` to `/admin/settings` |

### src/components/NotificationBell.jsx
Purpose: header bell with unread badge and dropdown list.

| Name | What it does | Props/Inputs → Output | Calls / depends on |
|---|---|---|---|
| `timeAgo` (local) | "just now / 5m / 3h / 2d ago" or short date. | `date` → string | — |
| `NotificationBell` | Polls unread count every 90 s; loads 20 items when open; click marks read and navigates to `n.link`; "Mark all read"; outside mousedown closes. | none → button + panel | `notificationsApi.unreadCount/list/markRead/markAllRead`, `useNavigate`, `IconBell` |

### src/components/Toast.jsx
Purpose: global toast context.

| Name | What it does | Props/Inputs → Output | Calls / depends on |
|---|---|---|---|
| `ToastProvider` | Holds toast list, auto-dismiss after `duration` (4 s default), click to dismiss. | `{children}` → provider + `.toast-stack` | — |
| `useToast` | Returns `{toast(message,{type,duration}), dismiss}`; throws outside provider. | — | `ToastContext` |

### src/components/admin/analytics/AnalyticsDateControls.jsx
Purpose: month / custom date-range picker for admin analytics pages (Cairo time).

| Name | What it does | Props/Inputs → Output | Calls / depends on |
|---|---|---|---|
| `cairoYmd`, `pad2`, `monthLabelFromYm`, `monthRangeYmd` (local) | Cairo-today `YYYY-MM-DD`, month labels and first/last-day ranges. | — | `Intl.DateTimeFormat` |
| `AnalyticsDateControls` (default) | Mode select (Month = last 6 months / Custom from…to); emits `{preset:'custom',from,to,rangeLabel,mode,monthOffset}` only when the key changes. | `{defaultMode, onChange}` → filter row | — |

### src/components/admin/analytics/AnalyticsNav.jsx
Purpose: tab links between admin dashboard analytics pages.

| Name | What it does | Props/Inputs → Output | Calls / depends on |
|---|---|---|---|
| `isActive` (local) | Exact match for `/admin/dashboard`, prefix for others. | `(pathname, href)` → bool | — |
| `AnalyticsNav` (default) | Buttons: Overview, Delivery, Cash/Collections, Returns, Exchanges. | none → links | `useLocation`, `Link` |

### src/components/customers/CustomerSegmentBadges.jsx
Purpose: VIP / Green / Red customer badges (CustomersPage).

| Name | What it does | Props/Inputs → Output | Calls / depends on |
|---|---|---|---|
| `VIP_ORDER_THRESHOLD`, `FREQUENT_CANCEL_THRESHOLD`, `CUSTOMER_SEGMENTS` | Constants (4, 2, filter options). | — | — |
| `isVipCustomer` | `lifetimeOrders > 4`. | customer → bool | — |
| `isGreenCustomer` | ?1 delivered and ≥2 cancelled. | customer → bool | — |
| `isRedCustomer` | >2 cancels, `riskFlag==='high_risk'`, or rejected/returned → delivered. | customer → bool | — |
| `CustomerSegmentBadges` | Renders VIP / Green (if not Red) / Red badges. | `{customer,className}` → span | above helpers |

### src/components/customers/FrequentCancelFlag.jsx
Purpose: "N+ cancels" badge on order lists/detail.

| Name | What it does | Props/Inputs → Output | Calls / depends on |
|---|---|---|---|
| `FREQUENT_CANCEL_THRESHOLD` | `2` (duplicate of the constant above). | — | — |
| `isFrequentCanceller` | `lifetimeCancelled > 2` (unused outside file). | customer → bool | — |
| `FrequentCancelFlag` | Badge when cancels > 2. | `{customer,count,className}` → span or `null` | — |

### src/components/dashboard/DashboardCharts.jsx
Purpose: recharts widgets for admin dashboard / analytics pages.

| Name | What it does | Props/Inputs → Output | Calls / depends on |
|---|---|---|---|
| `ChartCard`, `Donut`, `moneyTip` (local) | Card shell; donut with centre label; tooltip formatting EGP when key matches revenue/expected/collected/amount. | — | recharts |
| `OrdersRevenueTrendChart` | Daily orders (bars) + revenue (area). **Unused.** | `{rows}` → chart | — |
| `PaymentMixChart` | COD vs online donut. **Unused.** | `{payment}` | — |
| `ChannelMixChart` | Chat vs online store donut. **Unused.** | `{channel}` | — |
| `ReturnsPaymentChart` | Cash vs online returns donut. **Unused.** | `{returnsAnalytics}` | — |
| `ReturnsGenderChart` | Male/female/unknown returns donut. | `{returnsAnalytics}` | — |
| `StatusBarsChart` | Top-8 statuses bar chart (hard-coded "from 20 Jul 2026" subtitle). **Unused.** | `{byStatus}` | — |
| `ReturnsKindChart` | Refused/exchange/refund warehouse confirms. **Unused.** | `{warehouseByKind}` | — |
| `DeliveryOutcomeChart` | Delivered/failed/refused donut + success rate. | `{delivery}` | — |
| `MoneyCollectedChart` | Expected vs collected (COD/online) bars. | `{moneyCollected}` | — |
| `RefundTimingChart` | Days-after-delivery buckets. | `{daysAfterDelivery}` | — |
| `RefundReasonChart` | Refund/refused/exchange donut. | `{reason}` | — |
| `ReturnReasonCodesChart` | Structured return-reason donut (sizing_fit … unclassified). | `{returnReasons}` | — |
| `ExchangeSkuChart` / `ExchangeSizeChart` | Top exchanged SKUs / sizes bars. | `{topSkus}` / `{topSizes}` | — |
| default export | Object of all charts (unused; pages use named / lazy imports). | — | — |

### src/components/finance/FinanceCharts.jsx
Purpose: P&L / margin / expense charts. **Entire file is unused (no importer).**

| Name | What it does | Props/Inputs → Output | Calls / depends on |
|---|---|---|---|
| `ChartShell`, `money` (local) | Card shell; own EGP formatter. | — | recharts |
| `PlWaterfallChart` | P&L lines as +/- coloured bars. | `{waterfall}` | — |
| `MarginBarsChart` | Margin % by SKU (green ≥30, amber ≥10). | `{rows,valueKey,nameKey,title}` | — |
| `ExpenseMixDonut` | Fixed / variable / journal expense split. | `{fixed,variable,journal}` | — |
| `RevenueBarsChart` | Top-8 SKUs by revenue. | `{rows,title}` | — |

### src/components/finance/FinanceInsights.jsx
Purpose: insight cards + shared finance date bar (Reports, P&L, TopProducts, WarehouseReview).

| Name | What it does | Props/Inputs → Output | Calls / depends on |
|---|---|---|---|
| `FinanceInsights` | Grid of toned insight cards. | `{insights,title}` → section or `null` | — |
| `toInputDate` | Local-time `YYYY-MM-DD`. | date → string | — |
| `rangeLastDays` | Inclusive last-N-days range. | n → `{id,label,from,to}` | `toInputDate` |
| `rangePresets` | This month / last month / YTD / 7 / 30 / 90 days (browser-local time). | → array | above |
| `FinanceRangeBar` | Preset chips, from/to date inputs, "Last N days" + Apply, extra children. | `{from,to,onFrom,onTo,presets,activePreset,onPreset,children}` → toolbar | — |

### src/components/orders/AwaitingBostaActions.jsx
Purpose: pull an `awaiting_bosta_pickup` order back before the courier collects.

| Name | What it does | Props/Inputs → Output | Calls / depends on |
|---|---|---|---|
| `AwaitingBostaActions` | Buttons → Ready to ship / Out of stock / Pending (or Repaired shoe for repairs), each confirmed; warns the Bosta AWB may still be live. | `{order, role}` → `ContentSection` or `null` | `ordersApi.transition`; invalidates order/orders/order-state-counts/queue/pick-list; `Callout`, `useConfirmModal`, `useToast` |

### src/components/orders/BostaFinancialsBreakdown.jsx
Purpose: Bosta fee lines vs customer shipping (admin financials).

| Name | What it does | Props/Inputs → Output | Calls / depends on |
|---|---|---|---|
| `BostaFinancialsBreakdown` (default) | Total Bosta fees (+ per-line breakdown), customer shipping, "left after Bosta". | `{order,fallbackBostaFee,formatMoney,customerShipping}` → rows | `bostaFeeLines`, `resolveDisplayedBostaTotal` (utils/bostaFees), `bostaFeeNote` |

### src/components/orders/DelayActions.jsx
Purpose: schedule a callback date for pending / no-response orders.

| Name | What it does | Props/Inputs → Output | Calls / depends on |
|---|---|---|---|
| `todayCairoYmd` (local) | Cairo today `YYYY-MM-DD`. | — | `Intl` |
| `DelayActions` | Date (min today) + note → "Schedule callback"; shows current delay badge; link to Delayed list. | `{order, canEdit}` → block or `null` | `ordersApi.delay`; invalidates order/orders/queue; `formatDelayBadge` |

### src/components/orders/ExceptionActions.jsx
Purpose: cancel order, edit items (exchange / remove / add), convert failed delivery to return.

| Name | What it does | Props/Inputs → Output | Calls / depends on |
|---|---|---|---|
| `EXCHANGE_/REMOVE_/ADD_NOTE_TEMPLATES` | Quick-note chips. | — | — |
| `lineProduct`, `orderUnitCount` (local) | Line display data; total units. | — | `ProductCell` helpers |
| `VariantSearchPicker` (local) | Debounced (250 ms) variant search, list with "avail = real − onHold", selected preview. | `{value,onChange,excludeSku}` → picker | `inventoryApi.variants` |
| `ExceptionActions` | `mode` = all / cancel / exchange / retry. Cancel (reason + required note), Exchange (pick line → new variant + note), Remove (qty → units?1), Add (variant + qty + note), Convert to Return (`failed_delivery` → `returning_to_origin`). One shared error banner. | `{order, role, mode}` → block or `null` | `ordersApi.cancel/exchange/removeItem/addItem/transition`; invalidates order/orders/order-state-counts/queue/pick-list; `CANCELLATION_REASONS`, `useConfirmModal`, `useToast` |

### src/components/orders/LocalShippingActions.jsx
Purpose: manual local-courier lifecycle on order detail.

| Name | What it does | Props/Inputs → Output | Calls / depends on |
|---|---|---|---|
| `orderUnitCount`, `lineLabel` (local) | Units; line display (dup of ExceptionActions `lineProduct`). | — | `ProductCell` helpers |
| `LocalShippingActions` | Only for `shippingMethod==='local_shipping'`. Ready → Print Gazelle policy, Mark as Dispatched (`local_shipping`). In local_shipping → Delivered / Cancel (reason+note) / Partial delivery (per-line qty steppers) / Failed / Exchange. Failed delivery, delivered exchange/return collect → "Back from local shipping". | `{order, role}` → `ContentSection` or `null` | `ordersApi.transition/cancel/partialLocalDelivery/returnLocalShippingToStock`; `printGazelleShippingPolicy`; invalidates order/orders/order-state-counts/queue/on-hold-items; `LOCAL_SHIPPING_FEE`, `IconCheck/IconCancel` |

### src/components/orders/ManualOrderCatalogPicker.jsx
Purpose: catalog browser to add variants to a manual order (ManualOrderPage).

| Name | What it does | Props/Inputs → Output | Calls / depends on |
|---|---|---|---|
| `availableUnits`, `ProductThumb` (local) | real − onHold; 56px image/placeholder. | — | — |
| `ManualOrderCatalogPicker` | Submit-mode search + color/size filters, 12 products/page, expandable product rows listing in-stock variants with qty input and Add. | `{items, onAddVariant}` → picker; calls `onAddVariant({variantId,sku,title,imageUrl,color,size,label,quantity,unitSellingPrice,available})` | `inventoryApi.catalog/catalogFilters`; `FilterToolbar`, `FilterSelect`, `Pagination`, `ProductCell` |

### src/components/orders/MobileOrderCard.jsx
Purpose: mobile card for order lists (OrderListTable, ReturnsPage, FailedDeliveriesPage).

| Name | What it does | Props/Inputs → Output | Calls / depends on |
|---|---|---|---|
| `CreatorBadge`, `itemSummary` (local) | CREATOR badge; "SKU…qty +N … U units" / repair label. | — | — |
| `MobileOrderCard` | Full card (ref, badges, status, delay, customer, city/method/queue age, refund amount, return note, call link, collect total) or compact pending-refund variant (name, phone, amount, OM note, returned products). | `{order,onOpen,showPhone,showCod,showQueueAge,showShippingMethod,compactPendingRefund,badges,primaryAction,secondaryActions}` → card | `orderCollectTotal`, `resolveRefundAmount/resolveOrderManagerNote/returnedProductLines`, `orderCallPhone/orderDisplayName/telHref`, `OrderStatusBadge`, `OfferBadge`, `FrequentCancelFlag` |

### src/components/orders/OfferBadge.jsx
Purpose: offer badges.

| Name | What it does | Props/Inputs → Output | Calls / depends on |
|---|---|---|---|
| `OfferBadge` | "OFFER" badge (B1G1 / sale). | `{style}` → span | — |
| `LineOfferTag` | Per-line "B1G1" or "SALE … was X". | `{item}` → span or `null` | `formatMoney` |

### src/components/orders/OrderDetail.jsx (869 lines)
Purpose: the whole order detail page (rendered by `OrderDetailPage`).

| Name | What it does | Props/Inputs → Output | Calls / depends on |
|---|---|---|---|
| `OrderDetail` | Loads order, history, Bosta cities, customer (admin/OM only). **Stock review mode** (stock_manager on ready/repaired/awaiting-Bosta/OOS): read-only shipping + items + `WarehouseControls`. **Normal mode**: sticky `OrderJumpSearch` + `OrderQueueNavigator` (OM), header with ref/Shopify/Bosta chips and status/payment badges, `OrderLifecycleStrip`, tabbed Actions panel (Verify / Delay / Edit items / Cancel / Stock ready), `PendingRefundCard`, Customer & shipping card with inline edit (method + `ShippingAddressFields`), prior orders, repaired-shoe card, line items (table or mobile cards, warehouse stock, COGS for admin), return/exchange collect lines, `OrderDiscountPanel`, `OrderFinancialsSection` (admin); aside with `PickupActions`, `LocalShippingActions`, `WarehouseControls` (admin), `AwaitingBostaActions` (OM only), `OrderIntegrationPanel`, Bosta track link, `StatusTimeline`. After verify, auto-advances to next queue order. | `{orderId}` → page | `ordersApi.get/history/updateShipping`, `customersApi.get`, `useBostaCities`, `useIsMobile`, `useAuth`; utils `orderMeta`, `orderIds`, `shopifyContact`, `returnKind`, `integrations`, `orderLifecycle`; `goToNextConfirmOrder`, `resolveConfirmQueue` |
| `startEditAddress` / `saveAddressAndShipping` (inner) | Prefill address form (blanking Shopify placeholders); PATCH shipping + method. Toasts backend `warning` / `movedToBostaReturns` / `bostaUpdated`. | — | `addressMutation` |
| `handleVerified` (inner) | Navigate to next order in pending/no-response queue. | `{fromStatus}` | `goToNextConfirmOrder` |

### src/components/orders/OrderDiscountPanel.jsx
Purpose: % discount on merchandise + money breakdown (OM/admin on detail).

| Name | What it does | Props/Inputs → Output | Calls / depends on |
|---|---|---|---|
| `ORDER_DISCOUNT_PERCENTS` | `[5,10,15,20,25,30]`. | — | — |
| `OrderDiscountPanel` | Shows payment, merchandise, discount, goods, shipping, COD fee, Bosta fees, COD total; chips to apply/clear % while editable (status in EDITABLE, no Bosta shipment, not exchange/creator/return/repair). | `{order, canEdit}` → panel or `null` | `ordersApi.applyDiscount`; `moneyBreakdown`, `resolveBostaCourierFee`, `bostaFeeNote`; invalidates order/order-history/orders |

### src/components/orders/OrderFinancialsSection.jsx
Purpose: admin Financials card.

| Name | What it does | Props/Inputs → Output | Calls / depends on |
|---|---|---|---|
| `OrderFinancialsSection` (default) | Bosta breakdown, COGS snapshot, margin (or "No COGS snapshot"). | `{order, formatMoney, margin}` → `ContentSection` | `BostaFinancialsBreakdown`, `resolveBostaCourierFee` |

### src/components/orders/OrderIntegrationPanel.jsx
Purpose: Shopify / Bosta references on detail.

| Name | What it does | Props/Inputs → Output | Calls / depends on |
|---|---|---|---|
| `OrderIntegrationPanel` | Shopify label + "Open Admin" (admin, needs shop domain), Bosta tracking link, delivery id, shipment-job status/error (polled every 3 s while `order.bostaShipmentStatus` is queued/creating), delivered date. | `{order}` → `ContentSection` | `fulfillmentApi.shipmentStatus`, `shopifyApi.status`, `useAuth`, `bostaTrackingUrl` |

### src/components/orders/OrderJumpSearch.jsx
Purpose: sticky "find another order" search on detail.

| Name | What it does | Props/Inputs → Output | Calls / depends on |
|---|---|---|---|
| `OrderJumpSearch` | Search (limit 20): 0 → error toast; 1 → open it (keeps queue param); many → `/orders?search=`. | none → `FilterToolbar` | `ordersApi.list`, `resolveConfirmQueue`, `useToast` |

### src/components/orders/OrderLifecycleStrip.jsx
Purpose: compact lifecycle stepper.

| Name | What it does | Props/Inputs → Output | Calls / depends on |
|---|---|---|---|
| `OrderLifecycleStrip` | Steps for status+method with done/current classes. | `{status, shippingMethod, compact}` → `<nav><ol>` | `lifecycleStripStatuses`, `ORDER_STATUS_LABELS` |

### src/components/orders/OrderListTable.jsx (968 lines)
Purpose: generic order list used by Hub, List, Verify, No-response, OOS, By-state pages.

| Name | What it does | Props/Inputs → Output | Calls / depends on |
|---|---|---|---|
| `placedAtInRange` (local) | Cairo (+03:00) day-range check. | — | — |
| `readSeenLocalIds` / `writeSeenLocalIds` / `markLocalIdsSeen` / `isNewlyJoinedLocal` (local) | localStorage set (≤500 ids) for "NEW" badge on Local shipping list. | — | `localStorage` |
| `QueueAge`, `itemUnits`, `runSequential` (local) | Age badge (24/48 h); units; sequential per-id runner collecting ok/fail. | — | `queueAgeHours` |
| `BULK_ACTIONS` | Copy for bulk confirm / no_response / cancel. | — | — |
| `OrderListTable` | Builds `/orders` params from ~15 filter props, polls every 30 s, resets page on filter change; for kind/date filters fetches 500 and filters/paginates client-side. Desktop table (or special pending-refund table) / `MobileOrderCard`s. Selection + bulk bars: **verify** (confirm / no response / cancel via bulk endpoint) and **local shipping** (Delivered / Print manifest PDF / Exchange → Pending / Cancel with reason+note, run sequentially). | many props (`statusFilter`, `show*`, `bulkVerify`, `bulkLocalShipping`, …) → list | `ordersApi.list/bulkVerify/transition/cancel`, `printLocalShippingManifest`, `orderCollectTotal`, `pendingRefund` utils, `getReturnKind/ReturnKindBadge`, `ResponsiveTable`, `Pagination`, `useConfirmModal`, `useToast` |

### src/components/orders/OrderQueueNavigator.jsx
Purpose: Prev/Next through the verify / no-response queue.

| Name | What it does | Props/Inputs → Output | Calls / depends on |
|---|---|---|---|
| `resolveConfirmQueue` | Queue from `?queue=` or status if pending/no_response. | `(status, searchQueue)` → string/null | — |
| `queueHomePath` (local) | Verify list URL per queue. | — | — |
| `OrderQueueNavigator` | Fetches 100 orders of the queue, sorts oldest-first, Prev/Next buttons + swipe (≤56 px); "Not in current queue". | `{orderId, status}` → nav or `null` | `ordersApi.list`, `useNavigate`, `useSearchParams` |
| `goToNextConfirmOrder` | After verify: refetch queue (100), open oldest other order or go back to list; swallows errors. | `{navigate,queryClient,currentId,queue}` → `Promise<bool>` | `ordersApi.list` |

### src/components/orders/OrderStatusBadge.jsx
Purpose: status badge + shared money/date formatters (imported by ~39 files).

| Name | What it does | Props/Inputs → Output | Calls / depends on |
|---|---|---|---|
| `OrderStatusBadge` | Badge with variant per status. | `{status}` → span | `ORDER_STATUS_LABELS` |
| `formatMoney` | `en-EG` currency, 0 decimals; `…` for null. | `(amount, currency='EGP')` → string | `Intl` |
| `formatDate` | Medium date + short time; `…` for empty. | value → string | — |

### src/components/orders/OutOfStockActions.jsx
Purpose: send an `out_of_stock` order back to Ready to ship.

| Name | What it does | Props/Inputs → Output | Calls / depends on |
|---|---|---|---|
| `OutOfStockActions` | Explanation + confirmed "Back to Ready to ship". | `{order}` → block or `null` | `ordersApi.transition`; invalidates order/orders/pick-list/order-state-counts/queue |

### src/components/orders/OutOfStockLinePicker.jsx
Purpose: per-line OOS dialog used by FulfillmentPage.

| Name | What it does | Props/Inputs → Output | Calls / depends on |
|---|---|---|---|
| `OutOfStockLinePicker` | Each line: In stock / Out of stock / Zero (wrong); requires ≥1 OOS, or a Zero plus a Keep, for multi-line orders. | `{open,order,loading,onCancel,onConfirm}` → dialog; `onConfirm({lines:[{itemId,variantId,action}]})` | `ProductCell` (no API; parent submits) |

### src/components/orders/PendingRefundCard.jsx (451 lines)
Purpose: refund banner on detail … pending admin payout, paid summary, or OM note.

| Name | What it does | Props/Inputs → Output | Calls / depends on |
|---|---|---|---|
| `RETURN_REASON_LABELS`, `PAYMENT_METHOD_LABELS` | Label maps. | — | — |
| `PendingRefundCard` (named + default) | 3 cases: `refundPaid` → paid summary; status → `pending_refund` → OM note callout (if any); `pending_refund` → amount, customer, phone (Copy / Call), reason, OM note, and (admin only) "Confirm refund paid" form (amount, method, reference, note) or "Reject" form (required reason). | `{order, user, onUpdated}` → `Callout` or `null` | `ordersApi.confirmRefundPaid`; invalidates orders/order/order-state-counts/returns-hub-tab-counts/queue…; `resolveRefundAmount`, `resolveOrderManagerNote`, `telHref`, `navigator.clipboard` |

### src/components/orders/PickupActions.jsx
Purpose: customer store-pickup handoff and "Back from pickup".

| Name | What it does | Props/Inputs → Output | Calls / depends on |
|---|---|---|---|
| `PickupActions` | For `shippingMethod==='pickup'`: Ready → Print Gazelle policy + Confirm pickup (delivered, or Back from pickup for refunds); delivered exchange → "Collect received → Back from pickup"; `back_from_pickup` → waiting note. | `{order, role}` → `ContentSection` or `null` | `fulfillmentApi.pickPack`, `ordersApi.returnPickupToStock`, `printGazelleShippingPolicy`; invalidates order/orders/order-state-counts/queue/pick-list |

### src/components/orders/RepairOrderForm.jsx
Purpose: create a repaired-shoe (no-stock) order from ManualOrderPage.

| Name | What it does | Props/Inputs → Output | Calls / depends on |
|---|---|---|---|
| `REPAIR_METHODS` | pickup / bosta / local_shipping with hints. | — | — |
| `RepairOrderForm` | Shoe name, all-in total, note, source, method chips, address (if shipping); validates; creates; admin → Fulfillment repair tab, others → new order. Sticky submit on mobile. | `{customerFields,customer,address,setAddress,bostaCities,manualSource,setManualSource,isMobile}` → form | `ordersApi.createRepair`, `ShippingAddressFields`, `StickyActionBar`, `MANUAL_ORDER_SOURCES` |

### src/components/orders/ShippingAddressFields.jsx
Purpose: city → area → street fields (manual order, repair, detail edit).

| Name | What it does | Props/Inputs → Output | Calls / depends on |
|---|---|---|---|
| `cityRecord`, `districtLabel` (local) | Match Bosta city by name/nameAr/alias; district label. | — | — |
| `ShippingAddressFields` | Optional name/phone; Bosta city select or text; Bosta district search (datalist + suggestion buttons) or local-courier zone select with "Other" free text; street + apartment. | `{address,setAddress,bostaCities,useBostaCitySelect,localZoneSelect,showNamePhone}` → fields | `useBostaDistricts`, `LOCAL_SHIPPING_ZONES`, `isKnownLocalShippingZone` |

### src/components/orders/StatusTimeline.jsx
Purpose: status history list.

| Name | What it does | Props/Inputs → Output | Calls / depends on |
|---|---|---|---|
| `StatusTimeline` | `toStatus from fromStatus`, time, source, note (raw status keys with `_`?space). | `{entries}` → `<ul>` or "No status history yet." | `formatDate` |

### src/components/orders/VerificationPanel.jsx
Purpose: call-outcome form for pending / no-response orders.

| Name | What it does | Props/Inputs → Output | Calls / depends on |
|---|---|---|---|
| `VerificationPanel` | Editable name/phone/street (Save contact, Call = save then `tel:`), quick-note chips, shipping method (limited for return/exchange), outcome (select or mobile button grid), note (required for cancel); blocks "confirmed" when Shopify contact incomplete; mobile `StickyActionBar`. On confirmed / no_response calls `onVerified`. | `{order, canEdit, embed, onVerified}` → block or `null` | `ordersApi.verify`, `ordersApi.updateShipping`; `VERIFICATION_OUTCOMES`, `VERIFICATION_NOTE_TEMPLATES`, `shopifyContact` utils; invalidates order/orders/order-state-counts/queue/pick-list(/customer) |

### src/components/orders/WarehouseControls.jsx
Purpose: stock "Orders review" controls (reprint / back to Fulfillment).

| Name | What it does | Props/Inputs → Output | Calls / depends on |
|---|---|---|---|
| `WarehouseControls` | Admin/stock only. Reprint Gazelle policy (local/pickup) or Bosta AWB (opens placeholder window first, then prepares AWB PDF); "Back to Fulfillment" from awaiting Bosta / OOS / local shipping. | `{order, role}` → `ContentSection` or `null` | `fulfillmentApi.prepareAwb`, `ordersApi.transition`, `printGazelleShippingPolicy`, `openBostaPolicyPlaceholder/openBostaPolicyPrint` |

### src/components/ui/Callout.jsx
| Name | What it does | Props/Inputs → Output | Calls / depends on |
|---|---|---|---|
| `Callout` | Variant box with optional title (`role=note`). Does not accept `style`. | `{variant,title,children,className}` → div | — |

### src/components/ui/ContentSection.jsx
| Name | What it does | Props/Inputs → Output | Calls / depends on |
|---|---|---|---|
| `ContentSection` (named + default) | Card section with h2 title, subtitle, actions slot. | `{title,subtitle,actions,children,className,flush}` → `<section>` | — |

### src/components/ui/DataCard.jsx
| Name | What it does | Props/Inputs → Output | Calls / depends on |
|---|---|---|---|
| `DataCard` | Mobile card (button if clickable) with title, subtitle, badges, `<dl>` rows, actions. | `{title,subtitle,badges,rows,actions,onClick,className}` → button/div | — |

### src/components/ui/FilterToolbar.jsx
| Name | What it does | Props/Inputs → Output | Calls / depends on |
|---|---|---|---|
| `FilterSelect` | Select with "All" placeholder; accepts string or `{value,label}` options. | `{id,label,value,onChange,options,placeholder,className}` → select | — |
| `FilterToolbar` | Search input (live or submit-on-Enter/Search button), filter children, "Clear N". Optional sticky. | `{search,onSearchChange,onSearchSubmit,searchSubmitMode,searchLabel,searchPlaceholder,searchId,activeCount,onClear,sticky,children}` → `role=search` div | `SearchInput` |

### src/components/ui/FullScreenSheet.jsx
| Name | What it does | Props/Inputs → Output | Calls / depends on |
|---|---|---|---|
| `FullScreenSheet` | Modal sheet; locks body scroll; backdrop/Close button call `onClose`. | `{open,onClose,title,children}` → dialog or `null` | — |

### src/components/ui/PageHeader.jsx
| Name | What it does | Props/Inputs → Output | Calls / depends on |
|---|---|---|---|
| `PageHeader` | Back link, icon, h1, actions, subtitle/hint, meta, children. | `{title,subtitle,hint,meta,icon,backTo,backLabel,actions,children}` → header | `AppIcon`, `Link` |

### src/components/ui/ProductCell.jsx
| Name | What it does | Props/Inputs → Output | Calls / depends on |
|---|---|---|---|
| `ProductCell` | Image (falls back on error) + title + "SKU:" + meta. | `{imageUrl,title,sku,meta,size}` → div | — |
| `productImageFromVariant` / `productTitleFromVariant` / `variantMeta` | Pull image/title from populated variant/product; "color … Size N". | variant → string | — |

### src/components/ui/ResponsiveTable.jsx
| Name | What it does | Props/Inputs → Output | Calls / depends on |
|---|---|---|---|
| `ResponsiveTable` | Mobile → card list, desktop → table. | `{table,mobileCards,className}` → node | `useIsMobile` |

### src/components/ui/SearchInput.jsx
| Name | What it does | Props/Inputs → Output | Calls / depends on |
|---|---|---|---|
| `SearchInput` | `type=search` with icon and … clear (fakes `{target:{value:''}}`). | `{value,onChange,placeholder,label,ariaLabel,id,className,onKeyDown}` → div | `IconSearch` |

### src/components/ui/SimpleDataTable.jsx
| Name | What it does | Props/Inputs → Output | Calls / depends on |
|---|---|---|---|
| `SimpleDataTable` | Column-config table; mobile uses col0 as title, col1 subtitle, rest as rows. | `{columns,rows,rowKey,onRowClick,emptyMessage,emptyTitle}` → table/cards | `ResponsiveTable`, `DataCard`, `EmptyState` |

### src/components/ui/StatCard.jsx
| Name | What it does | Props/Inputs → Output | Calls / depends on |
|---|---|---|---|
| `StatCard` | Metric card (label/value/subvalue/hint), optional link + accent. | `{label,value,subvalue,hint,to,accent}` → Link/div | — |

### src/components/ui/StickyActionBar.jsx
| Name | What it does | Props/Inputs → Output | Calls / depends on |
|---|---|---|---|
| `StickyActionBar` | Bottom sticky toolbar (mobile CTAs); `null` if no children. | `{children,className}` → div | — |

### src/components/ui/icons.jsx (524 lines)
| Name | What it does | Props/Inputs → Output | Calls / depends on |
|---|---|---|---|
| `Svg` (local) | 24…24 stroke SVG wrapper, `aria-hidden`. | — | — |
| `Icon*` (~48 exports: Dashboard, Orders, Queue, Check, Truck, Returns, Bell, Search, Cancel, …) | Static inline icons. | `{size}` → svg | `Svg` |
| `AppIcon` | Lookup by name (fallback `IconOrders`). | `{name,size}` → svg | `ICON_BY_NAME` |
| `NavIcon` | Name or route-path fallback map. | `{name,path}` → span | `PATH_ICON_FALLBACK` |
| `BottomTabIcon` | `AppIcon` at 22px. | `{name,size}` | — |

### src/styles/* (summary)
`src/styles/global.css` is the only stylesheet (5,176 lines, 24 `@media` blocks). It defines the design tokens in `:root` (`--color-*` warm neutral palette with a yellow `--color-accent`, borders, sidebar colours), base element styles, and hand-written utility classes (`row`, `stack`, `grid-2`, `btn*`, `badge*`, `input/select/textarea`, `card`, `data-table`). Then come sections for the app shell/sidebar, brand logo, toasts, integration panels, product catalog, search field, filter toolbar, stat cards, callouts, the order lifecycle strip, empty/loading states, login, notifications, fulfillment workflow / scan panel / step strip, order list and line-item layouts, status badges, order-detail grid, mobile overrides (sticky action bar, full-screen sheet, mobile order cards), dashboard charts, the executive dashboard, and finance insights. Components often add inline `style={{…}}` on top, and some refer to tokens that are not defined (`--color-muted`, `--color-primary`), so only their hard-coded fallbacks apply.

---

## Key UI flows covered by components

- **Order verification (call outcomes):** `OrderDetail` shows the Verify / Call again tab for OM/admin when status is `pending_verification` or `no_response`. That tab renders `VerificationPanel`: fix contact info, Save & Call, pick shipping method, then choose an outcome (confirmed → Ready to ship, no_response, customer_cancelled with required note, …) via `ordersApi.verify`. On success, `goToNextConfirmOrder` opens the next oldest order. `OrderQueueNavigator` gives Prev/Next and swipe; `OrderJumpSearch` jumps to any order. `DelayActions` schedules a callback date. From lists, `OrderListTable` with `bulkVerify` runs bulk confirm / no response / cancel.
- **Order detail page and action panels:** `OrderDetail` (layout, header badges, address edit with `ShippingAddressFields`, line items, return collect lines) plus the tabbed Actions panel: `VerificationPanel`, `DelayActions`, `ExceptionActions` (mode `exchange` = edit items: exchange/remove/add; mode `cancel`), and `OutOfStockActions`. The aside holds `PickupActions`, `LocalShippingActions`, `WarehouseControls` (admin), `AwaitingBostaActions` (orders_manager), `OrderIntegrationPanel`, and `StatusTimeline`. `OrderDiscountPanel` and `OrderFinancialsSection` / `BostaFinancialsBreakdown` show money. `OrderLifecycleStrip` shows progress.
- **Pickup / local / Bosta actions:** `PickupActions` handles store pickup (print Gazelle A5 policy, confirm pickup with `fulfillmentApi.pickPack`, Back from pickup). `LocalShippingActions` covers the local courier (dispatch, delivered, partial delivery, failed, cancel, exchange, collect bag back → `back_from_local_shipping`). `OrderListTable` with `bulkLocalShipping` adds bulk Delivered / manifest PDF / Exchange → Pending / Cancel. For Bosta: `AwaitingBostaActions` pulls back an order before courier pickup, `WarehouseControls` reprints the Bosta AWB or sends the order back to Fulfillment, and `OrderIntegrationPanel` polls the shipment job. `OutOfStockLinePicker` is the per-line OOS dialog used by the Fulfillment page.
- **Returns & refunds:** `PendingRefundCard` shows the pending admin payout form (confirm paid / reject via `ordersApi.confirmRefundPaid`), the paid summary, or the OM return note. `OrderListTable` has a dedicated pending-refund table, and `MobileOrderCard` a `compactPendingRefund` variant. `ExceptionActions` mode `retry` (failed_delivery → returning_to_origin) exists but is not reachable (see Issues). Return collect lines on detail use `incomingReturnLines`.
- **Exchanges:** In-order item edits are in `ExceptionActions` (`VariantSearchPicker`, exchange/remove/add). Exchange/return orders get badges and "Collect from customer" lines in `OrderDetail`. Collect-back flows are in `LocalShippingActions` (`markDeliveredCollectBack`, `sendToPendingForExchange`) and `PickupActions` (Back from pickup). `ExchangeSkuChart` / `ExchangeSizeChart` cover analytics.
- **Warehouse controls:** `WarehouseControls` (stock review mode in `OrderDetail` plus the admin aside), `OutOfStockActions`, `AwaitingBostaActions`, `OutOfStockLinePicker`.
- **Mobile cards / sticky bars:** `MobileOrderCard`, `ResponsiveTable`, `SimpleDataTable`?`DataCard`, `StickyActionBar` (VerificationPanel, RepairOrderForm, ManualOrderPage), `FullScreenSheet` (Fulfillment/Returns pages), the mobile outcome grid in `VerificationPanel`, `OrderDetail`'s `has-sticky-actions` with sticky jump search + queue navigator, and swipe navigation in `OrderQueueNavigator`.

---

## Issues spotted (components)

### Dead / unreachable code
- `src/components/finance/FinanceCharts.jsx:1-181`: the whole file is unused; no file imports it.
- `src/components/dashboard/DashboardCharts.jsx`: six exports are never imported: `OrdersRevenueTrendChart` (:65), `PaymentMixChart` (:136), `ChannelMixChart` (:163), `ReturnsPaymentChart` (:189), `StatusBarsChart` (:239, which also has a hard-coded subtitle "Orders from 20 Jul 2026" at :249), and `ReturnsKindChart` (:267). The default-export object (:507) is also unused.
- `src/components/orders/OrderDetail.jsx`: the only roles are admin, orders_manager and stock_manager, and `isOM` already includes admin. That makes three branches unreachable: `!isOM && needsVerify && !isStock` (:434), `!isOM && isOutOfStock` (:835), and `{!isOM && <ExceptionActions … />}` (:840). As a result, `ExceptionActions` in mode `all`/`retry` never renders, so the "Convert to Return" action for `failed_delivery` (`ExceptionActions.jsx:531-553`) cannot be reached from the UI. Also, `(isOM || isAdmin)` at :306 is redundant.
- `src/components/orders/PickupActions.jsx:92-95`: the `!canAct` branch sits inside `showReadyActions`, which already requires `canAct` (:24), so it can never show.
- `src/components/orders/AwaitingBostaActions.jsx:17,66-69`: `canAct` includes stock_manager and there is a `!canAct` message, but `OrderDetail.jsx:846` renders this component only for `orders_manager`. Admins never see it, and the stock/denied branches are dead.
- Exported but unused outside their own file: `isFrequentCanceller` (`FrequentCancelFlag.jsx:4`), `isVipCustomer/isGreenCustomer/isRedCustomer` (`CustomerSegmentBadges.jsx:11-30`), `ORDER_DISCOUNT_PERCENTS` (`OrderDiscountPanel.jsx:8`), `rangeLastDays` (`FinanceInsights.jsx:36`).

### Duplicated logic (money / COD / helpers)
- **Prepaid rule differs:** `OrderDiscountPanel.jsx:33-36` treats `onlinePaidAt` as prepaid, but `utils/policyMoney.js:11-13` (used for `codTotal` at :37) does not. The panel can therefore say "Paid online (Bosta COD = 0)" while showing a non-zero COD. `OrderDetail.jsx:414-430` re-derives the payment/COD badge a third time instead of calling `moneyBreakdown`.
- **Two different Bosta fee numbers on one page:** `OrderDiscountPanel.jsx:97` uses `order.bostaCourierFee ?? resolveBostaCourierFee(order)`, while `BostaFinancialsBreakdown.jsx:10` (admin Financials on the same page) uses `resolveDisplayedBostaTotal(order, fallback)`.
- **Merchandise base differs:** `OrderDiscountPanel.jsx:26-29` uses `merchandiseSubtotal` or `total + discount`, while `moneyBreakdown` (`policyMoney.js:39-41`) sums the line items.
- **Refund amount differs:** `OrderListTable.jsx:684-687` and `MobileOrderCard.jsx:123-126` use `order.refundAmount || order.exchangeCreditAmount`, while the pending-refund table/card in the same files and `PendingRefundCard.jsx:37` use `resolveRefundAmount()`.
- **Customer name/phone differ:** `PendingRefundCard.jsx:108-109` reads `customerId.fullName/phone` directly, bypassing `orderDisplayName/orderCallPhone` (with their placeholder handling) that every other component uses.
- **Three EGP formatters:** `OrderStatusBadge.jsx:33`, `FinanceCharts.jsx:40`, `DashboardCharts.jsx:56`.
- **Unit count implemented 5 times:** `ExceptionActions.jsx:43`, `LocalShippingActions.jsx:18`, `OrderListTable.jsx:83`, `MobileOrderCard.jsx:23`, `OrderDetail.jsx:173`. `lineLabel` (`LocalShippingActions.jsx:22`) is a copy of `lineProduct` (`ExceptionActions.jsx:33`).
- **Status lists duplicated:** "editable / cancellable" status arrays are repeated in `OrderDetail.jsx:128,133,151,299`, `ExceptionActions.jsx:134`, and `OrderDiscountPanel.jsx:10`.
- **Print-policy block copied 4…:** `LocalShippingActions.jsx:333`, `PickupActions.jsx:101,155`, `WarehouseControls.jsx:83`.
- **Constant defined twice:** `FREQUENT_CANCEL_THRESHOLD` in `FrequentCancelFlag.jsx:2` and `CustomerSegmentBadges.jsx:3`.
- **Cairo date formatting repeated, and inconsistent:** `DelayActions.jsx:8,22` and `AnalyticsDateControls.jsx:3` use Cairo time, but `FinanceInsights.jsx:27-68` presets use the browser's local timezone.
- **Shopify admin URL built by hand:** `OrderIntegrationPanel.jsx:50` duplicates `shopifyAdminOrderUrl` (`utils/integrations.js:6`).
- **Inconsistent warning handling on the same endpoint:** `VerificationPanel.jsx:67-76` (`updateShipping`) ignores `res.warning`, while `OrderDetail.jsx:90` toasts it.

### Very large components (line counts)
- `OrderListTable.jsx` 968, `OrderDetail.jsx` 869, `LocalShippingActions.jsx` 638, `ExceptionActions.jsx` 563, `icons.jsx` 524 (static), `DashboardCharts.jsx` 522, `PendingRefundCard.jsx` 451 (mostly inline styles), `src/styles/global.css` 5,176.
- `OrderListTable` mixes fetching, client-side filtering, localStorage "seen" tracking, two bulk workflows, and two table layouts in one function.

### Error handling / data correctness
- `NotificationBell.jsx:43-57`: `markRead` and `markAll` have no `onError`, so failures are silent.
- `PendingRefundCard.jsx:74-78`: the `navigator.clipboard.writeText` promise is not awaited, so the "copied" toast shows even if the copy failed or the clipboard API is missing.
- `ExceptionActions.jsx:172-216`: the five mutations have no `onError`. They rely on one shared banner (:555) that shows whichever error is first and stays visible after switching sub-tabs.
- `OrderQueueNavigator.jsx:131-149`: `goToNextConfirmOrder` swallows all errors (`catch { return false }`), and `OrderDetail.jsx:311-319` ignores the result.
- `OrderQueueNavigator.jsx:36,135`: fetches `limit: 100` from `/orders`, whose default sort is `placedAt: -1` (backend `order.service.js:2901`), then sorts "oldest first" on the client. For queues over 100 orders, the oldest orders are never reached by Next or auto-advance, and they show "Not in current queue".
- `OrderListTable.jsx:28,175`: kind/date filters fetch up to 500 rows and filter client-side. Matches beyond 500 are silently dropped, and the 500-row query re-polls every 30 s (:196).
- `OrderIntegrationPanel.jsx:25`: the 3 s polling interval depends on the `order.bostaShipmentStatus` prop, which this query never refreshes. Polling continues until something else refetches the order. Shipment-query errors are not shown.
- `VerificationPanel.jsx:30-40`: the reset effect depends on the `order.shippingAddress` and `order.customerId` objects. "Save contact" changes them (refetch after invalidate at :70), which wipes the outcome and note the caller already entered.
- `AnalyticsDateControls.jsx:113-130`: custom range has no check that from → to.

### Role checks (UI vs backend)
- Every UI-gated order action I checked is also enforced by backend `requireRoles` in `Gazelle-back/src/routes/orders.routes.js`, e.g. `confirm-refund-paid` is admin only (:66-69), and transition limits stock users in `orders.controller.js:479-497`. I found no role check that exists only in the UI.
- UI and backend role sets diverge in places:
  - `PickupActions.jsx:19` excludes stock_manager, but `pickup-return-to-stock` allows it (routes :51-54), and the copy at :94 says "warehouse or orders staff".
  - `AwaitingBostaActions.jsx:17` would offer stock_manager Out of stock / Pending moves that the backend rejects with 403 (controller :480).

### Accessibility gaps
- `ConfirmModal.jsx:7-45`, `OutOfStockLinePicker.jsx:48-63`, `FullScreenSheet.jsx:16`: no Escape-to-close, no focus move/trap, no `aria-labelledby`. `NotificationBell.jsx:59-66` closes on outside mousedown only (no Escape).
- `Toast.jsx:26-31`: toasts are clickable `div`s (not keyboard reachable), and error toasts use `aria-live="polite"`.
- `MobileOrderCard.jsx:96-152`: the main `<button>` contains an `<a href="tel:">` (:134), i.e. interactive content inside a button, plus block elements (`<ul>` at :73). `DataCard.jsx:5-30` renders `<div>`/`<dl>` inside a `<button>`.
- Many `<label>`s are not tied to their control (no `htmlFor`/nesting): `ExceptionActions.jsx:230,239,309,346,354,394,419,480,484,495`, `VerificationPanel.jsx:195,213,237`, `DelayActions.jsx:57,67`, `RepairOrderForm.jsx:100,110,126,140,148`. `PendingRefundCard` does this correctly.
- `OrderDetail.jsx:324-336` and `ExceptionActions.jsx:275-305` use `role="tab"` without a `tabpanel`, `aria-controls`, or arrow-key handling. `OrderLifecycleStrip.jsx:21` has no `aria-current` on the current step.
- `PickupActions.jsx:191` passes `style` to `Callout`, which ignores it.

### Half-finished / leftover code
- `OrderFinancialsSection.jsx:5-8`: the docblock is a leftover integration instruction ("Import into OrderDetail.jsx and render when showFinancials is true").
- `StatusTimeline.jsx:13-15`: shows raw status keys (`returned_awaiting_receipt` → "returned awaiting receipt") instead of `ORDER_STATUS_LABELS` like the rest of the UI.
- `LocalShippingActions.jsx:282`: the ready callout always quotes `LOCAL_SHIPPING_FEE`, even when the order's `shippingFee` (used in the subtitle at :144/:266) is different.
- `OrderDiscountPanel.jsx:89-96` and `OrderFinancialsSection` both render Bosta fee rows on the admin detail page, with different formulas (see Duplicated logic).
