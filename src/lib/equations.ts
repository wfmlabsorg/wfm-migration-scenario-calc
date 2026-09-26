// The method as equations, in one place. Used verbatim by the analyst's system prompt and by the
// scenario dossier, so the two can never describe different maths. Keep it byte-stable (the
// system prompt is prompt-cached); change it only together with the engine.

export const EQUATIONS = `### Notation
Weeks w = 0 … W−1. Channels: voice (V), chat (C), email (E). Intraday buckets b ∈ {peak, shoulder, off-peak} with volume share vs_b and hour share hs_b. Interval I = 1800 s. Paid hours per head p; base shrinkage s; open hours per week O.

### 1. Demand
- Existing book factor x_w: starts at 1; from the runoff start week, x_w = x_{w−1} × (1 − runoff); on a step-down week, x_w ×= (1 − step pct).
- New book (intake on): n_w = intakePct × (1 − x_w); otherwise 0.
- Waves are entered as shares of the book σ_1…σ_k in time order and applied as conditional shares π_j = σ_j ÷ (1 − Σ_{i<j} σ_i) (capped so the total ≤ 1). Wave multiplier m_w = Π over waves cut over by week w of (1 − π_j). Wave j cuts over at freeze end + weeksAfterFreeze_j.
- Volume per channel: vol_c,w = baseVolume_c × (x_w + n_w) × m_w.

### 1b. Book of business (book mode; replaces runoff, step-downs and waves)
- The book is described by shares: contract mix (fixed-term, rolling, rolling with a convenience clause), relationship-health mix (green, amber, red), fate probabilities by health (transfer, exit, re-platform), a fixed-term expiry window, exit-notice ranges after the announcement (rolling; with clause), a re-platform offset range, waves as shares of the transferring work (offsets after the freeze end), and a wave-slip range. Mixes and priors are rescaled to sum to 1.
- Cells c = (contract k, health h) with share s_c = contractMix_k × healthMix_h and fate probabilities p_c = priors_h. Departure week per fate: transfer → wave j (probability = wave share) at freezeEnd + offset_j + slip; exit → fixed-term: uniform over the expiry window (absolute weeks), rolling: freezeEnd + PERT(notice); an exit landing on or after the client's wave transfers at the wave instead (late-exit rule); re-platform → freezeEnd + PERT(offset), capped at the wave (still re-platformed). Continuous draws are rounded to whole weeks; anything after the horizon stays.
- Expected curve (the deterministic line, no random numbers): book remaining f(w) = 1 − Σ_{k≤w} departures_k, with departures the closed-form expectation over cells, waves and the PERT/uniform week distributions (P(PERT ≤ v) from the regularised incomplete beta with the same Beta parameters the sampler uses: a = 1 + 4(m−lo)/(hi−lo), b = 1 + 4(hi−m)/(hi−lo)). vol_c,w = baseVolume_c × (f(w) + intake_w), intake_w = intakePct × (1 − f(w)) if intake is on.
- Staff moves are derived: at week w a share transferLeaving_w ÷ f(w−1) of the team (of the transfer group: transferLeaving_w ÷ transferring work still here) leaves with the work; exits and re-platforming move no staff. Email backlog leaves with the same share as the staff.
- Implied fates = the expected fate shares after the late-exit rule; τ = share of the work still here at the announcement that will transfer within the horizon.
- Monte Carlo: each future draws K client-equivalents (share 1/K each), each with its own cell, fate, wave and departure week, and one wave slip; the drawn staircase replaces f(w). Mix shares drawn from the register are rescaled to sum to 1 first.

### 2. Offered load and agents needed (per bucket)
- Bucket open hours H_b = O × hs_b; intervals per bucket = H_b × 3600 ÷ I.
- Offered load (Erlangs): A_c,b = (vol_c × vs_b ÷ intervals_b) × (AHT_c ÷ I). Chat uses AHT_C ÷ concurrency.
- Erlang B recursion: B(0) = 1; B(k) = A·B(k−1) ÷ (k + A·B(k−1)).
- Erlang C: C(N) = N·B(N) ÷ (N − A·(1 − B(N))) for N > A (else 1).
- Service level: SL(N) = 1 − C(N)·exp(−(N − A)·T ÷ AHT) for N > A, else 0 (T = answer threshold).
- Fractional agents: SL(n) = (1 − f)·SL(⌊n⌋) + f·SL(⌊n⌋+1), f = n − ⌊n⌋.
- Agents needed at target t: need(t) = smallest fractional n with SL(n) = t, found in one upward pass of the recursion and interpolated linearly between integers. need(0) = ⌊A⌋.
- Erlang A (M/M/N+M; waiting customers give up after an exponential patience with mean APT). With h = AHT ÷ APT and τ = T ÷ AHT: q_0 = 1, q_k = q_{k−1} × A ÷ (N + k·h) (k waiting); Z = 1/B(N) − 1 + Σ_k q_k.
  - P(wait) = Σ q_k ÷ Z. Abandon rate P(ab) = Σ q_k × (k+1)h ÷ (N + (k+1)h) ÷ Z.
  - Service level = answered within T ÷ ALL offered (abandoners count as misses): SL_A(N) = [ (1/B − 1) + Σ q_k × N ÷ (N + (k+1)h) × (1 − F_k) ] ÷ Z, where F_k is the negative-binomial CDF with t_0 = e^{−(N+h)τ}, t_j = t_{j−1} × x × (b + j − 1) ÷ j, x = 1 − e^{−hτ}, b = N/h + 1.
  - Fractional agents interpolate as above; need_A(t) is found by bisection and can be below A (callers who give up relieve the queue). need_A(0) = 0. Very patient customers (h → 0) reproduce Erlang C.
- Service model: required FTE is always sized with Erlang C (need(t)). Under Erlang A, allocation targets and delivered service use need_A and SL_A; under Erlang C they use need and SL.
- Email work: arrival hours E_w = vol_E × AHT_E ÷ 3600.

### 3. Supply (in this order each week)
1. Waves: moved = H × π_j; H −= moved; the same share of email backlog leaves.
2. Attrition: rate q = min(1, annual ÷ 52 × m), m = 1 before the freeze, tensionMult during it, postMult after it; lost = H × q (Monte Carlo: Binomial(round H, q)).
3. Backfill (before the freeze only, if on): hired = max(0, H₀ − H).
4. Releases (if on, from freeze end + notice): released = max(0, H − (1 + buffer) × needHours ÷ prodPerHead), where needHours = the largest of the forecast required hours over the next lookahead weeks (no backlog) and this week's actual requirement including retries and the email backlog carried in, max(peak-bucket need, total need + E_w + max(0, backlog in − targetDays × E_w/5) ÷ 4), and prodPerHead = p × (1 − min(0.95, s + surge)) − training hours per head this week (so releases never leave the team short this week).
5. Productive hours: P = max(0, H × p × (1 − min(0.95, s + surge)) − training), where surge = surgePts for surgeWeeks after the freeze ends, and training = Σ over waves due within trainingWeeks of H × π_j × trainingHours ÷ trainingWeeks.
- Headcount identity: H₀ + Σhired = Σattrition + Σmoved + Σreleased + H_end.

### 3b. The team split at the announcement (people.split)
- At the start of the announcement week (freeze end) the team splits: T = H × τ (transfer group), R = H − T (release group), τ = the share of the current book that the remaining waves will move (manual: 1 − Π(1 − π_j) over waves not yet cut over; book mode: the book's τ).
- Attrition after the split: lost_T = T × q_T, q_T = min(1, annual ÷ 52 × postMultTransfer × (1 − ρ_T)); lost_R = R × q_R with postMultRelease and ρ_R; ρ = retentionEffect on the group(s) the offer targets, else 0 (Monte Carlo: two binomials).
- Waves move staff from T only: moved_j = T × π_j ÷ τ_j, τ_j = 1 − Π_{k≥j}(1 − π_k) (book mode: transferLeaving_w ÷ transferring work still here); training falls on T only (T × π_j/τ_j × trainingHours ÷ trainingWeeks per week in the window). Releases come from R only: released = max(0, min(R, (T × prodPerHead_T + R × prodPerHead_R − (1 + buffer) × needHours) ÷ prodPerHead_R)).
- With equal multipliers, no retention offer and waves summing to 1 the split reproduces the single stock exactly; with waves summing to less than 1 the release group carries the non-transferring work and its attrition. Identity: H₀ + Σhired = Σattrition + Σmoved + Σreleased + H_end still holds, with attrition after the announcement reported by group.
- Borrowed staff (weeks start…end): B = FTE × p × (1 − s) ÷ AHT penalty productive hours, used only on eligible channels.

### 4. Allocating capacity between channels
Capacity per bucket in agents: team a_b = P × α_b ÷ H_b and borrowed β_b = B × α_b ÷ H_b, with α_b = fit × vs_b + (1 − fit) × hs_b. Interactive channels take agents bucket by bucket (borrowed first if eligible); email is deferrable and takes borrowed time first (if eligible), then the team's own, the same share of every bucket within each pool. Email's due D = backlog in + E_w; email's need Ê = E_w + max(0, backlog in − targetDays × E_w/5) ÷ 4.
- Strict priority (order): each channel in turn takes its need (voice/chat need(target) per bucket; email Ê, or its full due D when it is last). The last channel absorbs any shortfall.
- Protect email (floor f): email first takes min(D, f × E_w); voice and chat then take their need in order.
- Share the shortfall: the largest r ≤ 1 such that r × every channel's need fits (per bucket for voice/chat, across buckets for email); each channel gets r × need.
- Equal attainment: the largest a ≤ 1 such that voice gets need(a × target_V) and chat need(a × target_C) per bucket, and email works enough that on-time ≥ a (backlog out ≤ targetDays × daily arrivals ÷ a). If no a fits (a queue cannot be stabilised), it falls back to sharing the shortfall.
- Every policy then tops email up to its full due D from what is left, and returns any remaining time to voice and chat in proportion to need (borrowed time only to eligible channels; the rest is idle).
- Capacity identity: P + B = voice + chat hours given + email worked + borrowed idle + team idle.

### 5. Service measures
- Voice/chat service level = Σ_b vs_b × SL(agents given_b), with SL from the service model. Channels whose volume is below 10% of baseline are not scored.
- Abandonment (Erlang A only; 0 under C): rate = Σ_b vs_b × P(ab)(agents given_b); abandoned = volume × rate.
- Retries (Erlang A): forecast volumes already contain today's redials, so only abandonment above the week-0 rate r_0 creates extra contacts: retries_{w+1} = redialRate × max(0, abandoned_w − r_0 × vol_w) × min(1, forecast vol_{w+1} ÷ forecast vol_w). They are added to next week's volume and all of that week's loads, needs and required FTE are recomputed.
- Email: backlog out = D − worked; backlog days = backlog out ÷ (E_w ÷ 5); on-time index = min(1, targetDays ÷ backlog days).
- Required FTE = max(peak-bucket need, total need) ÷ (p × (1 − s)), where peak-bucket need = max_b (need_V,b + need_C,b) × H_b ÷ α_b and total need = Σ_b (need_V,b + need_C,b) × H_b + E_w + excess backlog ÷ 4.
- Available FTE = (P + borrowed hours used) ÷ (p × (1 − s)). Utilisation = (interactive need hours + E_w) ÷ (P + borrowed used).

### 6. Grade (AAA to D-)
Attainment: voice/chat = SL ÷ target; email = on-time index. If every scored channel meets target: score = 0.70 + 0.30 × clamp((cover − 1) ÷ 0.10, 0, 1), cover = available ÷ required FTE (meeting every target is at least an A, even when cover < 1: required FTE is a conservative sizing). Otherwise score = 0.70 × clamp((worst attainment − 0.5) ÷ 0.5, 0, 1). An unstable Erlang C queue (agents ≤ load) scores 0.05; under Erlang A queues are always stable. Abandonment cap (Erlang A): if the worst scored voice/chat abandon rate exceeds abandonCap, score = min(score, 0.69) (BBB at best); above 2 × abandonCap, min(score, 0.39) (CCC at best). Bands: AAA ≥ 0.90, AA ≥ 0.80, A ≥ 0.70, BBB ≥ 0.60, BB ≥ 0.50, B ≥ 0.40, CCC ≥ 0.30, CC ≥ 0.20, D ≥ 0.10, D- below. Weeks with no work left are not graded.

### 7. Uncertainty and the assumption register (optional)
- Assumption register: each uncertain input carries a range (low, likely, high) and a status. Not asked (default) = a generic range around the current value; estimated = a range someone gave; confirmed = a point, or a narrow range if given. The deterministic run always uses the likely values.
- Each simulated future draws every register entry whose range has width from PERT(low, likely, high), writes it into a copy of the scenario and runs the engine with attrition drawn binomially. Freeze length is drawn as weeks after the (possibly drawn) freeze start.
- Every input has its own seeded random stream (seed ⊕ hash(input) ⊕ draw), and attrition has its own, so answering one question does not reshuffle the others and two scenarios see the same futures. Inputs that belong to one question (the three channel volumes, the three handle times, patience) share a stream, so they move together within a future: forecast error is a common shock, not three independent ones.
- In the simulation only, each bucket's offered load is rounded to 3 significant figures before the Erlang curve is computed (so curves are reused); the deterministic run rounds loads to 4 decimal places.
- Reported: 10th/50th/90th percentiles per week; the share of futures with no breach, i.e. in which every graded week meets every target and is not capped by abandonment (graded on the same scale); the average band width = mean over scored weeks and channels of (90th − 10th percentile), the headline measure of how uncertain the forecast still is; and the trough range = percentiles of each future's lowest weekly service on any channel.
- Inputs outside the scenario's mode are neither drawn nor counted: people.* only when the split is on (attrition.postMult only when it is off); book.* only in book mode; runoff, step-downs and manual waves only in manual mode.
- Binomial attrition is genuine process noise, so bands never shrink to zero even when every assumption is confirmed. Manual waves and step-downs, the balancing policy and the service model's structure are not varied; in book mode the departure staircase itself is drawn (§1b).`
