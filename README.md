# Product Roadmap — Launch Notifications

Backend for the roadmap launch pipeline: a `queued` status, a notification queue,
and a deploy webhook that releases queued items and emails active users via Resend.

Everything here is **already applied** to Supabase project `iepfgtjizwzbdgxyzaab`.
The files are kept for version control and for replaying into another environment.

## The flow

```
item moves to  queued     ->  trg_prm_enqueue_launch_notification inserts a
                              pending row in product_roadmap_launch_notifications

you deploy in WeWeb       ->  WeWeb webhook POSTs product-roadmap-launch-notify

edge function             ->  opens a batch
                          ->  flips every queued item to launched
                              (the existing trg_prm_status_change logs the history)
                          ->  sends ONE digest email per recipient via Resend
                          ->  records per-person delivery
```

Pulling an item back out of `queued` before the deploy cancels its pending
notification, so nothing ships an announcement for work that got withdrawn.

## Schema

| Object | Purpose |
| --- | --- |
| `product_roadmap_item_status` | gained a `queued` value, ordered between `in_review` and `launched` |
| `product_roadmap_launch_notifications` | the queue — one row per item awaiting release |
| `product_roadmap_launch_batches` | one row per deploy run, with counts and status |
| `product_roadmap_launch_batch_recipients` | per-person delivery: `resend_id`, `error_message`, `sent_at` |
| `product_roadmap_launch_recipients` (view) | the audience definition, in one place |
| `product_roadmap_enqueue_launch_notification()` | the enqueue/cancel trigger |

A partial unique index keeps at most one open (`pending`/`sending`) notification
per item, while still allowing an item to be re-queued after a previous send.

> **`queued` cannot be removed.** Postgres has no `DROP VALUE` for enums. Undoing
> it means recreating the type and rewriting every column that uses it.

## Launch notes

Each item has a `launch_notes` column: the announcement copy that goes out in
the email, kept separate from the internal `description`. Edit it in the item
drawer on the detail page. When it is empty the digest falls back to
`description`, so an item is never announced with a blank body.

## Audience

`product_roadmap_launch_recipients` currently resolves to **312 people**:

```sql
users.status = 'Active'
  and users.email_notifications_enabled
  and users.email is not null and users.email <> ''
```

To narrow it — say, only accounts that can actually log in — redefine the view;
the edge function needs no change:

```sql
create or replace view product_roadmap_launch_recipients as
  select u.whalesync_postgres_id as user_id, u.user_auth_id as auth_user_id, u.name, u.email
  from users u
  where u.status = 'Active'
    and u.user_auth_id is not null          -- <- added
    and u.email_notifications_enabled
    and u.email is not null and u.email <> '';
```

Note that `product_roadmap` uuid columns (`owner_id`, `assigned_to`, `user_id`, …)
point at **`auth.users.id`**, which is `users.user_auth_id` — *not* the `users`
primary key `whalesync_postgres_id`. The view exposes both.

## Before it can run

The function is deployed but **fails closed**: with no secret set it returns 500
and does nothing. To arm it, set the secret in the Supabase dashboard under
Edge Functions → Secrets:

```
LAUNCH_WEBHOOK_SECRET = <a long random string>
```

`RESEND_API_KEY` is already set on this project (shared with `send-vendor-campaign`).

Also confirm `product@updates.superior-maintenance.com` is a verified sender in
Resend — the vendor campaign uses `vendor@` on the same domain, so the domain is
verified, but this specific from-address may need adding.

## Calling it

```
POST https://iepfgtjizwzbdgxyzaab.supabase.co/functions/v1/product-roadmap-launch-notify
x-launch-secret: <LAUNCH_WEBHOOK_SECRET>
Content-Type: application/json
```

| Field | Default | Meaning |
| --- | --- | --- |
| `dry_run` | **`true`** | Preview only. No status flips, no writes, no email. Returns the item list, recipient count, and the rendered HTML. |
| `test_email` | – | Sends one real email to this address. **The queue is NOT consumed and no item is flipped**, so you can iterate on the copy and re-run it freely. |
| `project_id` | – | Only release queued items on one project. |
| `triggered_by` | `weweb-deploy` | Free-text label recorded on the batch. |

**`dry_run` defaults to true.** Anything other than an explicit `"dry_run": false`
is a preview. This is deliberate: a misconfigured webhook cannot email 312 people
by accident.

### Recommended rollout

```bash
# 1. see what would go out - zero side effects
curl -sS -X POST "$URL" -H "x-launch-secret: $SECRET" -H "Content-Type: application/json" -d '{}'
```

```bash
# 2. send one real email to yourself only - still no status flips for anyone else
curl -sS -X POST "$URL" -H "x-launch-secret: $SECRET" -H "Content-Type: application/json" -d '{"dry_run":false,"test_email":"you@example.com"}'
```

```bash
# 3. go live
curl -sS -X POST "$URL" -H "x-launch-secret: $SECRET" -H "Content-Type: application/json" -d '{"dry_run":false}'
```

Steps 1 and 2 are both repeatable — neither consumes the queue nor flips an item.
Only step 3 releases: it flips every queued item to `launched` and emails the
whole audience.

## WeWeb webhook setup

In your deploy workflow, add a REST API call:

- **Method** POST
- **URL** `https://iepfgtjizwzbdgxyzaab.supabase.co/functions/v1/product-roadmap-launch-notify`
- **Headers** `x-launch-secret: <your secret>`, `Content-Type: application/json`
- **Body** `{ "dry_run": false, "triggered_by": "weweb-deploy" }`

`verify_jwt` is off on this function — it authenticates on the shared secret
instead, which is what lets a deploy hook call it without a user session. Keep the
secret out of any client-side workflow; call it from a WeWeb **backend** workflow.

## Sending behaviour

Recipients are sent in chunks of 100 through Resend's batch endpoint — 4 calls for
the current audience rather than 312 individual requests. A chunk that fails marks
just its own recipients `failed`; the rest still go out, and the batch row records
the split.

Items are flipped to `launched` **before** the send, because by then the deploy
has already happened — they are live whether or not the email lands. A failed send
leaves the batch marked `failed` with per-recipient errors for a retry.

## Verified so far

- Trigger tested across all four transitions (queue → cancel → re-queue → launch)
  inside a rolled-back transaction; no test data persisted.
- Function returns 500 with no secret set, 405 on GET — confirmed live.
- **No email has been sent.** Nothing has entered the queue.
