# Drip — Backend Integration (native iOS ↔ existing Next.js / Supabase / Stripe / Mux)

**Principle:** the native app reuses the existing backend. Price, inventory, order creation, payment verification and seller eligibility stay authoritative on the server. No privileged credential exists on the device.

**Labels:** **Confirmed** (read in code, with citation) · **Changed on native-ios** (this branch, tested) · **Proposed**.

---

## 1. How the app authenticates

| Identity | Native mechanism | Server verification | Status |
|---|---|---|---|
| **Viewer** (anonymous device) | `POST /api/session/anon` once → `{anonId, token}` → Keychain → header `x-drip-anon-token: v1.<uuid>.<hmac>` | `resolveSignedAnonId` checks the cookie first, then the header, with the same HMAC and `ANON_ID_SECRET` (`src/lib/anon-request.ts`) | Changed on native-ios |
| **User** (Supabase account) | Supabase Auth REST → access/refresh token in Keychain → `Authorization: Bearer <access token>` | `createServerClient_()` builds an anon-key client carrying the JWT, so RLS applies as that user; `auth.getUser()` verifies the token with Supabase Auth (`src/lib/supabase-server.ts`) | Changed on native-ios |
| **Account ↔ device link** | `POST /api/session/link` with both headers after sign-in | `claim_anon_identity`, which refuses to merge another account's history (`00010_feed_review_fixes.sql:185`) | Confirmed. Known issue: a user's second device raises 23505 (audit A §0.6); the app treats the failure as non-fatal |

- **Browsers are unaffected.** They never send these headers, and the cookie path is unchanged.
- **No CSRF exposure.** A cross-site page can't attach an `Authorization` header without a CORS preflight, and no route answers one.

### Supabase Auth providers the app uses
| Provider | Native flow | Configuration required (Supabase dashboard) |
|---|---|---|
| Sign in with Apple | `ASAuthorizationAppleIDProvider` → `id_token` + raw nonce → `/auth/v1/token?grant_type=id_token` | Enable the Apple provider; add the iOS bundle id `com.pixelbuyte.drip` as an authorised client id |
| Google | `ASWebAuthenticationSession` → `/auth/v1/authorize?provider=google&code_challenge=…` → `drip://auth-callback?code=` → `grant_type=pkce` | Add `drip://auth-callback` to Auth → URL Configuration → Redirect URLs |
| Email + password | `grant_type=password`, `/auth/v1/signup` | Already used by the web (Confirmed) |
| Email one-time code | `/auth/v1/otp` → `/auth/v1/verify` (type `email`) | The email template must include `{{ .Token }}` for the 6-digit code |

**Why Apple sign-in is offered.** Guideline 4.8 requires it when Google sign-in is offered.

---

## 2. Endpoint map for the native app

| Native use | Route | Auth | Status |
|---|---|---|---|
| Device identity | `POST /api/session/anon` | none; limited to 10 per IP per hour | **New** on native-ios |
| Feed: For you, Following, creator, category | `GET /api/feed` | viewer header | Works. `surface=following` **fixed** on native-ios (it was ignored); feed cursor **fixed** (it skipped one video per page) |
| Search | `GET /api/search` | viewer header | Works. Now covered by the proxy, so a client-chosen unsigned id is no longer trusted |
| Engagement and telemetry | `POST /api/events` | viewer header | Works (header accepted on native-ios) |
| Like/save/follow state | `GET /api/me/reactions?video_ids&seller_ids` | viewer header | **New** |
| Saved list | `GET /api/me/saved` | viewer header | **New** |
| Checkout | `POST /api/checkout/intent` | viewer header (+ Bearer when signed in) | Works. See §3 |
| Link device to account | `POST /api/session/link` | Bearer + viewer | Works (header accepted) |
| Payout status | `GET /api/stripe/onboarding/status` | Bearer | Works |
| Payout onboarding | `POST /api/stripe/onboarding/start` → hosted URL | Bearer | Works. The return URL is the website, so the app re-checks status when the browser closes |
| Create a drop + upload | `POST /api/drops` → Mux `PUT` | Bearer | **Legacy model.** See §5 |

### Not used by the app, and why
| Route | Reason |
|---|---|
| `/api/checkout` (Stripe Checkout) | Legacy `drops` flow, broken in both schemas (audit D §0.1); in-app checkout uses `checkout/intent` |
| `/api/waitlist`, `/api/report` | Legacy `drop_id` keys; the app reports through the `report` event (telemetry only) |
| `/api/dashboard/stats`, `/api/orders/export`, `/api/drops/{id}/restock` | Legacy `drops`/`orders.drop_id` |
| `/api/discounts`, `/api/settings/address`, `/api/orders/{id}/retry-label` | Bearer-capable now, but not yet in the native Studio (roadmap M4) |
| `/api/stripe/onboarding/refresh`, `/auth/callback` | Browser redirect targets |
| `/api/webhooks/*` | Server-to-server only |

### Direct Supabase access from the app
**None, by design.**
- **RLS doesn't fit.** The public read policies on `profiles`, `videos` and `products` apply only to the `anon` role, so a signed-in user's JWT can't read other sellers' content (audit A §2).
- **The viewer has no Postgres identity.** Every viewer table (`viewer_video_reactions`, `follows`, `feed_events`, …) has RLS on with no client policies, because the anonymous device has no JWT.
- **So all reads go through the API routes**, which scope service-role queries to the verified identity.

---

## 3. Checkout contract (native)

Request (`POST /api/checkout/intent`):
```json
{ "video_id": "<uuid>", "product_id": "<uuid>", "quantity": 1,
  "selection": { "Color": "Chocolate" }, "idempotency_key": "<16–64 chars>", "email": "buyer@example.com" }
```
Response:
```json
{ "clientSecret": "pi_…_secret_…", "paymentIntentId": "pi_…", "subtotalCents": 7800,
  "shippingCents": 624, "totalCents": 8424, "title": "The Studio Tote", "sellerHandle": "maya" }
```

**Server authority (Confirmed, `checkout/intent/route.ts`):**
- The product must be attached to the video.
- The video must be `live` and the product `active`.
- Inventory must cover the quantity, or the route returns 409 `sold_out` with `available`.
- The seller must have `charges_enabled` and a `from_address`.
- Variant deltas are read from the stored product, and shipping is estimated by EasyPost.
- The Connect destination charge and application fee are set server-side.
- The Stripe idempotency key is `pi_<key>`.

**Native side:**
- **Email.** The app always sends `email`; the web never did, which left `buyer_email` empty (audit D §0.2 #1).
- **Shipping address.** Collected in Stripe's address element and attached by PaymentSheet at confirm (`StripePaymentPresenter.swift`). The webhook copies `intent.shipping` to the order, and the label purchase requires it (`fulfillment.ts:220`).
- **No `purchase` event** is sent by the app. Only the webhook records a purchase.

**Backend follow-ups (Proposed):**
- Make the inventory decrement idempotent on webhook retry (audit D §0.2 #4).
- Handle refund and dispute webhooks.
- Collect sales tax.
- Add an order-status-by-PaymentIntent endpoint, so the app can show "Order placed" from server truth.

---

## 4. Media (Mux)

- **Playback.** `https://stream.mux.com/{playback_id}.m3u8`, public policy, no token. Assets are created with `playback_policy: ['public']` (`api/drops/route.ts`). Confirmed: no Mux secret is ever needed on the device.
- **Thumbnails.** `https://image.mux.com/{id}/thumbnail.webp?time=&width=`.
- **Upload.** The server creates a direct upload (`mux.video.uploads.create`); the app `PUT`s the file with progress.
  - **Proposed:** set `cors_origin` only for browser uploads. It currently uses `NEXT_PUBLIC_APP_URL`, which doesn't matter for native `PUT`s.

---

## 5. Gaps the native app is blocked on

| # | Gap | Effect on native | Proposed fix | Evidence |
|---|---|---|---|---|
| 1 | **Production runs the legacy schema**; chain 00006–00017 not applied | No feed content, no purchase path, live RLS holes | Apply the chain per `docs/production-migration/PREFLIGHT.md` after its blockers clear | audit A §0.1, §0.4 |
| 2 | **No videos/products creation path**; Mux webhook only updates `drops` | Creator uploads never reach the feed | `POST /api/studio/videos` creating `products` + `videos` + `video_products` with a Mux upload (passthrough = video id); Mux webhook sets `videos.mux_playback_id`/`status` | audit A §0.3 |
| 3 | **No comments backend** | Comments omitted from the native UI | `comments` table + RLS + `GET/POST /api/videos/{id}/comments` + moderation/report | audit C §3 |
| 4 | ~~No account deletion~~ **Built:** `DELETE /api/me` with body `{"confirm":"DELETE"}` | App Store 5.1.1(v) | Deletes the auth user, which cascades to the profile and listings. Orders the user placed as a buyer stay with the seller, with `buyer_viewer_id` set to NULL. A seller with buyer orders gets a 409 `seller_has_orders`, to be closed by support (otherwise the cascade would delete those orders) | `src/lib/account-deletion.ts` |
| 5 | ~~No buyer order history~~ **Built:** `GET /api/me/orders` | Profile → Orders | Matches orders by `buyer_anon_id` across this device's identity and every identity the account owns. A device identity claimed by another account is excluded, so a shared device never shows the previous person's orders or addresses. Orders are not matched by `buyer_email`, because that email is typed at checkout and unverified. Needs the post-migration schema (`order_items`, `total_cents`) | `src/lib/buyer-orders.ts` |
| 6 | **No categories endpoint** | Discover can't show category tiles | `GET /api/categories` (public read) | DRIP_SCREEN_INVENTORY.md |
| 7 | **No per-video share route** | Share links go to the site root | `/v/[videoId]` page + `apple-app-site-association` | `src/proxy.ts` matcher lists `/v/*` with no route |
| 8 | `claim_anon_identity` 23505 on second device | Link fails silently on a second device | Allow multiple canonical identities per user, or return false instead of raising | audit A §0.6 |
| 9 | Like/save are events, so dedupe can drop a quick re-like | Rare stale heart state | Dedicated idempotent `PUT /api/me/reactions/{videoId}` | `00008` dedupe key; `00017` |

---

## 6. Changes made on `native-ios` (all backward-compatible)

| Commit area | Files | Tests |
|---|---|---|
| Bearer auth | `src/lib/bearer.ts`, `src/lib/supabase-server.ts` | `src/lib/__tests__/native-identity.test.ts` |
| Signed viewer header + mint route | `src/lib/anon-request.ts`, `src/app/api/session/anon/route.ts`, feed/search/events/intent/link routes | same |
| Proxy honours the signed header; covers search | `src/proxy.ts` | same |
| Reaction and saved read-back | `src/app/api/me/reactions/route.ts`, `src/app/api/me/saved/route.ts`, `src/lib/validation.ts` (`parseUuidList`) | same |
| Following surface | `src/lib/feed/slice.ts`, `ranked-slice.ts` | `ranked-slice.test.ts` |
| Feed cursor | `src/lib/feed/slice.ts` | `slice.test.ts` (fails on the old code) |
| Like/save clobber | `supabase/migrations/00017_reactions_no_clobber.sql` | executed against PostgreSQL 16 (7 sequences); not yet applied anywhere |

Web suite: 886 passed, 1 skipped; `tsc --noEmit` clean.

---

## 7. Vercel

- **Two projects build every push to this repo:** `drip` (new, `prj_XpjIReKhmhj9div165dWiJqshIxk`) and `drip-backend` (current production, `prj_axftVSFn4O1ahYNmbP8W9IhgWVdW`). Both preview deployments for `native-ios` built successfully (Vercel bot on PR #14).
- **`drip-deploy`** appears unused.
- **Migration plan and the secret-copy constraint:** DRIP_RELEASE_CHECKLIST.md §Vercel.
