# Gazelle frontend — app shell, API, auth, hooks, utils, pages

Repo: `Gazelle-fron` (React 19.2, Vite 8, React Router 7.18, TanStack Query 5.101, recharts 2.15, html5-qrcode). The backend is a separate Express API reached at `VITE_API_BASE || '/api/v1'`. In dev, Vite proxies `/api` to `http://localhost:4000`.

Role abbreviations: **A** = admin, **O** = orders_manager, **S** = stock_manager.

---

## Frontend app shell, API, auth, hooks, utils, pages: function-by-function

### package.json
Scripts and dependencies.

| Name | What it does | Inputs → Outputs | Calls / depends on |
|---|---|---|---|
| `scripts.dev/build/preview` | Vite dev server, production build, preview | — | vite |
| `scripts.lint` | `eslint .` | — → currently 23 errors and 12 warnings in scope | eslint.config.js |
| `scripts.test` | `node --test src/utils/*.test.js`, which covers utils only | — | node:test |
| deps | react/react-dom 19.2, react-router-dom ^7.18, @tanstack/react-query ^5.101, recharts ^2.15, html5-qrcode | — | — |

### vite.config.js
Build and dev configuration.

| Name | What it does | Inputs → Outputs | Calls / depends on |
|---|---|---|---|
| `server.proxy['/api']` | Proxies the API to localhost:4000 in dev | — | — |
| `build.rollupOptions.output.manualChunks` | Splits vendor chunks: recharts, scanner (html5-qrcode), react-query, react-router, react-vendor | module id → chunk name | — |

### eslint.config.js
Flat ESLint config.

| Name | What it does | Inputs → Outputs | Calls / depends on |
|---|---|---|---|
| default export | js recommended, react-hooks (recommended), react-refresh (vite); ignores `dist` | — | eslint plugins |

### index.html
SPA host page.

| Name | What it does | Inputs → Outputs | Calls / depends on |
|---|---|---|---|
| `<head>` | PWA/apple meta tags, theme colour, Plus Jakarta Sans font | — | Google Fonts |
| `#root` + script | Mounts `/src/main.jsx` | — | main.jsx |

### src/main.jsx
Entry point.

| Name | What it does | Inputs → Outputs | Calls / depends on |
|---|---|---|---|
| module body | `createRoot(#root).render(<StrictMode><App/></StrictMode>)` | — → DOM | App, styles/global.css |

### src/App.jsx
Providers and the full route tree.

| Name | What it does | Inputs → Outputs | Calls / depends on |
|---|---|---|---|
| `queryClient` | QueryClient defaults: staleTime 45s, gcTime 10m, retry 1, refetchOnWindowFocus false | — | @tanstack/react-query |
| `RoleRedirect` | Index route that sends the user to `DEFAULT_ROUTES[user.role]` | — → `<Navigate>` | useAuth, roleConfig |
| `App` | QueryClientProvider > ToastProvider > AuthProvider > BrowserRouter > Suspense(LoadingState) > Routes. `/login` is wrapped in GuestRoute. The shell route is ProtectedRoute(A,O,S) > ErrorBoundary > AppShell, and each child route has its own ProtectedRoute(roles). Also defines legacy redirects | — → app tree | lazyPages, ProtectedRoute/GuestRoute, AppShell, ErrorBoundary, Toast |

### src/routes/lazyPages.js
Lazy page registry.

| Name | What it does | Inputs → Outputs | Calls / depends on |
|---|---|---|---|
| `lazyPage(importFn, exportName)` | `React.lazy` wrapper that maps a named export to a default export | import fn, name → lazy component | React.lazy |
| ~45 exported lazy pages | One per page. `AdminDashboard` maps to `AdminDashboardMonthlyOverview.jsx` | — | pages/** |
| `VerificationQueuePage`, `NoResponseQueuePage`, `DelayedOrdersPage`, `OutOfStockQueuePage`, `FailedDeliveriesPage` | Exported (lines 54-58) but never imported anywhere, so dead | — | legacy pages |

### src/layouts/AppShell.jsx
Authenticated layout: sidebar, mobile drawer, bottom nav, header.

| Name | What it does | Inputs → Outputs | Calls / depends on |
|---|---|---|---|
| `NavItem` | NavLink with an optional badge count | `{item, counts, onNavigate}` → link | getBadgeCount |
| `bottomTabActive(path, pathname)` | Decides whether a bottom tab is active (prefix match) | strings → bool | — |
| `BottomNav` | Mobile bottom tabs from `BOTTOM_NAV[role]`; "More" opens the drawer | `{role, onMore}` → nav | roleConfig |
| `initialsFromName` | Builds avatar initials | name → string | — |
| `SidebarContent` | Renders `NAV_SECTIONS[role]`, the user card and the sign-out button | `{user, counts, onNavigate, onLogout}` → aside | NavItem |
| `AppShell` | Layout with mobile drawer state, NotificationBell, refresh button (`counts.refresh()`) and `<Outlet/>`. Sign out calls `logout()` then navigates to `/login` | — → layout | useAuth, useQueueCounts, usePauseWhenIdle, useIsMobile, NotificationBell |

### src/auth/roleConfig.js
Role constants, navigation and order vocabularies.

| Name | What it does | Inputs → Outputs | Calls / depends on |
|---|---|---|---|
| `ROLES`, `ROLE_LABELS` | Role ids and display labels | — | — |
| `DEFAULT_ROUTES` | Landing route per role: A → `/admin/dashboard`, O → `/orders/verify`, S → `/orders/warehouse` | — | App, LoginPage, ProtectedRoute |
| `VERIFICATION_NOTE_TEMPLATES` | Canned verification notes | — | VerificationPanel |
| `NAV_SECTIONS` | Sidebar sections per role, with optional `badgeKey` | — | AppShell |
| `BOTTOM_NAV` | Mobile tabs per role | — | AppShell |
| `NAV_BY_ROLE` | Marked @deprecated (line 155). Unused | — | — |
| `ORDER_STATUS_LABELS` | Status id → label | — | everywhere |
| `VERIFICATION_OUTCOMES`, `CANCELLATION_REASONS`, `ADJUSTMENT_REASONS`, `RISK_FLAGS` | Option lists for forms | — | components |

### src/auth/AuthContext.jsx
Auth state provider.

| Name | What it does | Inputs → Outputs | Calls / depends on |
|---|---|---|---|
| `AuthProvider` | Initial `user` comes from localStorage (`getStoredUser`). `loading` starts true when a token exists. On mount it calls `refreshUser` | children → context | api/client |
| `refreshUser` | `authApi.me()` and stores the returned user. On any error it clears the token and user | — → Promise | authApi.me |
| `login(email, password)` | `authApi.login`, then stores the token and user | creds → user | authApi.login, setToken, setStoredUser |
| `logout()` | Clears the token and user | — | setToken(null) |
| `useAuth()` | Reads the context; throws when used outside the provider | — → `{user, loading, login, logout, refreshUser}` | — |

### src/auth/ProtectedRoute.jsx
Client-side route guards.

| Name | What it does | Inputs → Outputs | Calls / depends on |
|---|---|---|---|
| `ProtectedRoute` | Shows a spinner while loading. Sends users without a session to `/login`. Sends users whose role is not in `roles` to their default route | `{children, roles}` → children or `<Navigate>` | useAuth, DEFAULT_ROUTES |
| `GuestRoute` | Redirects a logged-in user to their default route | `{children}` | useAuth |

### src/api/client.js
Single fetch wrapper plus endpoint namespaces (325 lines). Full route list is in "API client map" below.

| Name | What it does | Inputs → Outputs | Calls / depends on |
|---|---|---|---|
| `API_BASE` | `VITE_API_BASE || '/api/v1'` | — | env |
| `queryString(params)` | Builds `?a=b`, dropping undefined, null and '' values | object → string | URLSearchParams |
| `getToken/setToken` | localStorage key `gazelle_token` | — | localStorage |
| `getStoredUser/setStoredUser` | localStorage key `gazelle_user` (JSON); the parse is unguarded | — | localStorage |
| `ApiError` | Error subclass carrying `status` | (message, status) | — |
| `api(path, {method, body, token})` | JSON fetch with a Bearer header. Network failure throws `ApiError(…, 0)` "Connection lost…". A non-OK response throws `ApiError(data.error || fallback, status)`, where 502/503 fall back to "Save timed out…" | → parsed JSON | fetch |
| `downloadApiFile(path, filename, {method, body})` | Authenticated blob download through a temporary `<a download>` | → void | fetch |
| `authApi`, `ordersApi`, `customersApi`, `inventoryApi`, `productsApi`, `reportsApi`, `usersApi`, `settingsApi`, `shopifyApi`, `integrationsApi`, `notificationsApi`, `fulfillmentApi`, `referenceApi`, `manufacturingApi`, `accountingApi`, `hrApi` | Thin endpoint wrappers | args → Promise<JSON> | api / downloadApiFile |

### src/hooks/useQueueCounts.js
Sidebar badge counts.

| Name | What it does | Inputs → Outputs | Calls / depends on |
|---|---|---|---|
| `fetchReturnsLaneTotals()` | Fires 6 parallel `ordersApi.list({status, limit:1})` calls and sums `total` per returns lane | — → counts | ordersApi.list |
| `useQueueCounts()` | Runs `['queue','order-state-counts']` (refetch every 120s), `['queue','returns-lane-counts']`, and `['queue','stock-counts']` (A and S only). Derives verifyQueue, warehouseOrders, shippingOrders, returnsOther, readyToShip, pendingRefund, returningToOrigin, lowStock, discrepancies, and returns a `refresh()` | — → counts object | ordersApi.stateCounts, inventoryApi.queueCounts, useAuth |
| `getBadgeCount(key, counts)` | Looks up a badge value | → number | — |

### src/hooks/usePauseWhenIdle.js
Stops background refetching after inactivity.

| Name | What it does | Inputs → Outputs | Calls / depends on |
|---|---|---|---|
| `usePauseWhenIdle(idleMs = 15 min)` | Listens to activity events. After the idle timeout it calls `focusManager.setFocused(false)`, and restores it on the next activity, so the Render free instance can sleep | — → void | @tanstack focusManager |

### src/hooks/useIsMobile.js
| Name | What it does | Inputs → Outputs | Calls / depends on |
|---|---|---|---|
| `useIsMobile(breakpoint = 768)` | matchMedia listener | → bool | window.matchMedia |

### src/hooks/useBostaCities.js
| Name | What it does | Inputs → Outputs | Calls / depends on |
|---|---|---|---|
| `useBostaCities()` | Query `['bosta-cities']`, staleTime 1h | → query | referenceApi.bostaCities |
| `useBostaDistricts(cityId)` | Query `['bosta-districts', cityId]`, enabled when cityId is set | → query | referenceApi.bostaDistricts |

### src/utils/bostaFees.js
| Name | What it does | Inputs → Outputs | Calls / depends on |
|---|---|---|---|
| `bostaFeeLines(order)` | Bosta fee breakdown lines (shipping, open-package, VAT, …) | order → lines[] | — |
| `resolveDisplayedBostaTotal(order)` | Prefers the live Bosta breakdown total over the estimate | order → number | — |

### src/utils/integrations.js
| Name | What it does | Inputs → Outputs | Calls / depends on |
|---|---|---|---|
| `bostaTrackingUrl(trackingNumber)` | Public Bosta tracking URL | → string | — |
| `shopifyAdminOrderUrl(order, shop?)` | Shopify admin URL; falls back to the hard-coded store `gazellefootwear` | → string | — |
| `queueAgeHours(date)` | Hours since a date | → number | — |

### src/utils/orderIds.js
| Name | What it does | Inputs → Outputs | Calls / depends on |
|---|---|---|---|
| `isManualOrderRef` | Detects a manual-order reference (internal use only) | → bool | — |
| `orderShopifyLabel`, `orderPrimaryRef` | Display reference (#Shopify name or manual ref) | order → string | — |
| `orderRefsLine` | Combined refs line. Unused | order → string | — |
| `formatDelayBadge` | Text for a "delayed until" badge | order → string | — |

### src/utils/orderSearch.js
| Name | What it does | Inputs → Outputs | Calls / depends on |
|---|---|---|---|
| `normalizeSearchDigits` | Converts Arabic-Indic digits and strips non-digits | → string | — |
| `orderMatchesSearch(order, q)` | Client-side match on ref, phone, name, city or tracking number | → bool | — |
| `compactPlace` | Normalises a place name. Same logic as `orderMeta.js:27-33` | → string | — |
| `BOSTA_CITY_ALIASES`, `resolveBostaCityForForm` | Maps a Shopify city string to a Bosta city id/name | → city | — |

### src/utils/pendingRefund.js
| Name | What it does | Inputs → Outputs | Calls / depends on |
|---|---|---|---|
| `resolveRefundAmount(order)` | Refund owed to the customer | → number | — |
| `resolveOrderManagerNote(order)` | Orders-manager note shown on refunds | → string | — |
| `returnedProductLines(order)` | Returned item lines | → lines[] | — |
| `formatReturnedProducts` | Text form of the lines. Used only by tests | → string | — |

### src/utils/policyMoney.js
COD rules used for printing and display.

| Name | What it does | Inputs → Outputs | Calls / depends on |
|---|---|---|---|
| `COD_FEE_EGP` | 25 | — | — |
| `moneyBreakdown(order)` | Repair → total. Return → 0. Exchange → COD is shipping only. Prepaid → 0. Creator with no stored total → shipping. Otherwise goods + shipping + 25 | → `{goods, shipping, codFee, cod}` | — |
| `orderCollectTotal(order)` | Prefers `codCollectAmount`, otherwise `moneyBreakdown().cod` | → number | — |

### src/utils/returnKind.jsx
| Name | What it does | Inputs → Outputs | Calls / depends on |
|---|---|---|---|
| `getReturnKind(order)` | Classifies a return as exchange, return, failed or local | → kind | — |
| `RETURN_KIND_OPTIONS` | Filter options | — | — |
| `returnKindLabel` | Label for a kind. Unused | → string | — |
| `ReturnKindBadge` | Badge component | `{order}` → span | — |
| re-exports | Re-exports from returnLines (breaks react-refresh: lint errors at lines 7-35) | — | returnLines |

### src/utils/returnLines.js
| Name | What it does | Inputs → Outputs | Calls / depends on |
|---|---|---|---|
| `incomingReturnLines(order)` | Items expected back at the warehouse | → lines[] | — |
| `incomingRoleLabel(line)` | Labels a line "returning" or "collect" | → string | — |
| `applyCatalogToReturnLine(line, variant)` | Fills title and photo from the catalog | → line | — |

### src/utils/returnScan.js
| Name | What it does | Inputs → Outputs | Calls / depends on |
|---|---|---|---|
| `requiredSkuUnits(lines)` | Units required per SKU | → map | — |
| `expectedCountsFromRequired` | Expected count map | → map | — |
| `countForSku` | Scanned count for a SKU | → number | — |
| `allPiecesScanned` | Gate for confirming | → bool | — |
| `matchCodeToOrderSku(code, lines, lookups)` | Matches a scanned barcode or SKU to an order line | → sku/null | — |

### src/utils/routeMeta.js
Page titles and hints keyed by route. **The whole file is unused.**

| Name | What it does | Inputs → Outputs | Calls / depends on |
|---|---|---|---|
| `ROUTE_META`, `getPageTitle`, `getPageHint`, `getPageTopic` | Route → title, hint, topic | pathname → string | — |

### src/utils/shopifyContact.js
| Name | What it does | Inputs → Outputs | Calls / depends on |
|---|---|---|---|
| `isPlaceholderPhone`, `isPlaceholderCustomerName`, `isPlaceholderStreet` | Detect Shopify placeholder values | → bool | — |
| `shopifyContactIncomplete(order)` | Whether the contact details need fixing | → bool | — |
| `orderDisplayName`, `orderCallPhone`, `telHref` | Display name, phone to call, `tel:` link | → string | — |

### src/utils/orderLifecycle.js
| Name | What it does | Inputs → Outputs | Calls / depends on |
|---|---|---|---|
| `ORDER_LIFECYCLE`, `nextOrderAction` | Lifecycle map and next action. Unused | — | — |
| `lifecycleStripStatuses(order)` | Steps for OrderLifecycleStrip | → statuses[] | — |
| `statusLabel(s)` | Label for a status | → string | ORDER_STATUS_LABELS |

### src/utils/orderMeta.js
Order constants, shipping-fee zones and status hubs.

| Name | What it does | Inputs → Outputs | Calls / depends on |
|---|---|---|---|
| `MANUAL_ORDER_SOURCES`, `SHIPPING_METHODS`, `LOCAL_SHIPPING_FEE` (95), `DEFAULT_BOSTA_SHIPPING_FEE` (95), `SHOPIFY_FREE_SHIPPING_MIN` (2999) | Constants | — | ManualOrderPage etc. |
| `SHOPIFY_ZONE_DEFS`, `PLACE_TO_ZONE` | Zone tables | — | — |
| `resolveShopifyZoneShippingFee(city, goods)` | Customer shipping fee by zone, free above 2999 | → number | — |
| `resolveBostaCourierFee(city)` | Courier cost by zone. Repeats the zone loop from lines 103-114 at lines 132-142 | → number | — |
| `bostaFeeNote`, `LOCAL_SHIPPING_ZONES`, `isKnownLocalShippingZone` | Local-shipping helpers | → string/bool | — |
| `ORDER_STATE_TABS`, `ORDER_STATUS_ICONS`, `statusIcon` | Status tabs and icons | — | — |
| `ORDER_HUBS`, `getOrderHub`, `hubPathForStatus` | verify / warehouse / shipping / returns hub definitions and status → hub URL | → path | OrdersHubPage, Ops |
| `shippingMethodLabel`, `manualSourceLabel` | Labels | → string | — |

### src/utils/barcodeLabels.js
Barcode label printing.

| Name | What it does | Inputs → Outputs | Calls / depends on |
|---|---|---|---|
| `preparePrintWindow()` | Opens a placeholder window during the click (avoids popup blocking) | → Window | window.open |
| `openBarcodeLabels(variantId, copies, {targetWindow})` | GET `/inventory/variants/:id/barcode-labels?copies` and `document.write`s the HTML | → void | its own fetch (redefines `API_BASE`, reads the token itself) |
| `openBarcodeLabelsBatch(items, {targetWindow})` | POST `/inventory/barcode-labels/batch` | → void | same |

### src/utils/bostaPolicyPrint.js
| Name | What it does | Inputs → Outputs | Calls / depends on |
|---|---|---|---|
| `pdfBytesFromUrl` | Decodes a base64 or data URL into bytes (internal only) | → Uint8Array | — |
| `openBostaPolicyPlaceholder()` | Opens a "Loading AWB…" tab during the click | → Window | — |
| `openBostaPolicyPrint(payload, {targetWindow})` | Renders the Bosta AWB PDF (base64/url/blob) into the tab | → void | Blob URL |

### src/utils/gazellePolicyPrint.js
| Name | What it does | Inputs → Outputs | Calls / depends on |
|---|---|---|---|
| `printGazelleShippingPolicy(order)` | Prints an A5 Gazelle policy via a hidden iframe, for local_shipping and pickup orders only. Has its own `escapeHtml`, `variantOf`, `itemProductName` | → void | moneyBreakdown, logo data URL |

### src/utils/localShippingManifestPrint.js
| Name | What it does | Inputs → Outputs | Calls / depends on |
|---|---|---|---|
| `printOrdersListPdf(orders, opts)` | Printable orders table (window/iframe). Has its own `esc`, `itemLabel` and goods/COD math | → void | — |
| `printLocalShippingManifest(orders)` | Local courier manifest | → void | printOrdersListPdf |

### src/utils/gazelleLogoBlackDataUrl.js
| Name | What it does | Inputs → Outputs | Calls / depends on |
|---|---|---|---|
| default/const | Base64 PNG logo for print | — | — |

### Tests (src/utils/*.test.js)
- `bostaFees.test.js`: fee lines, and the live breakdown total beating the estimate.
- `gazellePolicyPrint.test.js`: actually tests `policyMoney` (25 COD fee, prepaid, pickup, repair, codCollectAmount), so the file name does not match what it tests.
- `pendingRefund.test.js`: refund amount, orders-manager note, returned-products text.
- `returnLines.test.js`: exchange collect lines and title/photo enrichment.
- `returnScan.test.js`: per-unit scan gating and SKU/barcode matching.

---

### src/pages/LoginPage.jsx
Email/password login.

| Name | What it does | Inputs → Outputs | Calls / depends on |
|---|---|---|---|
| `LoginPage` | Form → `login()` → navigate to `DEFAULT_ROUTES[role]`; shows the `ApiError` message | — → form | useAuth, roleConfig |

### src/pages/orders/OrderDetailPage.jsx
| Name | What it does | Inputs → Outputs | Calls / depends on |
|---|---|---|---|
| `OrderDetailPage` | Reads `:id` and renders `<OrderDetail orderId>` | — | components/orders/OrderDetail |

### src/pages/orders/OrdersHubPage.jsx (446 lines)
Status-hub list pages (verify, warehouse, shipping, returns-other).

| Name | What it does | Inputs → Outputs | Calls / depends on |
|---|---|---|---|
| `OrdersHubPage({hubId})` | Tabs from `ORDER_HUBS[hubId]` synced to `?status=`; an invalid status falls back to the default tab (55-58). Search, source and city filters. Queries `['order-state-counts']` (refetch 30s) and `['returns-hub-tab-counts']` (copy of fetchReturnsLaneTotals, 101-122). Actions: export OOS pieces, export pending refunds, print local manifest (list limit 500) | hubId → page | OrderListTable, ordersApi.stateCounts/list, inventoryApi.exportOutOfStockPieces, ordersApi.exportPendingRefunds, printLocalShippingManifest |
| `VerifyOrdersPage`, `WarehouseOrdersPage`, `ShippingOrdersPage`, `ReturnsOtherOrdersPage` | Wrappers that pass the hubId | — | OrdersHubPage |

### src/pages/orders/OrdersByStatePage.jsx (268 lines)
Every status as tabs (`/orders/states`).

| Name | What it does | Inputs → Outputs | Calls / depends on |
|---|---|---|---|
| `OrdersByStatePage` | Tabs = all statuses; stock managers are limited to `STOCK_TABS`. Query `['order-state-counts']`. Admin-only "Print PDF". Repeats the hub page's tab, URL and search logic | — | OrderListTable, ordersApi, printOrdersListPdf |

### src/pages/orders/OrdersListPage.jsx
All orders with filters.

| Name | What it does | Inputs → Outputs | Calls / depends on |
|---|---|---|---|
| `OrdersListPage` | Reads `status`, `search`, `shippingMethod`, `orderSource` from the URL (40-43). Admin `['shopify-status']`. `importMutation` calls `shopifyApi.importOrders({days:7})` and invalidates `orders`, `dashboard` (no query uses this key) and `shopify-status` | — | OrderListTable, shopifyApi |

### src/pages/orders/ManualOrderPage.jsx (2359 lines)
Create manual, exchange, return, creator and repair orders.

| Name | What it does | Inputs → Outputs | Calls / depends on |
|---|---|---|---|
| `lineFromPriorItem`, `catalogDeliverPatch`, `foldExtrasIntoPairedSlots`, `appendExtraLine` | Line-item helpers for exchange pairing | → lines | — |
| `ExchangeDeliverRow` | Picks the replacement SKU from the same family. Query `['exchange-sku-family', sku]` | props → row | inventoryApi.lookupSkuFamily |
| `CollectOnlyRow`, `ReturnOrRegularItemRow` | Item rows | props → row | inventoryApi.lookupSku |
| `ExchangeSummaryBlock` | Exchange money summary (`displayTotal` is unused, line 540) | props → block | — |
| `CreatorToggle` | Creator/influencer flag | props | — |
| `PriorOrderLookup` | Searches a previous order for exchange or return | props | ordersApi.exchangeLookup |
| `CustomerFields` | Customer inputs with debounced phone lookup | props | customersApi.lookupByPhone |
| `ItemsFields` | Items editor | props | — |
| `ShippingFields` | Method, city, district, fee. `lockShippingMethod = false` is a dead constant (1181) | props | useBostaCities/Districts |
| `ManualOrderPage` | About 25 `useState`s. Zone-fee effect calls `ordersApi.suggestShippingFee`. COD and total are computed client-side (1846-1867). `createMutation` calls `ordersApi.createManual`, invalidates orders, order-state-counts, queue and pick-list, then routes to `/stock/returns`, `/orders/verify?status=delayed` or `/stock/fulfillment`. Has a desktop form and a mobile wizard; repair mode renders `RepairOrderForm` | — | ordersApi, customersApi, inventoryApi, orderMeta, policyMoney |

### src/pages/orders/TopSellersPage.jsx
| Name | What it does | Inputs → Outputs | Calls / depends on |
|---|---|---|---|
| `TopSellersPage` | Month picker. Query `['top-sellers', month]`; has loading, error and empty states | — | reportsApi.topSellers |

### Legacy pages (not routed; only referenced by lazyPages)
| File | Name | What it does | Calls |
|---|---|---|---|
| `orders/VerificationQueuePage.jsx` | `VerificationQueuePage` | OrderListTable for pending_verification; links to `/orders/queue` | OrderListTable |
| `orders/NoResponseQueuePage.jsx` | `NoResponseQueuePage` | Same for no_response | OrderListTable |
| `orders/OutOfStockQueuePage.jsx` | `OutOfStockQueuePage` | Same for out_of_stock | OrderListTable |
| `orders/DelayedOrdersPage.jsx` | `DelayedOrdersPage` | Query `['orders','delayed',params]` | ordersApi.list |
| `orders/FailedDeliveriesPage.jsx` | `FailedDeliveriesPage` | Query `['orders',params]`; bulk `transition` to returning_to_origin | ordersApi.list/transition |

### src/pages/customers/CustomersPage.jsx (576 lines)
CRM list and detail drawer.

| Name | What it does | Inputs → Outputs | Calls / depends on |
|---|---|---|---|
| `FilterText` | Debounced text filter | props | — |
| `waitForCustomerImport(toast)` | Polls the import status every 2s, up to 180 times | → result | shopifyApi.importCustomers/Status |
| `CustomersPage` | Keys `['customers-filter-options']`, `['customers', page, listParams]`, `['customer', id]`, `['customer-orders', id]`. Excel export, Shopify import, and a risk-flag mutation with no `onError` (208-214) | — | customersApi, shopifyApi |

### src/pages/stock/DiscrepanciesPage.jsx
| Name | What it does | Inputs → Outputs | Calls / depends on |
|---|---|---|---|
| `DiscrepanciesPage` | Query `['discrepancies']`; renders expected and actual with `JSON.stringify` | — | inventoryApi.discrepancies |

### src/pages/stock/LowStockPage.jsx
| Name | What it does | Inputs → Outputs | Calls / depends on |
|---|---|---|---|
| `LowStockPage` | Query `['low-stock']` → variants with `lowStock` | — | inventoryApi.variants |

### src/pages/stock/OnHoldItemsPage.jsx
| Name | What it does | Inputs → Outputs | Calls / depends on |
|---|---|---|---|
| `OnHoldItemsPage` | Query `['on-hold-items', search]`, limit 500 | — | inventoryApi.onHoldItems |

### src/pages/stock/WarehouseReviewPage.jsx
| Name | What it does | Inputs → Outputs | Calls / depends on |
|---|---|---|---|
| `WarehouseReviewPage` | Queries `['warehouse-review', params]` and `['warehouse-stock-intakes', p]`. Exports go through `downloadApiFile` with raw paths not wrapped in client.js (`/fulfillment/warehouse-review/export`, `/intakes/export`, `/stock-export`) | — | fulfillmentApi, downloadApiFile, rangePresets |

### src/pages/stock/CatalogPage.jsx
| Name | What it does | Inputs → Outputs | Calls / depends on |
|---|---|---|---|
| `ProductImage`, `sortVariants` | Thumbnail and size sort (duplicated in StockAdjustPage) | — | — |
| `CatalogPage` | Queries `['catalog', params]`, `['catalog-filters']`, `['shopify-status']`. Shopify catalog sync, stock export, barcode print. Unused: `formatDate` (5), `isFetching` (100), `totalVariants` (219) | — | inventoryApi, shopifyApi, barcodeLabels |

### src/pages/stock/StockAdjustPage.jsx (945 lines)
Stock intake (add) and set (edit).

| Name | What it does | Inputs → Outputs | Calls / depends on |
|---|---|---|---|
| `QtyStepper`, `ModeTab`, `parseQty`, `ProductImage`, `sortVariants` | UI helpers | — | — |
| `StockAdjustPage` | Queries `['stock-intake-catalog', params]` and `['catalog-filters']`. `addMutation` → `stockIntakeBatch`; `setMutation` → `stockSetBatch`. Print is unlocked only after an add. Jard export | — | inventoryApi, barcodeLabels |
| `runAddStock` / `runSaveEdit` | Build the payloads for add (quantity) and set (realStock) | — | — |

### src/pages/stock/ReturnsPage.jsx (799 lines)
Receive returns back into the warehouse.

| Name | What it does | Inputs → Outputs | Calls / depends on |
|---|---|---|---|
| `TabButton` | Tab button (duplicated in FulfillmentPage) | — | — |
| `ReturnReceiveScan` | Camera or manual scan per unit. `['order', id]` plus `useQueries` `['variant-lookup', sku]`; 1200ms camera de-duplication | `{orderId}` | html5-qrcode, returnScan, inventoryApi.lookupSku |
| `ReturnsTable` | Lane table | props | — |
| `ReturnsPage` | 6 list queries (limit 50 each) with client-side search only; only the returning query's error is shown (593). `confirmMutation` → `confirmReturn`, invalidating both `['order-state-counts']` and `['queue','order-state-counts']` | — | ordersApi |

### src/pages/stock/FulfillmentPage.jsx (1578 lines)
Pick, pack and AWB for ready-to-ship orders.

| Name | What it does | Inputs → Outputs | Calls / depends on |
|---|---|---|---|
| `markReadyIdsSeen` etc. | localStorage `gazelle.fulfillment.seenReadyIds`, used to auto-select newly joined orders | — | localStorage |
| day-bucket helpers | Today / older tabs | — | — |
| `ScanPanel` | Camera scan to pack; reimplements returnScan logic; fixed element id `qr-reader`; no repeat-scan de-duplication | props | html5-qrcode |
| `FulfillmentOrderCard` | Card with COD math (652-676) | props | — |
| `printTodayPickSheet` | iframe pick sheet | orders → void | — |
| `FulfillmentPage` | Query `['pick-list']` (refetch every 3s while `pendingOrderId`). Mutations: pickPack, prepareAwb, awb (print), markOutOfStock, bulk OOS. Reads the day tab from `window.location.search` (922) | — | fulfillmentApi, bostaPolicyPrint, gazellePolicyPrint |

### src/pages/admin/AdminDashboard.jsx (465 lines)
**Dead file.** lazyPages maps `AdminDashboard` to `AdminDashboardMonthlyOverview`.

| Name | What it does | Calls |
|---|---|---|
| `AdminDashboard` | Old dashboard with keys dashboard-core/money/details and integration-health; hard-coded cutover `'2026-07-20'` (75) | reportsApi, integrationsApi |

### src/pages/admin/AdminDashboardMonthlyOverview.jsx
Admin home (route `/admin/dashboard`).

| Name | What it does | Inputs → Outputs | Calls / depends on |
|---|---|---|---|
| `sameRange`, `SectionLoader` | Helpers | — | — |
| `AdminDashboard` | Keys `['dashboard-summary', rangeKey]`, `['dashboard-details', rangeKey]`, `['dashboard-profit-loss', from, to]`. KPI cards link to hubs. Return-reason labels are hard-coded; the shipping-loss panel duplicates PlReportPage | — | reportsApi.dashboardSummary/Details, accountingApi.plReport |

### src/pages/admin/analytics/*.jsx
All four share the same AnalyticsNav plus AnalyticsDateControls pattern, and each has the guard `if (isLoading && !range)`, which can never fire.

| File | Name | What it does | Calls |
|---|---|---|---|
| `DeliveryAnalyticsPage.jsx` | `DeliveryAnalyticsPage` | `['delivery-analytics', range]` and `['integration-health']`; drilldowns to `/orders` with placedFrom/placedTo/limit/comma statuses | reportsApi.dashboardCore, integrationsApi.health |
| `CollectionsAnalyticsPage.jsx` | `CollectionsAnalyticsPage` | `['collections-analytics', range]`; COD and settlements | reportsApi.dashboardMoney |
| `ReturnsAnalyticsPage.jsx` | `ReturnsAnalyticsPage` | `['returns-analytics', range]`; reasons and refunds | reportsApi.dashboardDetails |
| `ExchangesAnalyticsPage.jsx` | `ExchangesAnalyticsPage` | `['exchanges-analytics', range]` and `['exchanges-core', range]` | reportsApi.dashboardDetails/Core |

### src/pages/admin/OpsCommandCenterPage.jsx
| Name | What it does | Inputs → Outputs | Calls / depends on |
|---|---|---|---|
| `OpsCommandCenterPage` | `['integration-health']` and `['order-state-counts']`; queue StatCards plus one tile per state linking to `hubPathForStatus` | — | integrationsApi, ordersApi.stateCounts, IntegrationHealthCard |

### src/pages/admin/AuditLogPage.jsx
| Name | What it does | Inputs → Outputs | Calls / depends on |
|---|---|---|---|
| `AuditLogPage` | `['audit', params]` with skip/limit 30 and from/to; status-history and ledger tables; Excel export (limit 500) | — | reportsApi.audit/exportAudit |

### src/pages/admin/CogsPage.jsx
| Name | What it does | Inputs → Outputs | Calls / depends on |
|---|---|---|---|
| `CogsPage` | `['cogs-health']` (limit 2000). Filters: missing / loss / all. Inline COGS edit (`updateCogs`) invalidates cogs-health, pl-report and profitability. Excel export | — | productsApi.cogsHealth/updateCogs/exportCogsHealth |

### src/pages/admin/ReportsPage.jsx
| Name | What it does | Inputs → Outputs | Calls / depends on |
|---|---|---|---|
| `ReportsPage` | `['profitability', from, to]`; computes totals client-side if the API omits them; range presets (not memoised); Excel export | — | reportsApi.profitability/exportProfitability, FinanceRangeBar |

### src/pages/admin/UsersPage.jsx
| Name | What it does | Inputs → Outputs | Calls / depends on |
|---|---|---|---|
| `UsersPage` | `['users']`; create user (O or S roles only); deactivate with ConfirmModal. Neither mutation has `onError` | — | usersApi |

### src/pages/admin/SettingsPage.jsx (517 lines)
Shopify, Bosta and status-mapping settings.

| Name | What it does | Inputs → Outputs | Calls / depends on |
|---|---|---|---|
| `SETUP_STEPS` | Static setup copy | — | — |
| `SettingsPage` | Keys `['settings']`, `['shopify-status']`, `['integration-health']`. Mutations: connect, test, syncCatalog, pushWarehouseStock (`window.confirm`), importOrders(30d), importCustomers (inline 2s × 180 poll), registerWebhooks, locations, upsertBostaMapping (no `onError`), syncBostaCities | — | settingsApi, shopifyApi, referenceApi, integrationsApi |

### src/pages/admin/accounting/ChartOfAccountsPage.jsx
| Name | What it does | Inputs → Outputs | Calls / depends on |
|---|---|---|---|
| `ChartOfAccountsPage` | `['gl-accounts']` and `['balance-sheet']`; groups accounts by category with balances. Read-only (no create/edit UI even though the client has it) | — | accountingApi.accounts/balanceSheet |

### src/pages/admin/accounting/ExpensesPage.jsx (521 lines)
| Name | What it does | Inputs → Outputs | Calls / depends on |
|---|---|---|---|
| `currentYearMonth`, `rangeHint` | Helpers (local time zone) | — | — |
| `ExpensesPage` | `['month-expenses', month]` (refetch 120s). Seeds the draft from the server by calling setState during render (52-65). Save month variables (`saveMonthExpenses`); CRUD for fixed and variable lines; Excel export | — | accountingApi.monthExpenses/saveMonthExpenses/createExpense/updateExpense/deleteExpense/exportExpenses |

### src/pages/admin/accounting/PlReportPage.jsx
| Name | What it does | Inputs → Outputs | Calls / depends on |
|---|---|---|---|
| `PlReportPage` | `['pl-report', from, to]`; KPIs, source/payment/shipping split, shipping-loss panel, Bosta fee breakdown; Excel export | — | accountingApi.plReport/exportPl |

### src/pages/admin/accounting/TopProductsPage.jsx
| Name | What it does | Inputs → Outputs | Calls / depends on |
|---|---|---|---|
| `TopProductsPage` | `['top-products', from, to]` (limit 50); Excel export | — | accountingApi.topProducts/exportTopProducts |

### src/pages/admin/hr/*.jsx
These routes are not in any nav. No mutation shows success or error feedback.

| File | Name | What it does | Calls |
|---|---|---|---|
| `EmployeesPage.jsx` | `EmployeesPage` | `['employees']`; add-employee form (creates a user, O or S); links to profiles | hrApi.employees/createEmployee |
| `EmployeeDetailPage.jsx` | `EmployeeDetailPage` | `['employee', id]`; profile, KPIs, record attendance, attendance and leave tables | hrApi.getEmployee/recordAttendance |
| `AttendancePage.jsx` | `AttendancePage` | Picks an employee and records attendance; invalidates `['employees']`. No error state | hrApi.employees/recordAttendance |
| `LeaveRequestsPage.jsx` | `LeaveRequestsPage` | `['leave-requests']` (pending); approve and reject | hrApi.leaveRequests/reviewLeaveRequest |
| `PayrollPage.jsx` | `PayrollPage` | `['payroll', month]`; client-side CSV export (no quoting) | hrApi.payrollSummary |

### src/pages/admin/manufacturing/*.jsx
| File | Name | What it does | Calls |
|---|---|---|---|
| `FactoriesPage.jsx` | `FactoriesPage` | `['factories']`; create/edit form; delete with no confirmation or `onError` | manufacturingApi.factories/createFactory/updateFactory/deleteFactory |
| `PurchaseOrdersPage.jsx` | `PurchaseOrdersPage` | `['purchase-orders']` (limit 100) list | manufacturingApi.purchaseOrders |
| `NewPurchaseOrderPage.jsx` | `factoryIdOf`, `NewPurchaseOrderPage` | `['factories']` and `['orderable-products', q, factoryId]`; pick products and enter qty/cost per variant; create (linkFactory) then navigate to detail. Empty `if` block (103-105) | manufacturingApi.orderableProducts/createPurchaseOrder |
| `PurchaseOrderDetailPage.jsx` | `PurchaseOrderDetailPage` | `['purchase-order', id]`; Mark sent, Mark received (adds stock, no confirmation), Excel export | manufacturingApi.getPurchaseOrder/updatePurchaseOrder/receivePurchaseOrder/exportPurchaseOrder |

---

## Routing and roles

Guarding is client-side only. Every child route sits under ProtectedRoute(A, O, S) and then its own ProtectedRoute(roles).

| Route path | Page component | Roles allowed |
|---|---|---|
| `/login` | LoginPage (GuestRoute) | public |
| `/` (index) | RoleRedirect → DEFAULT_ROUTES | A, O, S |
| `/admin/dashboard` | AdminDashboard (= AdminDashboardMonthlyOverview) | A |
| `/admin/dashboard/delivery` | DeliveryAnalyticsPage | A |
| `/admin/dashboard/collections` | CollectionsAnalyticsPage | A |
| `/admin/dashboard/returns` | ReturnsAnalyticsPage | A |
| `/admin/dashboard/exchanges` | ExchangesAnalyticsPage | A |
| `/admin/ops` | OpsCommandCenterPage | A |
| `/admin/audit` | AuditLogPage | A |
| `/admin/cogs` | CogsPage | A |
| `/admin/reports` | ReportsPage | A |
| `/admin/users` | UsersPage | A |
| `/admin/settings` | SettingsPage | A |
| `/admin/manufacturing/factories` | FactoriesPage | A |
| `/admin/manufacturing/purchase-orders` | PurchaseOrdersPage | A |
| `/admin/manufacturing/purchase-orders/new` | NewPurchaseOrderPage | A |
| `/admin/manufacturing/purchase-orders/:id` | PurchaseOrderDetailPage | A |
| `/admin/accounting/chart-of-accounts` | ChartOfAccountsPage | A |
| `/admin/accounting/expenses` | ExpensesPage | A |
| `/admin/accounting/pl-report` | PlReportPage | A |
| `/admin/accounting/top-products` | TopProductsPage | A |
| `/admin/hr/employees` | EmployeesPage | A |
| `/admin/hr/employees/:id` | EmployeeDetailPage | A |
| `/admin/hr/attendance` | AttendancePage | A |
| `/admin/hr/leave-requests` | LeaveRequestsPage | A |
| `/admin/hr/payroll` | PayrollPage | A |
| `/orders` | OrdersListPage | A, O, S |
| `/orders/:id` | OrderDetailPage | A, O, S |
| `/orders/states` | OrdersByStatePage | A, O, S |
| `/orders/verify` | VerifyOrdersPage | A, O |
| `/orders/warehouse` | WarehouseOrdersPage | A, O, S |
| `/orders/shipping` | ShippingOrdersPage | A, O, S |
| `/orders/returns-other` | ReturnsOtherOrdersPage | A, O |
| `/orders/new` | ManualOrderPage | A, O |
| `/orders/top-sellers` | TopSellersPage | A, O |
| `/customers` | CustomersPage | A, O |
| `/stock/fulfillment` | FulfillmentPage | A, S |
| `/stock/warehouse-review` | WarehouseReviewPage | A, S |
| `/stock/catalog` | CatalogPage | A, S, O |
| `/stock/adjust` | StockAdjustPage | A, S |
| `/stock/returns` | ReturnsPage | A, S, O |
| `/stock/on-hold` | OnHoldItemsPage | A, S, O |
| `/stock/low-stock` | LowStockPage | A, S |
| `/stock/discrepancies` | DiscrepanciesPage | A, S |
| `/orders/delayed` | → `/orders/verify?status=delayed` | redirect |
| `/orders/queue` | → `/orders/verify?status=pending_verification` | redirect |
| `/orders/no-response` | → `/orders/verify?status=no_response` | redirect |
| `/orders/out-of-stock` | → `/orders/warehouse?status=out_of_stock` | redirect |
| `/orders/failed` | → `/orders/shipping?status=failed_delivery` | redirect |
| `*` | → `/` | redirect |

**DEFAULT_ROUTES:** admin → `/admin/dashboard`; orders_manager → `/orders/verify`; stock_manager → `/orders/warehouse`.

**NAV_SECTIONS (sidebar):**
- **admin**
  - Overview: Dashboard, Ops, Warehouse review, Customers, Low stock (badge lowStock), Top sellers, Users.
  - Orders: All, By state, Verify (verifyQueue), Warehouse (warehouseOrders), Shipping (shippingOrders), Returns & other (returnsOther), Pending refund (pendingRefund), New order.
  - Warehouse: Fulfillment (readyToShip), Warehouse orders (same link as Orders → Warehouse), Returns (returningToOrigin), On hold, Catalog, Stock adjust.
  - Finance: Reports, COGS, Chart of accounts, Expenses, P&L, Top products.
  - Manufacturing: Factories, Purchase orders.
- **orders_manager**, one Orders section: All, By state, Verify, Warehouse, Shipping, Returns & other, Pending refund, New order, Top sellers, Customers, Catalog, On hold.
- **stock_manager**
  - Warehouse: Warehouse review, Fulfillment, Warehouse orders, Returns, On hold, Catalog, Stock adjust.
  - Inventory alerts: Low stock.
- Routed but in no nav: `/admin/settings`, `/admin/audit`, all `/admin/hr/*`, `/stock/discrepancies`. The analytics subpages are reached only through the in-page AnalyticsNav.

**BOTTOM_NAV (mobile):**
- admin: Home `/admin/dashboard`, Orders `/orders/verify`, Warehouse `/stock/fulfillment`, More.
- orders_manager: Verify `/orders/verify`, Returns `/orders/returns-other`, Shipping `/orders/shipping`, More.
- stock_manager: Warehouse `/stock/warehouse-review`, Ship `/stock/fulfillment`, Review `/orders/warehouse`, More.

---

## API client map

Base URL is `VITE_API_BASE || '/api/v1'`. `⬇` means a download through `downloadApiFile` (blob saved via `<a download>`, GET unless noted).

**authApi**
- `login` → POST /auth/login
- `me` → GET /auth/me

**ordersApi**
- `list` → GET /orders?…
- `stateCounts` → GET /orders/counts
- `createManual` → POST /orders/manual
- `createRepair` → POST /orders/repair
- `exchangeLookup` → GET /orders/exchange-lookup?q
- `suggestShippingFee` → GET /orders/shipping-fee-suggest?city&goodsTotal
- `get` → GET /orders/:id
- `history` → GET /orders/:id/history
- `claim` → POST /orders/:id/claim
- `verify` → POST /orders/:id/verify
- `bulkVerify` → POST /orders/bulk-verify
- `delay` → POST /orders/:id/delay
- `cancel` → POST /orders/:id/cancel
- `partialLocalDelivery` → POST /orders/:id/partial-local-delivery
- `returnLocalShippingToStock` → POST /orders/:id/local-return-to-stock
- `returnPickupToStock` → POST /orders/:id/pickup-return-to-stock
- `exchange` → POST /orders/:id/exchange
- `removeItem` → POST /orders/:id/remove-item
- `addItem` → POST /orders/:id/add-item
- `transition` → POST /orders/:id/transition
- `confirmReturn` → POST /orders/:id/confirm-return
- `confirmRefundPaid` → POST /orders/:id/confirm-refund-paid
- `updateShipping` → PATCH /orders/:id/shipping
- `applyDiscount` → POST /orders/:id/discount
- `exportPendingRefunds` → ⬇ /orders/export/pending-refunds

**customersApi**
- `list` → GET /customers
- `get` → GET /customers/:id
- `filterOptions` → GET /customers/filter-options
- `exportExcel` → ⬇ /customers/export
- `lookupByPhone` → GET /customers/lookup/by-phone?phone
- `orders` → GET /customers/:id/orders
- `updateRiskFlag` → PATCH /customers/:id/risk-flag

**inventoryApi**
- `variants` → GET /inventory/variants
- `catalog` → GET /inventory/catalog
- `catalogFilters` → GET /inventory/catalog/filters
- `exportCatalogStock` → ⬇ POST /inventory/catalog/export-stock
- `exportJard` → ⬇ /inventory/catalog/export-jard
- `exportOutOfStockPieces` → ⬇ /inventory/out-of-stock-pieces/export
- `lookupSku` → GET /inventory/variants/lookup?sku
- `lookupSkuFamily` → GET /inventory/variants/lookup-family
- `stockIntake` → POST /inventory/stock-intake
- `stockIntakeBatch` → POST /inventory/stock-intake/batch
- `stockSetBatch` → POST /inventory/stock-set/batch
- `variant` → GET /inventory/variants/:id
- `ledger` → GET /inventory/variants/:id/ledger
- `adjust` → POST /inventory/variants/:id/adjust
- `discrepancies` → GET /inventory/discrepancies
- `onHoldItems` → GET /inventory/on-hold
- `queueCounts` → GET /inventory/queue-counts
- Outside client.js, `utils/barcodeLabels.js` calls GET /inventory/variants/:id/barcode-labels and POST /inventory/barcode-labels/batch directly.

**productsApi**
- `list` → GET /products
- `cogsHealth` → GET /products/cogs-health
- `exportCogsHealth` → ⬇ /products/cogs-health/export
- `updateCogs` → PATCH /products/variants/:id/cogs
- `addCogsBatch` → POST /products/variants/:id/cogs-batches

**reportsApi**
- `dashboard` → GET /reports/dashboard
- `dashboardCore` → GET /reports/dashboard/core
- `dashboardMoney` → GET /reports/dashboard/money
- `dashboardSummary` → GET /reports/dashboard/summary
- `dashboardDetails` → GET /reports/dashboard/details
- `profitability` → GET /reports/profitability
- `exportProfitability` → ⬇ /reports/profitability/export
- `audit` → GET /reports/audit
- `exportAudit` → ⬇ /reports/audit/export
- `topSellers` → GET /reports/top-sellers

**usersApi**
- `list` → GET /users
- `create` → POST /users
- `deactivate` → DELETE /users/:id

**settingsApi**
- `get` → GET /settings
- `update` → PATCH /settings
- `upsertBostaMapping` → POST /settings/bosta-mappings
- `forceShopifySync` → POST /settings/shopify/sync

**shopifyApi** (all under /integrations/shopify)
- `status` → GET /status
- `connect` → POST /connect
- `test` → POST /test
- `syncCatalog` → POST /sync with `{importOrders:false}`
- `sync` → POST /sync
- `importOrders` → POST /import-orders
- `importCustomers` → POST /import-customers
- `importCustomersStatus` → GET /import-customers/status
- `pushWarehouseStock` → POST /push-warehouse-stock
- `registerWebhooks` → POST /register-webhooks
- `locations` → GET /locations

**integrationsApi**
- `health` → GET /integrations/health

**notificationsApi**
- `list` → GET /notifications
- `unreadCount` → GET /notifications/unread-count
- `markRead` → POST /notifications/:id/read
- `markAllRead` → POST /notifications/read-all

**fulfillmentApi**
- `pickList` → GET /fulfillment/pick-list
- `warehouseReview` → GET /fulfillment/warehouse-review
- `stockIntakes` → GET /fulfillment/warehouse-review/intakes
- `pickPack` → POST /fulfillment/:id/pick-pack
- `prepareAwb` → POST /fulfillment/:id/prepare-awb
- `markOutOfStock` → POST /fulfillment/:id/out-of-stock
- `awb` → GET /fulfillment/:id/awb
- `shipmentStatus` → GET /fulfillment/:id/shipment-status
- `stockCheck` → GET /fulfillment/:id/stock-check
- Outside client.js, WarehouseReviewPage calls → /fulfillment/warehouse-review/export, /intakes/export and /stock-export with raw paths.

**referenceApi**
- `bostaCities` → GET /reference/bosta-cities
- `bostaDistricts` → GET /reference/bosta-cities/:cityId/districts
- `syncBostaCities` → POST /reference/bosta-cities/sync

**manufacturingApi**
- `factories` → GET /manufacturing/factories
- `createFactory` → POST /manufacturing/factories
- `updateFactory` → PATCH /manufacturing/factories/:id
- `deleteFactory` → DELETE /manufacturing/factories/:id
- `orderableProducts` → GET /manufacturing/orderable-products
- `assignProductFactory` → PATCH /manufacturing/products/:id/factory
- `purchaseOrders` → GET /manufacturing/purchase-orders
- `getPurchaseOrder` → GET /manufacturing/purchase-orders/:id
- `createPurchaseOrder` → POST /manufacturing/purchase-orders
- `updatePurchaseOrder` → PATCH /manufacturing/purchase-orders/:id
- `receivePurchaseOrder` → POST /manufacturing/purchase-orders/:id/receive
- `exportPurchaseOrder` → ⬇ /manufacturing/purchase-orders/:id/export

**accountingApi**
- `accounts` → GET /accounting/accounts
- `createAccount` → POST /accounting/accounts
- `updateAccount` → PATCH /accounting/accounts/:id
- `journal` → GET /accounting/journal
- `createJournal` → POST /accounting/journal
- `plReport` → GET /accounting/reports/pl
- `exportPl` → ⬇ /accounting/reports/pl/export
- `balanceSheet` → GET /accounting/reports/balance-sheet
- `topProducts` → GET /accounting/reports/top-products
- `exportTopProducts` → ⬇ /accounting/reports/top-products/export
- `cogsHealth` → GET /products/cogs-health (same endpoint as productsApi)
- `exportCogsHealth` → ⬇ /accounting/reports/cogs-health/export (a different path from productsApi's)
- `expenses` → GET /accounting/expenses
- `createExpense` → POST /accounting/expenses
- `updateExpense` → PATCH /accounting/expenses/:id
- `deleteExpense` → DELETE /accounting/expenses/:id
- `exportExpenses` → ⬇ /accounting/expenses/export
- `monthExpenses` → GET /accounting/expenses/month?month
- `saveMonthExpenses` → PUT /accounting/expenses/month

**hrApi**
- `employees` → GET /hr/employees
- `getEmployee` → GET /hr/employees/:id
- `createEmployee` → POST /hr/employees
- `updateEmployee` → PATCH /hr/employees/:id
- `attendance` → GET /hr/employees/:id/attendance
- `recordAttendance` → POST /hr/employees/:id/attendance
- `kpis` → GET /hr/employees/:id/kpis
- `leaveRequests` → GET /hr/leave-requests
- `createLeaveRequest` → POST /hr/leave-requests
- `reviewLeaveRequest` → PATCH /hr/leave-requests/:id
- `payrollSummary` → GET /hr/payroll-summary

**Never called from `src` (23):**
- ordersApi: `claim`
- inventoryApi: `variant`, `ledger`, `adjust`, `stockIntake`
- productsApi: `list`, `addCogsBatch`
- reportsApi: `dashboard`
- settingsApi: `forceShopifySync`
- shopifyApi: `sync`
- fulfillmentApi: `stockCheck`
- accountingApi: `journal`, `createJournal`, `createAccount`, `updateAccount`, `cogsHealth`, `exportCogsHealth`
- hrApi: `attendance`, `updateEmployee`, `kpis`, `createLeaveRequest`
- manufacturingApi: `assignProductFactory`

**Auth tokens**
- The JWT is stored in `localStorage.gazelle_token` and the user object in `localStorage.gazelle_user` (client.js:11-28).
- `api()` and `downloadApiFile()` add `Authorization: Bearer <token>`. `barcodeLabels.js:81-82` builds the same header separately.
- `login` stores both values; `logout` removes both.

**Errors**
- A network failure becomes `ApiError(status 0, "Connection lost…")`.
- A non-2xx response becomes `ApiError(data.error || fallback, status)`, where 502/503 fall back to "Save timed out…" and other codes to statusText. Download errors parse a text body.
- Pages show errors through `ErrorState` or toasts.

**401 handling**
- There is no global handling: no interceptor, no QueryCache/MutationCache `onError`, and no redirect.
- The only reset is `AuthProvider.refreshUser` on app mount, which clears the session if `/auth/me` fails for any reason.
- A token that expires mid-session just makes every request fail until the user reloads or signs out.

---

## Issues spotted (frontend app)

**Correctness / data bugs**
- `src/pages/stock/StockAdjustPage.jsx:243-252, 281-294, 515-527, 922-930`: In Edit mode, picking a product seeds `qtyByVariant` with the current `realStock`. The **"Add intake"** button in that mode calls `runAddStock`, which posts those numbers as *quantities to add* through `stockIntakeBatch`. One click roughly doubles warehouse stock for the selected sizes.
- COD rules are implemented in three places that disagree:
  - `src/utils/policyMoney.js:29-36` (exchange COD = shipping only; creator orders get the +25 fee) drives the printed Gazelle A5 policy (`gazellePolicyPrint.js`).
  - `FulfillmentPage.jsx:652-676` uses goods + shipping → credit for exchanges and total + shipping (no 25 fee) for creators.
  - `ManualOrderPage.jsx:1846-1867` has its own math.
  - So the printed policy can show a different amount to collect than the warehouse card.
- `src/pages/admin/AdminDashboardMonthlyOverview.jsx:545`: the "With courier" card links to `status=picked_up_by_bosta,in_transit`. `OrdersHubPage.jsx:55-58` rejects unknown tab values, so the link silently shows only the default tab.
- Analytics drilldowns are half-finished. `DeliveryAnalyticsPage.jsx:141-161` and `ExchangesAnalyticsPage.jsx:127` pass `placedFrom`, `placedTo`, `isExchangeOrder` and `limit` to `/orders`, but `OrdersListPage.jsx:40-43` reads only status, search, shippingMethod and orderSource. `OrderListTable` already supports `placedFrom/placedTo`; the page just doesn't pass them, so the drilldown ignores the date range. `CollectionsAnalyticsPage.jsx:133` "COD left to collect" links to `/stock/returns`, which is the wrong target.
- `src/pages/stock/FulfillmentPage.jsx` (`ScanPanel`, ~178-331): there is no repeat-scan de-duplication, unlike `ReturnsPage.jsx` (1200ms). One box held in front of the camera can count several units. The panel also reimplements `utils/returnScan.js`.
- `src/pages/stock/ReturnsPage.jsx:482-521`: six lists fetched with `limit: 50` and searched only on the client, so older returns can't be found. Only the first query's error is shown (593).
- `src/pages/admin/AuditLogPage.jsx:113`: Pagination `total` is the length of the current page's rows, so you can never page past the first page. Changing the date filters also doesn't reset `page`.
- `src/pages/stock/StockAdjustPage.jsx:638, 648, 654`: filter changes don't reset the page.
- Date handling: `PayrollPage.jsx:10`, `AttendancePage.jsx:12` and `EmployeeDetailPage.jsx:16` use `toISOString()` (UTC), so before 02:00/03:00 Cairo time they default to the previous day. Attendance `clockIn/clockOut` are sent without a timezone offset (`AttendancePage.jsx:26-27`).
- `src/pages/orders/ManualOrderPage.jsx:2319`: the callout says pickup orders go to "Delivered", but the toast (1791) and the ShippingFields hint (1273) say Ready to ship.
- Encoding artefacts: "?" appears where arrows should be in subtitles and labels, e.g. `DeliveryAnalyticsPage.jsx:81, 140`.

**Security**
- The JWT and user object are kept in `localStorage` (`client.js:11-28`), so any XSS can read them. Role and user are initialised from `localStorage.gazelle_user` (`AuthContext.jsx:7`) before `/auth/me` confirms them. All role gating is client-side (`ProtectedRoute`, `isAdmin` flags in pages); the backend must enforce every route.
- No global 401 handling (`client.js:37-70`, no QueryCache `onError`). An expired token leaves users on failing pages instead of sending them to `/login`.
- `getStoredUser` does an unguarded `JSON.parse` (`client.js:22`) inside the AuthProvider initialiser, which sits *outside* the ErrorBoundary (`App.jsx`). A corrupted `gazelle_user` value white-screens the whole app.
- `utils/barcodeLabels.js:14-26, 80-101` `document.write`s server-returned HTML into a same-origin window, and duplicates `API_BASE` and token handling. Any unescaped product text in that backend HTML would run in the app origin.
- `SettingsPage.jsx:29, 441-443` hard-codes the shop domain and contains stale "ngrok" setup copy. `integrations.js` hard-codes the `gazellefootwear` store slug.

**Dead / unused code**
- Dead pages:
  - `src/pages/admin/AdminDashboard.jsx` (465 lines, hard-coded cutover `'2026-07-20'` at line 75). lazyPages maps `AdminDashboard` to the monthly overview instead.
  - Five legacy queue pages, exported in `routes/lazyPages.js:54-58` and never routed: `VerificationQueuePage`, `NoResponseQueuePage`, `DelayedOrdersPage`, `OutOfStockQueuePage`, `FailedDeliveriesPage`.
- Unused modules and exports:
  - `src/utils/routeMeta.js` (the whole file).
  - `roleConfig.js:155` `NAV_BY_ROLE`.
  - `orderLifecycle.js` `ORDER_LIFECYCLE` and `nextOrderAction`.
  - `orderIds.js` `orderRefsLine`.
  - `returnKind.jsx` `returnKindLabel`.
  - `pendingRefund.js` `formatReturnedProducts` (used only by tests).
- 23 API functions are never called (listed in "API client map"). `accountingApi.cogsHealth` duplicates `productsApi.cogsHealth`, and the two `exportCogsHealth` functions use different paths (`client.js:300-302`).
- Dead code inside pages:
  - `ManualOrderPage.jsx:540` unused `displayTotal`, and `:1181` `const lockShippingMethod = false`.
  - `CatalogPage.jsx:5, 100, 219` unused `formatDate`, `isFetching` and `totalVariants`.
  - `StockAdjustPage.jsx:147` unused `isFetching`.
  - `NewPurchaseOrderPage.jsx:103-105` empty `if`.
- `useQueueCounts.js:87, 111` computes a `discrepancies` badge, but no nav item uses it, and `/stock/discrepancies` has no nav entry.
- `npm run lint` fails with 23 errors in scope: `set-state-in-effect` in AuthContext, SettingsPage, ManualOrderPage, FulfillmentPage and StockAdjustPage; `react-hooks/refs` at `ReturnsPage.jsx:358`; react-refresh export errors in `returnKind.jsx` and `AuthContext.jsx`; unused variables. `npm test` covers only `src/utils`, and `gazellePolicyPrint.test.js` tests `policyMoney`, not the print module.

**Duplicated logic**
- `OrdersHubPage.jsx:53-171` and `OrdersByStatePage.jsx:51-116` share the same tab, URL and search logic. `SOURCE_OPTIONS` is copied in OrdersHubPage, OrdersByStatePage and OrdersListPage.
- Returns-lane counts: `useQueueCounts.js:5-18` (`fetchReturnsLaneTotals`) is copied in `OrdersHubPage.jsx:101-122`. The same data is cached under two keys.
- Customer-import polling appears in both `CustomersPage.jsx` (`waitForCustomerImport`) and `SettingsPage.jsx:135-149`.
- Camera scanning: FulfillmentPage `ScanPanel` and ReturnsPage `ReturnReceiveScan`. Also `TabButton`, and `ProductImage`/`sortVariants` (CatalogPage and StockAdjustPage).
- Print helpers: `escapeHtml`/`esc`, `variantOf` and `itemProductName` are re-defined in `gazellePolicyPrint.js`, `localShippingManifestPrint.js` and `FulfillmentPage.jsx`. Each file also implements its own iframe printing.
- `orderMeta.js:103-114` and `:132-142` repeat the same zone-lookup loop. `compactPlace` exists in both `orderSearch.js` and `orderMeta.js`.
- The shipping-loss panel is duplicated in `AdminDashboardMonthlyOverview.jsx` and `PlReportPage.jsx`, and return-reason labels in the dashboard and ManualOrderPage. The four analytics pages repeat the same nav, date-controls and loading pattern; their `if (isLoading && !range)` guard can never fire.

**Inconsistent query keys / cache**
- `/orders/counts` is cached as `['queue','order-state-counts']` (refetch 120s) and also as `['order-state-counts']` (refetch 30s in OrdersHubPage, OrdersByStatePage and Ops). Mutations have to invalidate both, as ReturnsPage does; ManualOrderPage invalidates `order-state-counts` plus `queue`.
- `OrdersListPage.jsx:70` invalidates `['dashboard']`, a key no query uses. The real keys are `dashboard-summary`, `dashboard-details`, `dashboard-profit-loss`, and so on.
- CogsPage and ExpensesPage invalidate `['pl-report']` but not the dashboard's `['dashboard-profit-loss']`, which hits the same endpoint.
- `/inventory/catalog` is cached as both `['catalog', …]` and `['stock-intake-catalog', …]`.
- `AttendancePage.jsx:30` invalidates `['employees']`, but attendance is shown under `['employee', id]`.
- `PurchaseOrderDetailPage.jsx:26-31` "Mark received" adds stock without a confirm dialog and doesn't invalidate the catalog or `['purchase-orders']`. NewPurchaseOrderPage also doesn't invalidate `['purchase-orders']`.

**Missing error / loading feedback**
- Mutations with no `onError` (silent failures):
  - `UsersPage.jsx:21-32`
  - `CustomersPage.jsx:208-214` (risk flag)
  - `SettingsPage.jsx:179-186` (Bosta mapping)
  - `FactoriesPage.jsx:31-46` (delete also has no confirmation)
  - `PurchaseOrderDetailPage.jsx:21-24`
  - All HR pages: `AttendancePage.jsx:23-31`, `EmployeeDetailPage.jsx:27-35`, `EmployeesPage.jsx:25-31`, `LeaveRequestsPage.jsx:16-19`
- `AttendancePage` has no error state. `NewPurchaseOrderPage` ignores a factories error. `OrdersHubPage` ignores count errors.

**Large components / half-finished features**
- Very large files that should be split:
  - `ManualOrderPage.jsx`: 2359 lines, about 25 `useState`s, heavy inline styles.
  - `FulfillmentPage.jsx`: 1578 lines.
  - `StockAdjustPage.jsx`: 945 lines.
  - `ReturnsPage.jsx`: 799 lines.
  - `CustomersPage.jsx`: 576 lines.
  - `ExpensesPage.jsx`: 521 lines (sets state during render, 52-65).
  - `SettingsPage.jsx`: 517 lines.
- HR module (5 pages) is routed but has no nav entry, no feedback and no edit flow. Chart of accounts is read-only although the client has create/update/journal calls. `/admin/settings` and `/admin/audit` are in no nav.
- `CatalogPage.jsx:329` shows "Go to Stock intake" to orders_manager, who `ProtectedRoute` then bounces off `/stock/adjust`.
- `FulfillmentPage.jsx:922` reads the tab from `window.location.search` instead of router search params.
