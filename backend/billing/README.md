# Billing

Not built yet. This folder holds the contract a billing program has to meet
and a stand-in that meets it by hand.

A managed deployment has to turn "this person pays for the Plus plan" into
"this account may store 50 GiB". The [server](../server/README.md) knows
nothing about payments, on purpose. A separate program takes them and tells
the server what each account's plan allows, through the server's admin
interface. The server enforces whatever it was last told.

## The stand-in

`set-plan.mjs` sets an account's limits from a named plan in a JSON file. A
person names the plan where a payment provider would. It needs the server's
admin interface on, which means `MINDSTREAM_ADMIN_TOKEN` set on the server and
passed here:

```sh
export MINDSTREAM_ADMIN_TOKEN=<the server's token>
node backend/billing/set-plan.mjs --server http://localhost:3735 --user ann --plan plus
node backend/billing/set-plan.mjs --user ann --plan plus --lapsed   # read-only
node backend/billing/set-plan.mjs --user ann --plan none            # no limits
node backend/billing/set-plan.mjs --user ann --show
```

The plans in [plans.example.json](plans.example.json) are placeholders. Tiers
and prices have not been decided. Copy the file, change the numbers and pass
it with `--plans`.

## What the real program has to do

1. Receive the payment provider's webhooks: a subscription started, renewed,
   changed or lapsed.
2. Know which account a paying customer is. The username has to be attached to
   the customer when they subscribe, since the server will not look anyone up
   by email address.
3. Send the plan's limits to
   `PUT /admin/v1/account/{username}/entitlements/`. The body and the other two
   routes are described in the server's
   [administration docs](../../docs/server-administration.md#from-another-program).
4. When a subscription lapses, send the same limits with `readOnly: true`. The
   account can still read and delete. Nothing is removed, and paying again
   lifts it.
5. Compare its records with the server's now and then. A webhook can go
   missing, and the server keeps the last thing it was told for ever.

The server never sees payment data, and the billing program never sees
anything an account stores. The admin interface can set limits and read usage
and nothing else.

## Where it will live

Undecided. See the open points in
[docs/server-design.md](../../docs/server-design.md#open-points).
