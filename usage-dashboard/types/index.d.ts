export type Tab = 'overview' | 'context' | 'turns' | 'tools' | 'history' | 'models' | 'sessions' | 'optimize'

export type Tokens = { in: number; out: number; cr: number; cw: number }

export type TurnRec = Tokens & {
  id: string
  at: number
  ms: number
  model: string
  agent: string
  tools: number
  reason: string
  ctxPct?: number
}

export type ToolStat = { n: number; err: number; ms: number; denied: number }

export type Square = { color: string; filled: boolean; full: number; name: string }

export type Category = { name: string; tokens: number; color: string; kind: string }

export type Breakdown = {
  detail: 'summary' | 'full'
  model: string
  total: number
  max: number
  pct: number
  source: string
  autoCompactAt?: number
  categories: Category[]
  grid: Square[][]
  memory: { path: string; type: string; tokens: number }[]
  mcp: { server: string; tokens: number; tools: number; loaded: number }[]
  skills: { name: string; tokens: number }[]
  skillTotal?: { n: number; included: number; tokens: number }
  agents: { name: string; tokens: number }[]
}

export type Snapshot = {
  at: number
  startedAt: number
  ctxTokens?: number
  ctxWindow: number
  ctxPct?: number
  rate: { kind: string; pct: number; resetsAt?: string }[]
  usd?: number
  bd?: Breakdown
}

export type HistDayModel = { tok: number; out: number; n: number }

export type HistDay = Tokens & { date: string; n: number; sessions: number; models?: Record<string, HistDayModel> }
export type HistGroup = Tokens & { name: string; n: number }

export type History = {
  scannedAt: number
  rangeDays: number
  files: number
  days: HistDay[]
  models: HistGroup[]
  projects: HistGroup[]
  heat: number[][]
  main: number
  sub: number
}

export type SessionSummary = {
  id: string
  cwd: string
  startedAt: number
  lastAt: number
  usd: number
  turns: number
  sub: number
  tok: Tokens
  models: Record<string, Tokens & { turns: number }>
  tools: number
  peakCtx: number
  peakTok: number
  reqs: number
  src: 'live' | 'backfill'
}

export type Saved = {
  sessions: SessionSummary[]
  costDays: Record<string, number>
  toolsAll: Record<string, ToolStat>
  eventsDir: string
}

export type SkillStat = {
  name: string
  path?: string
  source: string
  plugin?: string
  n: number
  promptTok: number
  turnTok: number
  out: number
  ms: number
  errors: number
  aborted: number
  lastAt: number
  errSamples: string[]
}

export type FindingAction =
  | { kind: 'compact' }
  | { kind: 'skill-off'; skill: string }
  | { kind: 'improve'; skill: string }
  | { kind: 'tab'; tab: Tab }

export type Finding = {
  id: string
  sev: 'high' | 'med' | 'low'
  area: string
  title: string
  detail: string
  saves?: number
  action?: FindingAction
}

export type Proposal = {
  skill: string
  path: string
  summary: string
  changes: string[]
  original: string
  content: string
  model: string
  at: number
  outTok: number
}

export type Review = { text: string; at: number; model: string }

export type HistMetric = 'total' | 'output' | 'requests'

declare module 'claude-code' {
  interface PluginState {
    'usage-dashboard': {
      tab: Tab
      turns: Shaped<TurnRec[]>
      tools: Shaped<Record<string, ToolStat>>
      snap: Shaped<Snapshot | null>
      history: Shaped<History | null>
      range: number
      metric: HistMetric
      scanState: string
      statusOn: boolean
      toolSort: string
      turnScope: string
      turnModel: string
      busy: string
      saved: Shaped<Saved>
      skillsAll: Shaped<Record<string, SkillStat>>
      skillsSince: number
      proposal: Shaped<Proposal | null>
      review: Shaped<Review | null>
      dismissed: string[]
      optBusy: string
      skillPick: string
    }
  }
}
