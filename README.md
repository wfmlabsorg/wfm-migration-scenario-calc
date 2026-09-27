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
| Service model | Erlang A (default: patience per channel, redial share, abandonment cap on the grade) or Erlang C (no abandonment); optional Erlang C overlay |
| Channel balancing | Strict priority (reorderable), protect email, share the shortfall, equal attainment |
| Borrowed capacity | FTE, weeks, AHT penalty, which channels it can handle |
| Book of business | Optional: describe the book by contract mix, health mix, fate probabilities, notice ranges, waves as shares of transferring work and wave slip; the expected departure curve replaces manual step-downs, and the Monte Carlo draws real staircases |
| People split | Optional: at the announcement the team divides into a transfer group and a release group with their own post-announcement attrition and a retention-offer lever |
| Assumptions | A register of ~30 generic questions (plus project questions): each answer is a range with a status (not asked / estimated / confirmed); the Monte Carlo draws every range, so answers narrow the bands |
| Shape cards | Import or export a scenario without its scale (cover and workload mix instead of volumes and headcount), e.g. from the Claude Desktop pack |

## What you get

- Service level per channel per week against target, with the freeze and waves marked, and abandonment under Erlang A
- Available against required FTE, and headcount
- A grade per week on the same AAA–D- scale as the WFM Labs Risk-Rated Capacity Planner
- With uncertainty on: 10th–90th percentile bands, the share of futures that never breach, and the average band width with its previous value (how much the last answers narrowed the forecast)
- Scenario A/B overlay, a share link that reproduces the scenario, CSV export

## Ask the analyst

The **Ask the analyst** panel is an AI analyst (Claude Sonnet 5) that answers "why" and "what if" questions by **running the engine**, not by guessing:
- It reads the scenario on screen.
- It runs variations without touching the screen.
- It sweeps a lever to find how much is needed.
- It runs Monte Carlo on request.
- It explains any week with the engine's own arithmetic: headcount, productive hours, per-bucket Erlang loads, the email backlog and the grade.

Every tool call appears as an expandable step, so the maths is visible. A conversation can be exported as Markdown together with its scenario link and the exact engine commit.

**How it runs:**
- The tools execute in your browser against the same engine as the page.
- A small server function (`netlify/functions/agent.mts`) relays one model turn at a time. It holds the API key and fixes the model, instructions and tools.
- It enforces per-visitor rate limits and a global daily spend cap. When the cap is reached, the analyst pauses and the calculator keeps working.

**Self-hosting:** set `ANTHROPIC_API_KEY` as a secret, functions-scoped environment variable on your Netlify site. Keys never belong in the repo, and anything not prefixed `VITE_` is never bundled into the page. `tests/export.test.ts` fails the build if key material appears in the source or build output.

## Channel balancing

Choose who absorbs a shortfall:
- strict priority (reorderable)
- protect email with a guaranteed floor
- share the shortfall pro rata
- equal attainment

See `docs/METHOD.md` for why spreading a shortfall across Erlang queues usually hurts every channel.

## Scenario dossier

**Export scenario** downloads one Markdown file with everything needed to understand, check or rebuild the scenario:
- provenance (engine version, commit and a scenario link)
- instructions for Claude
- headline results
- every assumption with its meaning
- the approach and the complete equations
- a worked example of the worst week, with the engine's own numbers substituted
- the weekly results
- any analyst conversation
- the inputs as JSON

Paste it into Claude Desktop to analyse or recreate the scenario.

## Versioned links

Share links and exports record the engine commit (`&v=<sha>`). The footer links to the exact code on GitHub, and a link made with a different commit shows a notice with a link to that version's source.

## How it works

One blended team serves Voice, Chat and Email under a balancing policy (strict priority by
default), with Email carrying a backlog. Spare time returns to Voice and Chat. Interactive
channels are modelled across a peak, shoulder and off-peak profile with fractional agents:
delivered service uses **Erlang A** (customers abandon; a share redial) or **Erlang C** (nobody
abandons), and required FTE is always sized with Erlang C. See [docs/METHOD.md](docs/METHOD.md)
for the full method, the order of operations and the limits.

Background reading on the WFM Labs wiki:
[Service Level During Work Migration](https://wiki.wfmlabs.org/wiki/Service_Level_During_Work_Migration) ·
[Migration Service-Level Simulation pack](https://wiki.wfmlabs.org/wiki/Wiki:Packs/Migration_Service-Level_Simulation)
(a Python version with per-client intake for Claude projects).

## Run it yourself

```bash
bun install
bun run dev      # local development
bun test         # 250+ tests: Erlang C/A reference values (Erlang A against an event
                 # simulation), invariants, balancing policies, Monte Carlo,
                 # analyst tools, relay rules, quotas, export, no-secrets guard
bun run build    # production build to dist/
```

Everything runs in the browser; no data leaves the page. Deploys to Netlify from `netlify.toml`.

## Customise

- **Demo scenario:** `src/lib/defaults.ts` (a synthetic 100-FTE travel-counsellor team: phone and email, 10-minute handle times, starting about 6% short, in a country-exit migration). The pre-v1.4.1 demo is kept in `tests/fixtures/legacy-demo-inputs.json` for the regression tests.
- **Analyst:** tools in `src/agent/toolDefs.ts` + `src/agent/tools.ts`; instructions in `src/agent/systemPrompt.ts`; limits and pricing in `src/agent/relay.ts`
- **Grading:** `src/lib/grade.ts`
- **Channel priority or allocation rules:** `src/lib/engine.ts` (the allocation block is commented)
- **Uncertain inputs:** `src/lib/montecarlo.ts`

## Licence

MIT. Demonstration tool: the figures illustrate the inputs you give; they are not forecasts.
