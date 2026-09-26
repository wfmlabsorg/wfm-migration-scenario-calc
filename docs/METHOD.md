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
   fractional agents interpolated between neighbouring integers. This is the **sizing** need
   behind required FTE, whatever the service model.
6. Under the **Erlang A** service model (the default), each bucket also gets an Erlang A curve
   (M/M/N+M): waiting customers give up after an exponential patience (default 120 s voice,
   300 s chat). Its need at target drives allocation and its service level and abandon rate are
   what the week delivers. Service level is answered within the threshold ÷ **all** offered, so
   abandoners count as misses. The formulas are exact (a series normalised through Erlang B) and
   are checked against an event-by-event simulation in `tests/erlangA.test.ts`.

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

**Why spreading a shortfall usually hurts.** Under Erlang C, phone and chat queues near capacity are steeply non-linear. A few percent fewer agents can take service from target to near zero, so sharing a shortfall pushes voice and chat over that cliff, while strict priority lets email's backlog absorb it. Equal attainment maximises the worst channel, which is what the grade scores, so it tends to grade best. It is fair week by week, and the email backlog it defers is repaid through later weeks' due. Under Erlang A the cliff is softened: an overloaded queue sheds callers instead of growing forever, so sharing policies keep partial service at the cost of abandonment. On the demo at 260 FTE, share-the-shortfall's worst voice service rises from 0% (C) to 51% (A) with peak abandonment of about 16%. The default policy reproduces the pre-balancing engine exactly (regression fixture in `tests/fixtures`).

The complete equations are in `src/lib/equations.ts`. They are included verbatim in the analyst's instructions and in every exported scenario dossier.

## Measures

- **Service level** (Voice, Chat): the volume-weighted service level across the buckets, from
  the service model (Erlang A: answered in time ÷ all offered; Erlang C: no abandonment).
- **Abandonment** (Erlang A): the volume-weighted abandon rate. Forecast volumes already contain
  today's redials, so only abandonment above the week-0 rate creates extra contacts: the redial
  share of them is added to next week's volume (scaled by the share of the book still there),
  and that week's loads, needs and required FTE are recomputed.
- **Grade cap** (Erlang A): a week whose worst voice or chat abandon rate is above the cap
  (default 10%) grades BBB at best; above twice the cap, CCC at best. An unstable Erlang C queue
  (agents ≤ load) scores 0.05; Erlang A queues are always stable.
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

Uncertainty comes from the **assumption register**. The tool asks about 19 generic questions
(timing, people, demand, service); each answer sets one or more inputs and carries a range
(low, likely, high) and a status:

| Status | Range |
|---|---|
| Not asked | A deliberately wide generic range around the current value |
| Estimated | The range someone gave ("about 4 months, could be 6" → 13 / 17 / 26 weeks) |
| Confirmed | A point, or a narrow range if one was given |

When uncertainty is on, each future draws **every** register entry that has a range from PERT
(low, likely, high), and attrition binomially. Each input has its own seeded random stream, so
answering one question does not reshuffle the others, and scenario A and B see the same futures.
The chart header reports the **average band width** (mean 90th − 10th percentile over scored
weeks and channels) and its previous value, so each answer shows how much it narrowed the
forecast. Binomial attrition is real process noise, so the bands never reach zero. In the
simulation only, offered loads are rounded to 3 significant figures so Erlang curves are reused.

A project can add its own questions (for example, questions put to the owner of a planning
workbook) that map to the same inputs.

**Shape cards** carry a scenario without its scale: timing, rates, ratios, handle times, the
register and project questions, with week-0 cover and the workload mix instead of volumes and
headcount. The Claude Desktop pack exports one; the tool rebuilds volumes for a chosen team size
so that cover and mix match. Queue economics depend on size, so pick a size near the real one. The chart's line always
shows the most-likely inputs; it is not the median of the futures.

## Limits

- **Service model.** Under Erlang C nobody hangs up, so overload shows service near zero. Under
  Erlang A, patience is one exponential average per channel (real patience varies by customer and
  by wait announcements), and abandoners beyond the redial share are assumed lost. Required FTE
  is sized with Erlang C in both models, which is conservative. Links made before v1.2 open on
  Erlang C so their numbers reproduce.
- **Service doesn't feed back into demand.** Clients don't leave because service is poor.
- **One blended team** with a fixed priority. Specialised teams would need separate pools.
- **Weekly granularity.** Same-day email targets are approximated by the backlog-days measure.
