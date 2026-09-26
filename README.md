# Migration Scenario Modeler

**Live:** https://migration.wfmlabs.com · **WFM Labs** · Capacity Planning · L3–L4 · Free

A week-by-week scenario modeler for the period when **demand and staff both leave**: a site
exit, a consolidation, an outsourcing or a transfer. It shows what happens to Voice, Chat and
Email service while a team works through a freeze (no work moved, nobody replaced), natural
runoff, rising attrition, an absence surge, pre-cutover training and migration waves, and
what borrowed capacity would buy back.

Service is rarely lost at the end state of a migration. It is lost in the weeks between, when
staff leave before the work does. A headcount waterfall can't show that; this can.

## What you set

| Area | Inputs |
|---|---|
| Channels | Weekly volume and AHT for Voice, Chat, Email; service targets (Voice/Chat: % answered within N seconds; Email: turnaround in days); chat concurrency |
| Team | Starting FTE, total shrinkage, base annual attrition, paid and open hours |
| Freeze | Start and end week; tension effect on attrition; backfill before the freeze |
| Demand | Weekly runoff of the existing book; step-downs (e.g. contract expiries); whether new demand is being taken on |
| After the freeze | Attrition after the announcement; absence surge; up to four waves (share of the book, staff move with it); training hours before each wave; optional release of surplus staff after a notice period |
| Borrowed capacity | FTE, weeks, AHT penalty, which channels it can handle |
| Uncertainty | Optional Monte Carlo over freeze length, the attrition effects, the absence surge and runoff |

## What you get

- Service level per channel per week against target, with the freeze and waves marked
- Available against required FTE, and headcount
- A grade per week on the same AAA–D- scale as the WFM Labs Risk-Rated Capacity Planner
- With uncertainty on: 10th–90th percentile bands and the share of futures that never breach
- Scenario A/B overlay, a share link that reproduces the scenario, CSV export

## How it works

One blended team serves **Voice first, then Chat, and Email from whatever is left**, carrying
a backlog. Spare time returns to Voice and Chat. Interactive channels use Erlang C across a
peak, shoulder and off-peak profile, with fractional agents. See [docs/METHOD.md](docs/METHOD.md)
for the full method, the order of operations and the limits.

Background reading on the WFM Labs wiki:
[Service Level During Work Migration](https://wiki.wfmlabs.org/wiki/Service_Level_During_Work_Migration) ·
[Migration Service-Level Simulation pack](https://wiki.wfmlabs.org/wiki/Wiki:Packs/Migration_Service-Level_Simulation)
(a Python version with per-client intake for Claude projects).

## Run it yourself

```bash
bun install
bun run dev      # local development
bun test         # 37 tests: Erlang reference values, invariants, priority, Monte Carlo
bun run build    # production build to dist/
```

Everything runs in the browser; no data leaves the page. Deploys to Netlify from `netlify.toml`.

## Customise

- **Demo scenario:** `src/lib/defaults.ts` (a synthetic 120-FTE team)
- **Grading:** `src/lib/grade.ts`
- **Channel priority or allocation rules:** `src/lib/engine.ts` (the allocation block is commented)
- **Uncertain inputs:** `src/lib/montecarlo.ts`

## Licence

MIT. Demonstration tool: the figures illustrate the inputs you give; they are not forecasts.
