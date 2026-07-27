# Competition Platform — Context Pack for New Build

**Source:** audit of `PeacockIllustrated/hawk-games` @ `e2833ff` (The Hawk Games, UK skill-based prize competitions, Firebase stack).
**Purpose:** tell a new competition-page project what to lift, what to rewrite, and what to leave behind.
**Method:** static read of the whole backend + frontend. Nothing was deployed or executed — there is no test suite, no CI, and no emulator run in this audit. Every claim below is traceable to a `file:line`. Where I could not verify behaviour without a live project, I say so.

**Headline:** the *payments spine and the security model are genuinely good and worth carrying over*. The *prize-awarding, draw, and compliance execution are not finished* — and the repo's own README claims they are. Trust the code, not the docs.

---

## 1. Salvage verdict at a glance

| Area | Verdict | Why |
|---|---|---|
| Trust Payments HPP integration | **Lift** | Correct, server-authoritative, signed both directions |
| Webhook verification + idempotency | **Lift** | Proper hash check, replay-safe, forces provider retry |
| Server-authoritative pricing & oversell guard | **Lift** | Client never sends a price |
| Transactional fulfilment | **Lift, fix numbering** | Atomic, but three conflicting ticket-numbering schemes |
| Firestore rules skeleton | **Lift, fix admin model** | Default-deny + server-only writes is right |
| Competition state machine (`comp-state.js`) | **Lift the idea, share the code** | Duplicated client/server instead of shared |
| Order-first checkout pattern | **Lift** | Best decision in the codebase |
| Zod validation + App Check + secrets | **Lift** | Standard, correct |
| Legal/compliance *thinking* | **Lift** | The framework is sound and hard-won |
| Legal/compliance *implementation* | **Rewrite** | Skill question and free entry route are both broken |
| Draw / winner selection | **Does not exist** | Stub returning `"TBD"` |
| Instant win / spinner / plinko | **Rewrite or drop** | `Math.random()`, unvalidated odds, no provable fairness |
| Admin panel | **Rewrite** | Client-side privileged writes, blocked by own rules |
| Frontend build/architecture | **Rewrite** | Mixed SDK versions, duplicate init, 69KB CSS, no build step |
| Cash/credit economy | **Drop unless client asks** | 1.5× conversion is an unbounded liability |

---

## 2. Lift as-is (adjust lightly)

### 2.1 The order-first checkout pattern — the single best idea here

`functions/index.js:373-386` creates the Firestore order document **before** redirecting to the payment provider, and uses `orderRef.id` as the provider's `orderreference`.

Everything downstream depends on this: the webhook has a guaranteed reconciliation key, the success page can subscribe to a document that doesn't exist yet, and a dropped browser session never loses the transaction. **Carry this over verbatim.**

Paired rule (`firestore.rules:66-79`): allow `get` on an order if the doc doesn't exist yet *or* the caller owns it. That lets `success.html` open a listener the instant the user returns from the payment page and have it fire when the webhook writes.

> Adjust: the pre-create branch lets any signed-in user probe whether an arbitrary order ID exists. Low severity, but in the new build scope the listener to `orders` where `userId == uid` instead, or have the client pass an order ID it was handed by the callable.

### 2.2 Server-authoritative pricing

`functions/index.js:61-80` (`resolveUnitPricePence`) and `:362-371`. The client sends **only** `{compId, qty}` (`app/js/payments.js:51-71`). Price, currency and amount are derived server-side from the competition document.

`:355-360` re-checks state and remaining capacity server-side before creating the order — the client's view is never trusted.

**Carry this over.** It is the difference between a competition site and a liability. In the new build, keep prices in integer pence only (see §5).

### 2.3 Webhook signature verification

`functions/index.js:467-497`. Three details worth preserving because they were clearly learned the hard way:

1. Fields concatenated in an **exact agreed order**, with blanks omitted (`:467-475`).
2. `notificationreference` explicitly excluded from the hash (`:466`).
3. Returns **401 on mismatch** (`:495`) so the provider keeps retrying, rather than swallowing a misconfiguration silently.

Outbound direction (`:109-119`): SHA-256 over `currencyiso3a + mainamount + sitereference + timestamp + password`, result prefixed with `h`. The `h` prefix is a provider quirk — keep the comment.

> If the new client uses Stripe instead, the *shape* transfers directly: verify signature → check idempotency → update order → fulfil. Only the hash construction changes.

### 2.4 Webhook idempotency

`functions/index.js:517-521` short-circuits if the order is already `paid`/`failed`/`cancelled`; `:162-165` short-circuits fulfilment if `fulfilled === true`. Payment providers retry aggressively — without this you double-allocate tickets. **Keep both layers.**

### 2.5 Transactional fulfilment

`functions/index.js:171-298`. All of: entry write, competition counter, user entry count, and sold-out transition happen in one `runTransaction`. Contiguous ticket ranges are allocated as `ticketStart`/`ticketEnd` rather than storing an array per ticket — correct choice, keeps documents small at 100k+ tickets.

**Keep the structure. Fix the numbering bug in §4.6 before reusing.**

### 2.6 Firestore rules skeleton

`firestore.rules` is the strongest file in the repo. The pattern to carry:

- Default-deny catch-all last (`:101-103`).
- Money-touching collections are **server-write-only**: `entries`, `orders`, `tickets`, `pastWinners` all have `allow create, update, delete: if false` (`:59, :78, :85, :97`).
- Ownership helpers, and a self-elevation guard on user create/update (`:32-39`) — a user cannot set their own `isAdmin` or `loyalty`.
- Collection-group rule for `entries` (`:56-60`) so account history works without opening the collection up.

**Carry the shape. Replace the admin model (§4.1).**

### 2.7 Competition state machine

`app/js/lib/comp-state.js` derives `live | closed | sold_out` from capacity, sold count, `closeMode` and `closeAt` — never from a stored status string alone. `functions/index.js:342-353` implements the same logic server-side.

The **thinking** is right: status is computed, not trusted. The **execution** is wrong: it's copy-pasted into two places that will drift.

> New build: put this in one shared module imported by both client and functions (a small `shared/` package, or duplicate it with a test that asserts both agree).

### 2.8 Small things worth keeping

- Zod schemas on every callable (`functions/index.js:598-609, 745-750, 807-815`).
- Secrets via `defineSecret` (`:37-45`), never committed. I checked — **no secrets are committed** in this repo. Firebase web config keys (`app/js/firebase-config.js`) are public by design and are fine.
- `enforceAppCheck: true` on callables (`:24`).
- The `el()` DOM helper (`app/js/competition.js:71-87`) for XSS-safe rendering — good helper, though the codebase doesn't use it consistently (§4.9).
- Explicit function region pinned client-side (`app/js/payments.js:13`) to match v2 deployment. Easy to forget, breaks silently.

---

## 3. Lift the thinking, rewrite the code

### 3.1 UK legal compliance framework

`context/LEGAL_CHECKLIST.md` and `context/AI_INSTRUCTIONS.md` encode real, correct UK Gambling Act 2005 reasoning. **This is the most valuable non-code asset in the repo.** The pillars:

- Every paid competition needs a **non-trivial skill question** — this is what makes it a competition and not an unlicensed lottery.
- A **Free Entry Route** (postal) must exist, be advertised with equal prominence, and be treated *identically* to paid entry in draws and limits.
- Users never pay directly for a game of chance; tokens are a promotional bonus attached to a skill-based entry.
- Per-user entry limits, 18+ confirmation, named promoter entity, T&Cs / privacy / FAQ pages.

`app/free-entry-route.html` is a well-drafted postal FER policy — specific about class of post, one entry per envelope, receipt deadlines, void conditions. **Reuse as a drafting template** (swap the entity and address).

> Carry the framework. Do **not** carry the implementation — both load-bearing mechanisms are broken (§4.2, §4.3). And have a solicitor review the final wording; the checklist is a developer's reading of the rules, not advice.

### 3.2 Three-tier competition model

Hero (one flagship prize) / Main (standard draws) / Instant Win (tokens per ticket). Good commercial structure, clean to merchandise, easy to explain to a client. Worth proposing.

### 3.3 Safety-net scheduler

`functions/index.js:565-590` — a cron that re-runs fulfilment for paid-but-unfulfilled orders. Exactly the right instinct: webhooks fail, and money taken without tickets issued is the worst failure mode.

**The implementation does not work** (§4.4). Rebuild it, keep the intent, and add alerting when the queue is non-empty.

### 3.4 Deployment/config workflow

`firebase.json` + `.firebaserc` + `defineSecret` + separate deploy targets (`functions` / `firestore:rules` / `hosting`) is a sane, cheap-to-run setup. A competition page does not need Kubernetes.

> Adjust: `"public": "."` (`firebase.json:19`) publishes the **entire repository root** as the web root, relying on a blocklist to hide things. That is backwards — one forgotten file gets published. Use a dedicated build/output directory as the hosting root.

---

## 4. Confirmed defects — do not recreate

Everything here was verified by reading the code. Severity is for a **money-handling, legally-regulated** product.

### 4.1 CRITICAL — Two incompatible admin models; all admin functions are dead

- `functions/index.js:126-129` authorises admins via **custom claims**: `request.auth.token.admin === true || token.role === "admin"`.
- `firestore.rules:9-13` authorises admins via a **Firestore field**: `users/{uid}.isAdmin == true`.
- `setCustomUserClaims` is **never called anywhere** in the repo (verified by grep across `functions/` and `app/js/`).

So no user can ever satisfy the callable guard. `getRevenueAnalytics` (`:691`) and `drawWinner` (`:966`) permanently throw `permission-denied`, while the admin *UI* gates on `isAdmin` (`app/js/admin.js:58`) and happily lets an admin in — to click buttons that always fail.

> **New build:** pick one. Custom claims are the right answer for backend authorisation (no extra read, works in rules via `request.auth.token.admin`). Ship a `setAdminRole` callable or a one-off script, and make rules and functions read the *same* signal.

### 4.2 CRITICAL — The skill question is not enforced anywhere on the server

The legal basis of the whole product is client-side only:

- Answer is checked in the browser at `app/js/competition.js:220` and `:252`.
- The correct answer is stored on the competition doc and `competitions` is **world-readable** (`firestore.rules:46: allow list, get: if true`) — so the answer is publicly fetchable before any interaction.
- `createTrustOrder` (`functions/index.js:304-435`) never receives or validates an answer.

Anyone can call the checkout callable directly and buy tickets without ever seeing the question. `LEGAL_CHECKLIST.md` ticks this as done.

> **New build:** never ship the correct answer to the client. Store answers in a separate admin-only collection (or hash them). Have the client submit its answer to the checkout callable, validate server-side, and record the submitted answer on the entry for audit. Refuse the order on a wrong answer.

### 4.3 CRITICAL — The Free Entry Route cannot actually be executed

`app/js/admin.js:872-899` adds a postal entry by writing to `competitions/{id}/entries` **directly from the browser**. The rules block exactly that: `firestore.rules:56-60` denies `create` on any `entries` document unconditionally (`allow create, update, delete: if false`).

The whole transaction fails, so no FER entry can be recorded. The legally-required equal-treatment route is non-functional, and `LEGAL_CHECKLIST.md` ticks it as working.

> **New build:** FER entry creation is a privileged server callable, same allocation path as paid entries, tagged `entryType: 'free_postal'`, counting toward the same limits and the same draw pool.

### 4.4 CRITICAL — The fulfilment safety net never fires

- `retryUnfulfilledPaidOrders` queries `where("status","==","paid").where("fulfilled","==",false)` (`functions/index.js:572-577`).
- `createTrustOrder` never sets `fulfilled` when creating the order (`:374-386` — the field is absent).

Firestore equality filters **do not match documents missing the field**. So the only orders the retry can ever find are ones already touched by a successful fulfilment — which set `fulfilled: true` (`:293`). The safety net matches nothing, ever.

This compounds badly: `trustWebhook` catches fulfilment errors and still returns `200` (`:546-550`, `:556-560`), deliberately preventing provider retries. So a fulfilment failure means **payment taken, tickets never issued, no retry, no alert** — only a log line.

> **New build:** initialise `fulfilled: false` at order creation, *and* have the retry query on `status == "paid"` with a `fulfilledAt == null` check, *and* return non-2xx on fulfilment failure so the provider retries, *and* alert when the unfulfilled queue is non-empty. Belt, braces, and a pager.

### 4.5 HIGH — There is no draw

`drawWinner` (`functions/index.js:966-990`) is a stub: it validates admin and competition status, then returns a hardcoded `{ winnerDisplayName: "TBD" }` with a `// NOTE: plug in your real draw implementation here` comment. The scheduled weekly draw is commented out (`:1023-1025`) — the cron only flips status to `ended`.

`LEGAL_CHECKLIST.md` §4 ticks "provably fair way to draw a winner" as complete, referencing this function.

> **New build:** the draw is a first-class feature, not a TODO. It must include paid + FER entries in one pool, be atomic, write an immutable audit record, and publish a verifiable seed/method if you advertise provable fairness.

### 4.6 HIGH — Three conflicting ticket-numbering schemes

| Path | Start | Reference |
|---|---|---|
| Card / Trust fulfilment | `ticketsSold + 1` (**1-based**) | `functions/index.js:191, 194-195` |
| Site credit | `ticketsSold` (**0-based**) | `functions/index.js:654, 664-665` |
| Admin FER | `ticketsSold` (**0-based**) | `app/js/admin.js:894-895` |

Mixing paths on one competition produces overlapping and duplicated ticket numbers. For a prize draw that is a disputed-result and refund event, not a cosmetic bug.

> **New build:** one allocation function, one convention (1-based reads better to users), used by every entry path. Assert `ticketEnd - ticketStart + 1 === qty` and test it.

### 4.7 HIGH — Prize outcomes use `Math.random()`

`functions/index.js:778` (spinner) and `:930-932` (plinko) determine real cash and credit prizes with `Math.random()` — not cryptographically secure, and not seeded/auditable. `DATA_MODELS.md` describes an `instantWinsConfig.positionsHash` for provable fairness that is **never implemented anywhere**.

Related: the spinner builds cumulative probability as `cumulative += 1 / prize.odds` (`:774-777`) with **no validation that the total ≤ 1**. Misconfigured odds silently skew outcomes or make later prizes unreachable — an admin can create an unwinnable or bankrupting prize table with no warning. Plinko's `"weighted"` mode (`:929-932`) hard-codes a 0.55 rightward bias.

> **New build:** if you ship instant wins, use `crypto.randomInt`, validate the odds table sums correctly on write, and implement real commit-reveal (pre-generate winning positions, publish the hash before sale, reveal the seed after). Otherwise drop instant wins from v1 — it is the single biggest source of regulatory and financial risk here.

### 4.8 MEDIUM — Unbounded cash→credit conversion

`transferCashToCredit` (`functions/index.js:806-843`) converts won cash to site credit at **1.5×**, with no cap, cooldown, or audit beyond the balance write. Credit then buys tickets that can win more cash (`allocateTicketsAndAwardTokens`, `:640-646`). Whether that loop is net-positive depends entirely on the prize table — which, per §4.7, is unvalidated.

> **New build:** don't ship a two-currency economy unless the client explicitly wants one and someone has modelled it. If you do: cap it, log every movement to an immutable ledger, and validate the prize table.

### 4.9 MEDIUM — Frontend architecture

- **Mixed Firebase SDK versions.** 20 imports of `9.23.0`, 8 of `10.12.0`. `app/instant-games.html` loads v10 inline while `app/js/instant-games.js` imports v9.23 — two SDK copies, two app registries, on one page. Auth state will not reliably agree.
- **Duplicate initialisation.** `app/js/auth.js:51-53` and `app/js/firebase-init.js:35-38` are parallel init paths, each with the config **hardcoded twice** (`firebase-config.js:2-10`, `firebase-init.js:11-19`).
- **Inconsistent App Check.** `auth.js:57-58` always initialises it; `firebase-init.js:41-48` only if `window.__APP_CHECK_KEY__` is set. Since callables enforce App Check, any page on the wrong path silently fails its calls.
- **XSS surface.** README claims "All `innerHTML` usage has been eliminated" — there are **63 occurrences** across `app/js/`. `admin.js:914` assigns unsanitised strings into `modalBody.innerHTML`.
- **69KB single stylesheet**, no build step, no bundling, no minification. A 4.3MB PNG is committed at the repo root.

> **New build:** one init module, one SDK version, npm-installed and bundled (Vite), no CDN imports, no hardcoded config duplication. `textContent` or a helper for all data rendering.

### 4.10 MEDIUM — No tests, no CI, no indexes

- Zero test files. `functions/package.json:13` has `"test": "echo \"(no tests)\""`.
- No `.github/` — nothing runs on push.
- **No `firestore.indexes.json`**, despite `collectionGroup("entries")` queries (`functions/index.js:728`) and multi-field order queries (`:572-577`) that require composite indexes. These fail at runtime in production with an index-required error, not at deploy.

> **New build:** commit the index file. Test the money paths at minimum — hash construction, webhook idempotency, ticket allocation, oversell — against the Firebase emulator. Run them in CI.

### 4.11 LOW — Documentation actively misleads

`README.md` states the platform is "build ready", "feature-complete", with a "Functional Admin Panel", eliminated XSS, and Google-Sign-In-only auth. `IMPLEMENTATION_NOTES.md` claims `firestore.rules` requires `email_verified` on order/entry creation — the rules contain no such clause (creation is denied outright, `:59, :78`).

The docs describe an intended system; the code implements a partial one. **Anyone onboarding from the README will make wrong assumptions.** In the new project, treat docs as generated from or checked against reality.

---

## 5. Recommended data model for the new build

Cleaned up from `context/DATA_MODELS.md` and what the code actually does.

```
competitions/{compId}
  title, prizeDescription, prizeImages[]
  status              'draft' | 'live' | 'closed' | 'sold_out' | 'drawn'   # computed-derived, not sole truth
  closeMode           'date' | 'sellout'
  closeAt             Timestamp
  totalTickets        Number        # ONE capacity field. Not totalTickets|capacity.
  ticketsSold         Number        # ONE sold field. Not ticketsSold|soldCount.
  ticketPricePence    Number        # integer pence ONLY. No float GBP anywhere.
  ticketTiers[]       [{ qty, pricePence }]   # optional bundles, still integer pence
  userEntryLimit      Number (default 75)
  skillQuestionId     String        # -> skill_questions/{id}, answer NOT stored here
  promoterEntity, cashAlternativePence, fallbackClause

skill_questions/{id}          # admin-read-only; NEVER world-readable
  text, answers[], correctAnswer

competitions/{compId}/entries/{entryId}      # server-write only
  userId, userDisplayName
  qty, ticketStart, ticketEnd                # 1-based, one allocator
  entryType    'paid' | 'credit' | 'free_postal'
  orderId, skillAnswerGiven, enteredAt

orders/{orderId}                             # server-write only
  userId, items[], amountPence, currency
  status       'created' | 'paid' | 'failed' | 'cancelled'
  fulfilled    Boolean    # ALWAYS initialised false at creation
  fulfilledAt, provider, providerRef, isTest, createdAt, updatedAt

users/{uid}
  displayName, email, isAdmin(claim-mirrored), marketingConsent (default false)
  entryCount { [compId]: Number }

draws/{compId}                               # server-write only, immutable
  entryPoolSize, winningTicketNumber, winnerId, winnerDisplayName
  seed, method, drawnAt, drawnBy

pastWinners/{id}                             # public read, server write
audits/{id}                                  # admin read, server write
```

**Rules of thumb baked in above:**

1. **One field per concept.** The old code defensively reads `totalTickets ?? capacity` and `ticketsSold ?? soldCount` everywhere (`functions/index.js:228-237, 343-345`; `comp-state.js:1-2`), and even branches on which field exists when writing (`:235-237`). That defensiveness is a symptom of an undecided schema — it doubles every read site and will eventually write the wrong field. Decide once, migrate, delete the fallbacks.
2. **Integer pence everywhere.** The old code mixes GBP floats and pence and divides tier price by amount to recover a unit price (`functions/index.js:66-74`, `competition.js:112-122`). Every one of those is a rounding bug waiting to be a refund.
3. **Answers never reach the client.**
4. **Every money collection is server-write-only.**

---

## 6. Build order for the new project

Assumes a single competition page + checkout is the client's ask; scale up if they want the full platform.

**Phase 1 — Foundation**
1. Vite + one Firebase SDK version, npm-installed, single init module, config from env.
2. Firestore rules with default-deny, server-only writes on money collections, one admin signal (custom claims) used by both rules and functions. Commit `firestore.indexes.json`.
3. Emulator setup + CI running tests on push.

**Phase 2 — Competition read path**
4. Data model above; seed script; admin creation form.
5. Shared computed state module (`live|closed|sold_out`) imported by client and functions.
6. Competition page: prize, gallery, countdown, ticket slider, live remaining count.

**Phase 3 — Money path (the part that must not be wrong)**
7. Skill question: served without the answer, submitted to the server, validated server-side, recorded on the entry.
8. `createOrder` callable — server-authoritative pricing, state + oversell re-check, order doc created with `fulfilled: false`, returns signed provider fields.
9. Client posts hidden form to provider HPP (`payments.js` pattern).
10. Webhook: signature verify → 401 on mismatch → idempotency short-circuit → mark paid → fulfil. **Non-2xx on fulfilment failure.**
11. Single ticket allocator, one numbering convention, used by every entry path. Tests for oversell, double-fulfilment, concurrent purchase.
12. Retry scheduler that actually matches unfulfilled orders + alerting.

**Phase 4 — Compliance**
13. FER admin callable (server-side, same allocator, same limits).
14. Entry limits enforced in the allocator transaction.
15. T&Cs, privacy, FAQ, FER policy pages; 18+ gate; promoter entity named.
16. The draw: paid + FER in one pool, atomic, immutable audit record, published method.

**Phase 5 — Only if asked**
17. Instant wins with real commit-reveal fairness and a validated odds table, or not at all.

**Deliberately excluded from v1:** two-currency economy, plinko, spinner, loyalty. All are risk without proven demand.

---

## 7. Questions to put to the client before quoting

1. **Jurisdiction and model** — UK skill-competition (needs the full skill-question + FER apparatus), or a plain promotional prize draw (much lighter)? This changes the build size more than anything else.
2. **Payment provider** — inherit Trust Payments, or Stripe? The architecture transfers either way; Stripe is materially less integration work.
3. **Scope** — one competition page, or the multi-competition platform with admin?
4. **Instant wins** — wanted? If yes, provable fairness is non-negotiable and adds real time.
5. **Draw process** — automated, manual, or livestreamed? Nothing exists for this; it's a from-scratch build.
6. **Who signs off the legal wording?** The old checklist is a developer's reading, not advice.
7. **Volume** — peak concurrent purchases at a sellout drives how hard the allocator has to be tested. Firestore single-document contention on the competition counter is the bottleneck; high volume needs sharded counters.

---

## 8. One-line summary for the pitch

> We have a proven, production-grade payment and fulfilment spine for UK prize competitions — order-first checkout, signed webhooks, idempotent transactional ticket allocation, and a hardened default-deny data model — plus a fully mapped UK compliance framework. We are reusing that foundation and rebuilding the draw, skill-question enforcement and admin layer properly, rather than carrying forward a half-finished prototype.
