# Pine Points

The practice app's leaderboard competition. Points for using Pine, a ranked
board, and prizes at the end of a season.

Only runs where `POINTS_ENABLED=true` **and** `VIRTUAL_TRADING=true`. On a
real-money instance the module registers no controllers, binds no listeners
and schedules no jobs, so the routes genuinely do not exist. The two flags are
anded together in `configuration.ts` rather than merely documented, so the
competition cannot be switched on against the real ledger by mistake.

## Why it is shaped this way

**Points are the server's.** The app may claim that something happened; it
never decides what that is worth, how long ago it was, or whether it has
already been paid for. Real prizes are at stake.

**One writer.** `PointsAwardService.award()` is the only thing that writes a
`point_event`. There is no second call site where a cap check could be
forgotten.

**Caps are real, not advisory.** A unique `dedupeKey` stops a *replay*, but
not a *race*: ten settlements arriving at once carry ten different trade ids,
and each would read "no sells yet today" and pass a cap of two. Practice
orders fill instantly, so that race is one shell script away. `award()`
therefore takes a per-user advisory lock for the length of its transaction.

**Days are Malawi days.** Every cap is measured in `Africa/Blantyre` calendar
days. Under a naive UTC day, someone trading after 10pm local time would still
be on "yesterday" and could collect two days of caps in two hours.

**Nothing calls in.** The module learns about the platform from the event bus
only: `auth.user.registered`, `auth.user.loggedin`, `wallet.updated`, and
`trading.trade.settled`. Handlers swallow their errors — a points failure must
never break a settlement.

## The rules

`domain/rule-catalogue.ts` holds what everything is worth. It lives in code,
not the database, because a rule is two halves — the amount, and the condition
that earns it — and the condition is code. Splitting them would mean nobody
reviews a change to the amount. The season window, which really is operational
data, is a row.

Two deliberate choices in that table:

- **Buying pays more than selling (20 vs 15).** A buy-then-sell round trip
  must never be more profitable than buying and holding.
- **A sell only scores when the stock was bought on an earlier day.** This is
  the measure that actually kills wash trading. Enforced in
  `points-listener.service.ts`, not in the catalogue, because it is a
  condition rather than a price.

The app renders its earn screen entirely from `GET /points/rules` and hardcodes
no values, so changing a number is a backend deploy rather than an app release.

## Ranking

Live on every read. The cohort is small, and a board that disagrees with the
total a user just watched go up is a support ticket. `cachedRank` exists only
to draw the movement arrow, which is meant to compare against an older state.

`leaderboard.service.ts` holds two queries that must describe the same
ordering, term for term: the `RANK()` window function for a page, and a
"how many people beat me, plus one" count for a single user. If they ever
drift, a user's own rank and their position in the list disagree. They are
adjacent in the file for that reason.

Tie-break: points, then who reached that total first, then id — the last so
two identical rows cannot swap places between two reads.

## Files

| Path | What it is |
|---|---|
| `domain/rule-catalogue.ts` | What each rule pays and how often |
| `domain/dedupe-keys.ts` | Every idempotency key format, in one place |
| `domain/malawi-day.ts` | The calendar day a cap is measured against |
| `services/points-award.service.ts` | The only writer |
| `services/claims.service.ts` | The trust boundary for client claims |
| `services/leaderboard.service.ts` | Ranking |
| `services/points-listener.service.ts` | Event handlers, including the overnight rule |
| `services/milestone.service.ts` | Derived one-time awards |
| `services/points-maintenance.service.ts` | Rank snapshot and nightly reconciliation |
| `scripts/backfill-points.ts` | Gives existing users a fair starting score |

## Backfill

```
npx ts-node -r tsconfig-paths/register src/modules/points/scripts/backfill-points.ts --apply
```

Dry run without `--apply`, and safe to repeat. It replays history through the
same `award()` with the original timestamps, so the live caps apply. Check-ins,
compare opens and notification opens are not backfilled: the server has no
record they happened, and inventing them would fabricate rankings.
