# Method

## The weekly loop

Each run has two passes.

**Demand pass** (independent of staffing). For every week:

1. The existing book shrinks by the runoff rate from the runoff start week, and by any
   step-down scheduled that week.
2. If intake is on, new demand replaces a share of what has run off:
   `new = intake% × (1 − existing)`, so 100% holds volume flat.
3. Waves are entered as shares of the book (30% + 30% + 40% = fully migrated). Each is applied
   as a share of what remains when it cuts over, so the last wave takes the rest. Waves are
   scheduled in weeks after the freeze end, so a longer freeze slips them all.
4. Each channel's weekly volume is spread over three intraday buckets (peak, shoulder,
   off-peak) and converted to offered load per 30-minute interval. Chat uses
   AHT ÷ concurrency.
5. The agents each channel needs to reach its target in each bucket come from Erlang C, with
   fractional agents interpolated between neighbouring integers.

**Supply pass**, in this order every week:

1. **Waves.** The moving share of staff, work and email backlog leaves.
2. **Attrition.** Base annual rate ÷ 52, times 1 before the freeze, the tension effect during
   it, and the post-announcement effect after it. Expected values in the main line; binomial
   draws in the Monte Carlo.
3. **Backfill.** Before the freeze only, back to the starting headcount.
4. **Releases** (if on). After freeze end + notice, staff above the largest requirement in the
   next few weeks (plus a buffer) are released.
5. **Productive hours.** `heads × paid hours × (1 − shrinkage − surge) − training hours`.
   Training is spread over the weeks before each wave for the staff that wave will move.

Headcount always balances exactly:
`start + hired = attrition (pre + freeze + post) + moved + released + end`.

## Allocation within the blended team

Within each bucket:

1. **Voice** takes the agents it needs to reach target (borrowed staff first if eligible, then
   the team's own). If there aren't enough, it takes everything, and its service level is
   whatever those agents achieve.
2. **Chat** does the same with what is left.
3. **Email** is worked from the remaining hours across all buckets. Anything unworked carries
   forward as backlog.
4. **Spare hours** after email go back to Voice and Chat, in proportion to their need, so a
   team with headroom shows service above target rather than pinned to it.

Borrowed staff count as `FTE × paid hours × (1 − base shrinkage) ÷ AHT penalty` productive
hours. They only serve channels marked eligible; hours with nothing eligible to do are
reported as idle. Pooling borrowed staff with the team this way is an approximation: in
practice they may work different hours or need separate routing.

## Channel balancing

The balancing policy decides who absorbs a shortfall:

| Policy | Rule |
|---|---|
| Strict priority (default: voice → chat → email) | Channels take their need in order; the last absorbs the whole shortfall. The order is user-set |
| Protect email | Email is guaranteed a share of its arrivals first; voice and chat then follow the order |
| Share the shortfall | Every channel gets the same fraction of its need (per bucket for voice and chat, across buckets for email) |
| Equal attainment | The largest common attainment (service ÷ target; email: on-time) that fits, found by bisection; falls back to sharing if no queue can be stabilised |

Every policy then works email down to its full due from whatever is left and returns remaining time to voice and chat in proportion to need.

**Why spreading a shortfall usually hurts.** Phone and chat queues near capacity are steeply non-linear (Erlang C). A few percent fewer agents can take service from target to near zero, so sharing a shortfall pushes voice and chat over that cliff, while strict priority lets email's backlog absorb it. Equal attainment maximises the worst channel, which is what the grade scores, so it tends to grade best. It is fair week by week, and the email backlog it defers is repaid through later weeks' due. The default policy reproduces the pre-balancing engine exactly (regression fixture in `tests/fixtures`).

The complete equations are in `src/lib/equations.ts`. They are included verbatim in the analyst's instructions and in every exported scenario dossier.

## Measures

- **Service level** (Voice, Chat): the volume-weighted Erlang C service level across the buckets.
- **Email on-time index**: `min(1, target days ÷ backlog days)`, where backlog days = backlog
  hours ÷ daily arrival hours. It is a first-in-first-out proxy, not a measured turnaround.
- **Required FTE**: the larger of the peak-bucket requirement (which binds when staffing doesn't
  follow the demand shape) and total hours (interactive need, email arrivals, and a quarter of
  any backlog beyond target), expressed in heads at base shrinkage. Surge and training reduce
  *available* FTE; they are never added to required FTE.
- **Utilisation**: work offered ÷ productive capacity. Above 100% the team cannot clear its work.

## Grades

The grades use the same AAA–D- scale and colours as the Risk-Rated Capacity Planner.

- **Week grade** (most-likely inputs).
  - If every channel meets target: `0.70 + 0.30 × min(1, (cover − 1) ÷ 0.10)`, where
    cover = available ÷ required FTE.
  - Otherwise: `0.70 × (worst attainment − 0.5) ÷ 0.5`, where attainment is service ÷ target
    (Email: its on-time index).
  - If a queue is unstable (agents ≤ load): D-.
  - Weeks with no work left are not graded.
- **Futures with no breach** (uncertainty on): the share of simulated futures in which no
  graded week misses a target, graded on the same scale.

## Uncertainty

When uncertainty is on, each future draws these from PERT ranges:
- freeze length
- the tension effect
- the post-announcement attrition effect
- the absence surge
- the runoff rate

Attrition is drawn binomially. The random numbers are seeded, so scenario A and scenario B see
the same futures and differences between them come from the inputs. The chart's line always
shows the most-likely inputs; it is not the median of the futures.

## Limits

- **No abandonment.** Erlang C assumes nobody hangs up, so under overload it shows service
  near zero where in practice callers abandon and the queue is partly relieved. Read
  utilisation alongside it.
- **Service doesn't feed back into demand.** Clients don't leave because service is poor.
- **One blended team** with a fixed priority. Specialised teams would need separate pools.
- **Weekly granularity.** Same-day email targets are approximated by the backlog-days measure.
