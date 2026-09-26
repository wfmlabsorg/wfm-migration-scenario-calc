// Credit-style grade scale shared with the WFM Labs Risk-Rated Capacity Planner: same bands,
// same colours, so the calculators read the same way. Descriptions are written for a weekly
// service view.
//
// Deterministic score (most-likely inputs):
//   every channel meets target  -> 0.70 + 0.30 × min(1, (cover − 1) / 0.10); AA from ~3% headroom, AAA from ~7%
//   some channel misses         -> 0.70 × (worst attainment − 0.5) / 0.5
//   a queue cannot keep up      -> 0.05 (D-)
// Monte Carlo score: the share of simulated futures in which every channel meets target.

export interface GradeInfo {
  grade: string
  rating: string
  deterministic: string
  probabilistic: string
  color: string
}

const GRADE_TABLE: GradeInfo[] = [
  { grade: 'AAA', rating: 'Optimal', deterministic: 'All targets met with about 7%+ capacity headroom', probabilistic: 'Targets met in 90–100% of futures', color: '#047857' },
  { grade: 'AA', rating: 'Excellent', deterministic: 'All targets met with about 3–7% headroom', probabilistic: 'Targets met in 80–89% of futures', color: '#059669' },
  { grade: 'A', rating: 'Strong', deterministic: 'All targets met with under 3% headroom', probabilistic: 'Targets met in 70–79% of futures', color: '#10b981' },
  { grade: 'BBB', rating: 'Good', deterministic: 'Worst channel within about 7% of target', probabilistic: 'Targets met in 60–69% of futures', color: '#22c55e' },
  { grade: 'BB', rating: 'Satisfactory', deterministic: 'Worst channel within about 14% of target', probabilistic: 'Targets met in 50–59% of futures', color: '#22d3ee' },
  { grade: 'B', rating: 'Inadequate', deterministic: 'Worst channel within about 21% of target', probabilistic: 'Targets met in 40–49% of futures', color: '#0891b2' },
  { grade: 'CCC', rating: 'Poor', deterministic: 'Worst channel within about 29% of target', probabilistic: 'Targets met in 30–39% of futures', color: '#3b82f6' },
  { grade: 'CC', rating: 'Compromised', deterministic: 'Worst channel within about 36% of target', probabilistic: 'Targets met in 20–29% of futures', color: '#ef4444' },
  { grade: 'D', rating: 'Distressed', deterministic: 'Worst channel within about 43% of target', probabilistic: 'Targets met in 10–19% of futures', color: '#991b1b' },
  { grade: 'D-', rating: 'Critical', deterministic: 'Worst channel below about 57% of target, or a queue cannot keep up', probabilistic: 'Targets met in under 10% of futures', color: '#7f1d1d' },
]

export function getGradeTable(): GradeInfo[] {
  return GRADE_TABLE
}

export function scoreToGrade(score: number): GradeInfo {
  const pct = score * 100
  const bands = [90, 80, 70, 60, 50, 40, 30, 20, 10]
  const i = bands.findIndex((b) => pct >= b)
  return GRADE_TABLE[i === -1 ? 9 : i]
}
