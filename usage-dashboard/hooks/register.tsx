import { atom, read, update } from 'claude-code'
import type { Color, Elements, EngineInterface, Register, SessionUsage } from 'claude-code'

import type {
  Breakdown,
  HistDay,
  HistDayModel,
  HistGroup,
  HistMetric,
  History,
  Finding,
  Proposal,
  Review,
  Saved,
  SkillStat,
  SessionSummary,
  Snapshot,
  Tab,
  ToolStat,
  TurnRec,
} from '../types'

const PLUGIN = 'usage-dashboard'
const PANE = 'usage-dashboard'
const TITLE = 'Usage'

// Change a shape tag when that value's fields change: an earlier version's
// stored value is then read as absent instead of as the wrong shape.
const tabA = atom({ plugin: 'usage-dashboard', key: 'tab' } as const, 'overview' as Tab)
const turnsA = atom({ plugin: 'usage-dashboard', key: 'turns' } as const, [] as TurnRec[], { shape: 'turns-1' })
const toolsA = atom({ plugin: 'usage-dashboard', key: 'tools' } as const, {} as Record<string, ToolStat>, { shape: 'tools-1' })
const snapA = atom({ plugin: 'usage-dashboard', key: 'snap' } as const, null as Snapshot | null, { shape: 'snap-1' })
const histA = atom({ plugin: 'usage-dashboard', key: 'history' } as const, null as History | null, { shape: 'hist-1' })
const rangeA = atom({ plugin: 'usage-dashboard', key: 'range' } as const, 14)
const metricA = atom({ plugin: 'usage-dashboard', key: 'metric' } as const, 'total' as HistMetric)
const scanA = atom({ plugin: 'usage-dashboard', key: 'scanState' } as const, '')
const statusA = atom({ plugin: 'usage-dashboard', key: 'statusOn' } as const, false)
const toolSortA = atom({ plugin: 'usage-dashboard', key: 'toolSort' } as const, 'count')
const scopeA = atom({ plugin: 'usage-dashboard', key: 'turnScope' } as const, 'all')
const turnModelA = atom({ plugin: 'usage-dashboard', key: 'turnModel' } as const, '')
const busyA = atom({ plugin: 'usage-dashboard', key: 'busy' } as const, '')
const skillsA = atom({ plugin: 'usage-dashboard', key: 'skillsAll' } as const, {} as Record<string, SkillStat>, { shape: 'skills-1' })
const skillsSinceA = atom({ plugin: 'usage-dashboard', key: 'skillsSince' } as const, 0)
const proposalA = atom({ plugin: 'usage-dashboard', key: 'proposal' } as const, null as Proposal | null, { shape: 'proposal-1' })
const reviewA = atom({ plugin: 'usage-dashboard', key: 'review' } as const, null as Review | null, { shape: 'review-1' })
const dismissedA = atom({ plugin: 'usage-dashboard', key: 'dismissed' } as const, [] as string[])
const optBusyA = atom({ plugin: 'usage-dashboard', key: 'optBusy' } as const, '')
const skillPickA = atom({ plugin: 'usage-dashboard', key: 'skillPick' } as const, '')
const savedA = atom({ plugin: 'usage-dashboard', key: 'saved' } as const, { sessions: [], costDays: {}, toolsAll: {}, eventsDir: '' } as Saved, { shape: 'saved-2' })

type $T = EngineInterface
type UI = Pick<Elements['terminal'], 'Box' | 'Text' | 'Button' | 'Select' | 'Markdown' | 'Code'>

// ---------------------------------------------------------------- colours

const C = {
  in: 'suggestion',
  cr: 'success',
  cw: 'warning',
  out: 'claude',
  accent: 'claude',
  ok: 'success',
  warn: 'warning',
  bad: 'error',
  dim: 'inactive',
} as const satisfies Record<string, Color>

const SERIES: Color[] = ['claude', 'suggestion', 'success', 'warning', 'permission', 'planMode', 'ide', 'merged', 'autoAccept', 'remember']

// One colour per model on every tab: by family, else a stable pick from the series.
const modelColor = (m: string): Color => {
  const s = m.toLowerCase()
  if (s.includes('opus')) return 'claude'
  if (s.includes('sonnet')) return 'suggestion'
  if (s.includes('haiku')) return 'success'
  if (s.includes('fable')) return 'planMode'
  let h = 0
  for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return SERIES[4 + (h % (SERIES.length - 4))]!
}

const levelColor = (pct: number): Color => (pct >= 85 ? C.bad : pct >= 60 ? C.warn : C.ok)

// ---------------------------------------------------------------- formatting

const fmtTok = (n: number | undefined): string => {
  if (n === undefined || !Number.isFinite(n)) return '—'
  const a = Math.abs(n)
  if (a >= 1e9) return `${(n / 1e9).toFixed(a >= 1e10 ? 1 : 2)}B`
  if (a >= 1e6) return `${(n / 1e6).toFixed(a >= 1e7 ? 1 : 2)}M`
  if (a >= 1e3) return `${(n / 1e3).toFixed(a >= 1e4 ? 0 : 1)}k`
  return String(Math.round(n))
}

const fmtUsd = (n: number | undefined) => (n === undefined ? '—' : n >= 100 ? `$${n.toFixed(0)}` : `$${n.toFixed(2)}`)

const fmtDur = (ms: number): string => {
  if (!Number.isFinite(ms) || ms < 0) return '—'
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}s`
  const h = Math.floor(m / 60)
  if (h < 48) return `${h}h${String(m % 60).padStart(2, '0')}m`
  return `${Math.floor(h / 24)}d${h % 24}h`
}

const pad = (s: string, n: number) => (s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length))
const lpad = (s: string, n: number) => (s.length >= n ? s.slice(0, n) : ' '.repeat(n - s.length) + s)
const shortModel = (m: string) => m.replace(/^claude-/, '').replace(/-\d{8}$/, '')
const sumTok = (t: { in: number; out: number; cr: number; cw: number }) => t.in + t.out + t.cr + t.cw

// ---------------------------------------------------------------- glyphs

const EIGHTHS_H = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉']
const EIGHTHS_V = [' ', '▁', '▂', '▃', '▄', '▅', '▆', '▇', '█']
const SPARK = '▁▂▃▄▅▆▇█'
const SHADES = ['·', '░', '▒', '▓', '█']

const hbar = (frac: number, width: number): string => {
  const f = Math.max(0, Math.min(1, frac)) * width
  const full = Math.floor(f)
  const rest = Math.round((f - full) * 8)
  return ('█'.repeat(full) + (rest > 0 && full < width ? EIGHTHS_H[rest] ?? '' : '')).padEnd(width, ' ')
}

const spark = (values: number[], max?: number): string => {
  if (values.length === 0) return ''
  const top = max ?? Math.max(...values, 1)
  return values.map(v => SPARK[Math.max(0, Math.min(7, Math.round((v / (top || 1)) * 7)))] ?? ' ').join('')
}

// A row of coloured cells, drawn as runs of one colour each.
type Cell = { ch: string; color?: Color; dim?: boolean; bold?: boolean }

const runs = (row: Cell[]) => {
  const out: Cell[] = []
  for (const c of row) {
    const last = out[out.length - 1]
    if (last && last.color === c.color && last.dim === c.dim && last.bold === c.bold) last.ch += c.ch
    else out.push({ ...c })
  }
  return out
}

const Line = (ui: UI, row: Cell[]) => {
  const { Box, Text } = ui
  return (
    <Box flexDirection="row">
      {runs(row).map(r => (
        <Text color={r.color} dimColor={r.dim} bold={r.bold} wrap="truncate">
          {r.ch}
        </Text>
      ))}
    </Box>
  )
}

const cells = (s: string, color?: Color, dim?: boolean, bold?: boolean): Cell[] =>
  [...s].map(ch => ({ ch, color, dim, bold }))

// A stacked horizontal bar from segments, scaled to `width` cells.
const stackBar = (segs: { v: number; color: Color }[], width: number, total?: number): Cell[] => {
  const sum = total ?? segs.reduce((a, s) => a + s.v, 0)
  const out: Cell[] = []
  if (sum <= 0) return cells('░'.repeat(width), C.dim, true)
  let acc = 0
  let drawn = 0
  for (const s of segs) {
    acc += s.v
    const upto = Math.round((acc / sum) * width)
    for (; drawn < upto && drawn < width; drawn++) out.push({ ch: '█', color: s.color })
  }
  for (; drawn < width; drawn++) out.push({ ch: '░', color: C.dim, dim: true })
  return out
}

// Vertical stacked columns, `height` rows tall, with a left axis.
const columns = (
  ui: UI,
  data: { segs: { v: number; color: Color }[] }[],
  height: number,
  colW: number,
  gap: number,
  axisW: number,
  fmtAxis: (n: number) => string,
) => {
  const totals = data.map(d => d.segs.reduce((a, s) => a + s.v, 0))
  const max = Math.max(...totals, 1)
  const rows: Cell[][] = []
  for (let r = height - 1; r >= 0; r--) {
    const label = r === height - 1 ? fmtAxis(max) : r === 0 ? '0' : r === Math.floor((height - 1) / 2) ? fmtAxis(max / 2) : ''
    const row: Cell[] = cells(lpad(label, axisW) + '┤', C.dim, true)
    data.forEach((d, i) => {
      const total8 = Math.round((totals[i]! / max) * height * 8)
      const f = Math.max(0, Math.min(8, total8 - r * 8))
      let color: Color = C.dim
      if (f > 0) {
        const mid = ((r * 8 + f / 2) / (height * 8)) * max
        let acc = 0
        for (const s of d.segs) {
          acc += s.v
          color = s.color
          if (acc >= mid) break
        }
      }
      const ch = f === 0 ? (r === 0 ? '▁' : ' ') : EIGHTHS_V[f]!
      for (let k = 0; k < colW; k++) row.push({ ch, color, dim: f === 0 })
      for (let k = 0; k < gap && i < data.length - 1; k++) row.push({ ch: ' ' })
    })
    rows.push(row)
  }
  return rows.map(r => Line(ui, r))
}

const Legend = (ui: UI, items: { label: string; color: Color }[]) =>
  Line(
    ui,
    items.flatMap(it => [...cells('■ ', it.color), ...cells(it.label + '   ', undefined, true)]),
  )

// ---------------------------------------------------------------- data

const toBreakdown = (u: SessionUsage, detail: 'summary' | 'full'): Breakdown | undefined => {
  const b = u.context.breakdown
  if (!b) return undefined
  const servers = new Map<string, { server: string; tokens: number; tools: number; loaded: number }>()
  for (const t of b.mcpTools) {
    const s = servers.get(t.serverName) ?? { server: t.serverName, tokens: 0, tools: 0, loaded: 0 }
    s.tokens += t.tokens
    s.tools += 1
    s.loaded += t.isLoaded ? 1 : 0
    servers.set(t.serverName, s)
  }
  return {
    detail,
    model: b.model,
    total: b.totalTokens,
    max: b.rawMaxTokens,
    pct: b.percentage,
    source: b.autocompactSource,
    autoCompactAt: b.autoCompactThreshold,
    categories: b.categories.map(c => ({ name: c.name, tokens: c.tokens, color: c.color, kind: c.kind })),
    grid: b.gridRows.map(row =>
      row.map(sq => ({ color: sq.color, filled: sq.isFilled, full: sq.squareFullness, name: sq.categoryName })),
    ),
    memory: b.memoryFiles.map(m => ({ path: m.path, type: m.type, tokens: m.tokens })),
    mcp: [...servers.values()].sort((a, z) => z.tokens - a.tokens),
    skills: (b.skills?.skillFrontmatter ?? []).map(s => ({ name: s.name, tokens: s.tokens })).sort((a, z) => z.tokens - a.tokens),
    skillTotal: b.skills ? { n: b.skills.totalSkills, included: b.skills.includedSkills, tokens: b.skills.tokens } : undefined,
    agents: b.agents.map(a => ({ name: a.agentType, tokens: a.tokens })).sort((a, z) => z.tokens - a.tokens),
  }
}

const refresh = async ($: $T, breakdown?: 'summary' | 'full', columns?: number) => {
  const u = await $.session.usage(breakdown ? { breakdown, columns } : undefined)
  const prev = await read($, snapA)
  const snap: Snapshot = {
    at: await $.clock.now(),
    startedAt: u.startedAt,
    ctxTokens: u.context.tokens,
    ctxWindow: u.context.window,
    ctxPct: u.context.percent,
    rate: u.rateLimits.map(r => ({ kind: r.kind, pct: r.percentUsed, resetsAt: r.resetsAt })),
    usd: u.cost?.usd,
    bd: breakdown ? toBreakdown(u, breakdown) ?? prev?.bd : prev?.bd,
  }
  await update($, snapA, () => snap)
  if (await read($, statusA)) $.ui.status(statusText(snap))
  return snap
}

// The session's working directory, as session.start gave it.
let sessionCwd = ''

const statusText = (s: Snapshot) => {
  const parts = [`ctx ${s.ctxPct ?? '—'}%`, fmtUsd(s.usd)]
  for (const r of s.rate) parts.push(`${rateLabel(r.kind)} ${r.pct}%`)
  return parts.join(' · ')
}

const rateLabel = (k: string) => (k === 'five_hour' ? '5h' : k === 'seven_day' ? '7d' : k === 'spend_limit' ? 'spend' : k.replace(/_/g, ' '))

// ---------------------------------------------------------------- central event store
//
// Every session appends its own events to <events dir>/<session id>.jsonl
// (scripts/events.py emit). Sessions without the mod are rebuilt from their
// transcripts (backfill). The all-time tabs read one aggregate of the folder.
// $.store keeps only this mod's own settings and the resume detail:
//   prefs, dismissed, review, proposal, sess:<id> { turns, tools }, sess-keys

const MAX_DETAIL = 6

let queue: Promise<unknown> = Promise.resolve()
const serial = <T,>(fn: () => Promise<T>): Promise<T> => {
  const run = queue.then(fn, fn)
  queue = run.catch(() => {})
  return run
}

const dayKey = (ms: number) => {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

const eventsDir = ($: $T) => `${homeDir($)}/.claude/usage-events`
const eventsPy = ($: $T) => `${$.plugin.root}/scripts/events.py`

// Appends one event to this session's file. Serial, so a session's lines stay in order.
const emit = ($: $T, ev: Record<string, unknown>) =>
  serial(async () => {
    const sid = await $.session.id()
    const line = JSON.stringify({ v: 1, sid, at: await $.clock.now(), ...ev })
    const r = await $.process.run(['python3', '-I', eventsPy($), 'emit', eventsDir($)], { stdin: line, timeoutMs: 15_000 })
    if (r.exitCode !== 0) $.ui.log(`usage-dashboard: could not write event: ${r.stderr.trim().slice(0, 160)}`, { to: 'debug' })
  })

type Aggregate = {
  eventsDir: string
  history: Omit<History, 'scannedAt'>
  sessions: SessionSummary[]
  costDays: Record<string, number>
  toolsAll: Record<string, ToolStat>
  skillsAll: Record<string, SkillStat>
  since: number
}

// Rebuilds files for sessions without the mod (when asked), then reads the folder.
const sync = async ($: $T, opts: { backfill?: boolean } = {}) => {
  if ((await read($, scanA)) === 'scanning') return
  await update($, scanA, () => 'scanning')
  try {
    const days = await read($, rangeA)
    if (opts.backfill) {
      const b = await $.process.run(['python3', '-I', eventsPy($), 'backfill', eventsDir($), String(Math.max(days, 30))], { timeoutMs: 300_000 })
      if (b.exitCode !== 0) throw new Error(b.stderr.trim().split('\n').pop() ?? `exit ${b.exitCode}`)
    }
    const r = await $.process.run(['python3', '-I', eventsPy($), 'aggregate', eventsDir($), String(days)], { timeoutMs: 120_000 })
    if (r.exitCode !== 0) throw new Error(r.stderr.trim().split('\n').pop() ?? `exit ${r.exitCode}`)
    const agg = JSON.parse(r.stdout) as Aggregate
    const now = await $.clock.now()
    await update($, histA, () => ({ ...agg.history, scannedAt: now }))
    await update($, savedA, () => ({ sessions: agg.sessions, costDays: agg.costDays, toolsAll: agg.toolsAll, eventsDir: agg.eventsDir }))
    await update($, skillsA, () => agg.skillsAll)
    await update($, skillsSinceA, () => agg.since)
    await update($, scanA, () => '')
  } catch (err) {
    await update($, scanA, () => `sync failed: ${String(err).slice(0, 120)}`)
  }
}

// Keeps the turns and tool stats of the latest sessions, so a resume picks up where it was.
const saveDetail = ($: $T) =>
  serial(async () => {
    const id = await $.session.id()
    await $.store.set(`sess:${id}`, { turns: await read($, turnsA), tools: await read($, toolsA) })
    const keys = (((await $.store.get('sess-keys')) as string[] | undefined) ?? []).filter(k => k !== id)
    keys.push(id)
    for (const old of keys.splice(0, Math.max(0, keys.length - MAX_DETAIL))) await $.store.delete(`sess:${old}`)
    await $.store.set('sess-keys', keys)
  })

const restoreSession = async ($: $T) => {
  const id = await $.session.id()
  const detail = (await $.store.get(`sess:${id}`)) as { turns?: TurnRec[]; tools?: Record<string, ToolStat> } | undefined
  if (!detail) return
  if ((await read($, turnsA)).length === 0 && Array.isArray(detail.turns)) await update($, turnsA, () => detail.turns!)
  if (Object.keys(await read($, toolsA)).length === 0 && detail.tools) await update($, toolsA, () => detail.tools!)
}

// ---------------------------------------------------------------- hooks

export const register: Register = on => {
  // Per-loop tool counters for the turn in flight, keyed by agent id.
  const inFlight = new Map<string, number>()
  // Tool stats not yet added to the lifetime totals: flushed at each turn's end.
  let toolDelta: Record<string, ToolStat> = {}
  let ticker: { cancel: () => void } | undefined

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'usage-dash', description: 'Open the usage and context dashboard pane' })

    sessionCwd = e.cwd
    await restoreSession($).catch(() => {})
    await loadSkills($).catch(() => {})
    // Backfill first, so this session's turns from before the mod loaded are in its
    // file; then mark the live start, then read the folder.
    void (async () => {
      await sync($, { backfill: true })
      await emit($, { t: 'start', cwd: e.cwd })
      await sync($)
    })().catch(() => {})
    const prefs = (await $.store.get('prefs')) as { statusOn?: boolean; autoOpen?: boolean } | undefined
    if (prefs?.statusOn) await update($, statusA, () => true)

    ticker?.cancel()
    // Every tick reads the live figures; every third re-reads the events folder, so
    // other sessions show up here; every 30th rebuilds sessions running without the mod.
    let ticks = 0
    ticker = $.clock.every(20_000, () => {
      ticks += 1
      void refresh($).catch(() => {})
      if (ticks % 3 === 0) void sync($, { backfill: ticks % 30 === 0 }).catch(() => {})
    })
    void refresh($, 'summary').catch(() => {})

    if (prefs?.autoOpen !== false) void $.ui.open({ id: PANE, title: TITLE })
    return next(e)
  })

  on('command.run', { command: 'usage-dash' }, async $ => {
    await $.ui.open({ id: PANE, title: TITLE, focus: true })
    void refresh($, 'summary').catch(() => {})
    return { text: 'Usage dashboard opened. Keys while focused: 1-8 switch tabs, r refresh.' }
  })

  on('skill.prompt', async ($, e, next) => {
    const r = await next(e)
    activeSkills.add(e.skill)
    void emit($, {
      t: 'skill', skill: e.skill, path: e.path, source: e.source, plugin: e.pluginName, promptTok: Math.round(r.text.length / 4),
    }).catch(() => {})
    return r
  }).catch(($, e, next) => next(e))

  on('tool.call', async ($, e, next) => {
    const agent = e.agentId ?? 'main'
    inFlight.set(agent, (inFlight.get(agent) ?? 0) + 1)
    const t0 = await $.clock.now()
    const ran = await next(e)
    const ms = (await $.clock.now()) - t0
    const name = String(e.tool)
    if (ran.isError && activeSkills.size) activeErrors.push(`${name}: ${(ran.text ?? '').replace(/\s+/g, ' ').slice(0, 240)}`)
    const d = toolDelta[name] ?? { n: 0, err: 0, ms: 0, denied: 0 }
    toolDelta[name] = { n: d.n + 1, err: d.err + (ran.isError ? 1 : 0), denied: d.denied + (ran.deny !== undefined ? 1 : 0), ms: d.ms + ms }
    await update($, toolsA, all => {
      const s = all[name] ?? { n: 0, err: 0, ms: 0, denied: 0 }
      return {
        ...all,
        [name]: {
          n: s.n + 1,
          err: s.err + (ran.isError ? 1 : 0),
          denied: s.denied + (ran.deny !== undefined ? 1 : 0),
          ms: s.ms + ms,
        },
      }
    })
    return ran
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const agent = e.agentId ?? 'main'
    const tools = inFlight.get(agent) ?? 0
    inFlight.delete(agent)
    const u = e.usage
    let ctxPct: number | undefined
    if (agent === 'main') {
      const snap = await refresh($, 'summary').catch(() => undefined)
      ctxPct = snap?.ctxPct
    }
    const rec: TurnRec = {
      id: e.turnId,
      at: await $.clock.now(),
      ms: e.durationMs,
      model: u?.model ?? '?',
      agent,
      tools,
      reason: e.reason,
      in: u?.input_tokens ?? 0,
      out: u?.output_tokens ?? 0,
      cr: u?.cache_read_input_tokens ?? 0,
      cw: u?.cache_creation_input_tokens ?? 0,
      ctxPct,
    }
    await update($, turnsA, list => [...list, rec].slice(-500))
    const flushed = toolDelta
    toolDelta = {}
    const ranSkills = [...activeSkills]
    const errs = activeErrors
    activeSkills = new Set()
    activeErrors = []
    const snapNow = await read($, snapA)
    void emit($, {
      t: 'turn', agent, model: rec.model, ms: rec.ms, reason: rec.reason,
      in: rec.in, out: rec.out, cr: rec.cr, cw: rec.cw, tools, toolStats: flushed,
      ctxPct, ctxTok: agent === 'main' ? snapNow?.ctxTokens : undefined, usd: snapNow?.usd,
      skills: ranSkills, skillErrors: errs,
    }).catch(() => {})
    void saveDetail($).catch(() => {})
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    ticker?.cancel()
    ticker = undefined
    await emit($, { t: 'end', reason: e.reason, usd: (await read($, snapA))?.usd }).catch(() => {})
    if (e.reason === 'clear') {
      await update($, turnsA, () => [])
      await update($, toolsA, () => ({}))
    }
    return next(e)
  })

  // ---------------------------------------------------------------- drawing

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e) as unknown as UI
    const { Box, Text, Button } = ui
    const W = Math.max(30, e.props.bodyColumns)
    const tab = await read($, tabA)
    const snap = await read($, snapA)
    const now = await $.clock.now()

    if (e.props.placement === 'widget') {
      return (
        <Box flexDirection="column">
          <Text bold>ctx {snap?.ctxPct ?? '—'}%</Text>
          <Text dimColor>{fmtUsd(snap?.usd)}</Text>
        </Box>
      )
    }

    const tabs: { id: Tab; label: string; key: string }[] = [
      { id: 'overview', label: 'Overview', key: '1' },
      { id: 'context', label: 'Context', key: '2' },
      { id: 'turns', label: 'Turns', key: '3' },
      { id: 'tools', label: 'Tools', key: '4' },
      { id: 'history', label: 'History', key: '5' },
      { id: 'models', label: 'Models', key: '6' },
      { id: 'sessions', label: 'Sessions', key: '7' },
      { id: 'optimize', label: 'Optimize', key: '8' },
    ]

    const body =
      tab === 'overview'
        ? await drawOverview($, ui, W, snap, now)
        : tab === 'context'
          ? await drawContext($, ui, W, snap)
          : tab === 'turns'
            ? await drawTurns($, ui, W)
            : tab === 'tools'
              ? await drawTools($, ui, W)
              : tab === 'models'
                ? await drawModels($, ui, W, now)
                : tab === 'sessions'
                  ? await drawSessions($, ui, W, now)
                  : tab === 'optimize'
                    ? await drawOptimize($, ui, W, now)
                  : await drawHistory($, ui, W, now)

    const busy = await read($, busyA)

    return (
      <Box flexDirection="column" width={W}>
        <Box flexDirection="row" gap={1} flexWrap="wrap">
          {tabs.map(t => (
            <Button
              key={`tab-${t.id}`}
              label={t.label}
              hotkey={t.key}
              plain
              dimColor={tab !== t.id}
              variant={tab === t.id ? 'primary' : undefined}
              onPress={() => update($, tabA, () => t.id)}
            />
          ))}
          <Button key="refresh" label="Refresh" hotkey="r" plain dimColor onPress={() => refreshAll($, tab, W)} />
        </Box>
        <Text dimColor wrap="truncate">
          {'─'.repeat(W)}
        </Text>
        {body}
        <Text dimColor wrap="truncate">
          {snap ? `updated ${fmtDur(now - snap.at)} ago` : 'waiting for first reading'}
          {busy ? ` · ${busy}` : ''}
        </Text>
      </Box>
    )
  })
}

const refreshAll = async ($: $T, tab: Tab, W: number) => {
  await update($, busyA, () => 'refreshing…')
  try {
    if (tab === 'history' || tab === 'models' || tab === 'sessions' || tab === 'optimize') await sync($, { backfill: true })
    else await refresh($, 'summary', W)
  } finally {
    await update($, busyA, () => '')
  }
}

// ---------------------------------------------------------------- overview

const drawOverview = async ($: $T, ui: UI, W: number, snap: Snapshot | null, now: number) => {
  const { Box, Text, Button } = ui
  const turns = await read($, turnsA)
  const tools = await read($, toolsA)
  const statusOn = await read($, statusA)
  const main = turns.filter(t => t.agent === 'main')
  const tot = turns.reduce((a, t) => ({ in: a.in + t.in, out: a.out + t.out, cr: a.cr + t.cr, cw: a.cw + t.cw }), {
    in: 0,
    out: 0,
    cr: 0,
    cw: 0,
  })
  const allIn = tot.in + tot.cr + tot.cw
  const hit = allIn > 0 ? tot.cr / allIn : 0
  const calls = Object.values(tools).reduce((a, s) => a + s.n, 0)
  const elapsed = snap ? now - snap.startedAt : 0
  const barW = Math.max(10, W - 34)
  const pct = snap?.ctxPct ?? 0
  const lbl = 12

  const kpi = (label: string, value: string, color?: Color) => (
    <Box flexDirection="column" marginRight={3}>
      <Text dimColor>{label}</Text>
      <Text bold color={color}>
        {value}
      </Text>
    </Box>
  )

  const ctxRow: Cell[] = [
    ...cells(pad('Context', lbl)),
    ...cells(hbar(pct / 100, barW), levelColor(pct)),
    ...cells(` ${lpad(String(snap?.ctxPct ?? '—'), 3)}%  ${fmtTok(snap?.ctxTokens)}/${fmtTok(snap?.ctxWindow)}`, undefined, true),
  ]
  const ac = snap?.bd?.autoCompactAt
  const acMarker =
    ac && snap?.ctxWindow
      ? [
          ...cells(' '.repeat(lbl + Math.min(barW - 1, Math.round((ac / snap.ctxWindow) * barW)))),
          ...cells(`▲ auto-compact at ${fmtTok(ac)}`, C.warn, true),
        ]
      : null

  const rateRows = (snap?.rate ?? []).map(r => {
    const resets = r.resetsAt ? Date.parse(r.resetsAt) - now : NaN
    return Line(ui, [
      ...cells(pad(`${rateLabel(r.kind)} limit`, lbl)),
      ...cells(hbar(r.pct / 100, barW), levelColor(r.pct)),
      ...cells(` ${lpad(r.pct.toFixed(r.pct % 1 ? 1 : 0), 4)}%  ${Number.isFinite(resets) ? `resets ${fmtDur(resets)}` : ''}`, undefined, true),
    ])
  })

  const ctxSeries = main.map(t => t.ctxPct ?? 0)
  const outSeries = turns.map(t => t.out)
  const sparkW = Math.max(10, W - 22)
  const outMin = elapsed > 60_000 ? (tot.out / elapsed) * 60_000 : undefined
  const usdHr = snap?.usd !== undefined && elapsed > 60_000 ? (snap.usd / elapsed) * 3_600_000 : undefined

  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="row" flexWrap="wrap">
        {kpi('Cost', fmtUsd(snap?.usd), C.accent)}
        {kpi('Session', fmtDur(elapsed))}
        {kpi('Turns', `${main.length}${turns.length > main.length ? ` +${turns.length - main.length} sub` : ''}`)}
        {kpi('Tool calls', String(calls))}
        {kpi('Cache hit', allIn ? `${Math.round(hit * 100)}%` : '—', hit > 0.8 ? C.ok : hit > 0.5 ? C.warn : undefined)}
        {kpi('Burn', usdHr !== undefined ? `${fmtUsd(usdHr)}/h` : outMin !== undefined ? `${fmtTok(outMin)} out/min` : '—')}
      </Box>

      <Box flexDirection="column">
        {Line(ui, ctxRow)}
        {acMarker && Line(ui, acMarker)}
        {rateRows.length > 0 ? rateRows : <Text dimColor>{pad('', lbl)}no rate-limit windows reported (API key / not yet)</Text>}
      </Box>

      <Box flexDirection="column">
        <Text bold>Tokens this session · {fmtTok(sumTok(tot))}</Text>
        {Line(ui, stackBar([
          { v: tot.in, color: C.in },
          { v: tot.cr, color: C.cr },
          { v: tot.cw, color: C.cw },
          { v: tot.out, color: C.out },
        ], W))}
        {Line(ui, [
          ...cells('■ ', C.in), ...cells(`input ${fmtTok(tot.in)}   `, undefined, true),
          ...cells('■ ', C.cr), ...cells(`cache read ${fmtTok(tot.cr)}   `, undefined, true),
          ...cells('■ ', C.cw), ...cells(`cache write ${fmtTok(tot.cw)}   `, undefined, true),
          ...cells('■ ', C.out), ...cells(`output ${fmtTok(tot.out)}`, undefined, true),
        ])}
      </Box>

      <Box flexDirection="column">
        {Line(ui, [...cells(pad('Context/turn', 14), undefined, true), ...cells(spark(ctxSeries.slice(-sparkW), 100) || 'no turns yet', C.accent), ...cells(ctxSeries.length ? `  ${ctxSeries[ctxSeries.length - 1]}%` : '', undefined, true)])}
        {Line(ui, [...cells(pad('Output/turn', 14), undefined, true), ...cells(spark(outSeries.slice(-sparkW)) || 'no turns yet', C.out), ...cells(outSeries.length ? `  max ${fmtTok(Math.max(...outSeries))}` : '', undefined, true)])}
      </Box>

      <Box flexDirection="row" gap={2}>
        <Button
          key="status"
          label={`Status line: ${statusOn ? 'on' : 'off'}`}
          hotkey="s"
          plain
          onPress={async () => {
            const next = !statusOn
            await update($, statusA, () => next)
            const prefs = ((await $.store.get('prefs')) as object | undefined) ?? {}
            await $.store.set('prefs', { ...prefs, statusOn: next })
            const s = await read($, snapA)
            $.ui.status(next && s ? statusText(s) : undefined)
          }}
        />
        <Button
          key="autoopen"
          label="Open at start: toggle"
          hotkey="o"
          plain
          dimColor
          onPress={async () => {
            const prefs = ((await $.store.get('prefs')) as { autoOpen?: boolean } | undefined) ?? {}
            const next = prefs.autoOpen === false
            await $.store.set('prefs', { ...prefs, autoOpen: next })
            $.ui.toast(`Dashboard ${next ? 'opens' : 'no longer opens'} at session start`)
          }}
        />
      </Box>
    </Box>
  )
}

// ---------------------------------------------------------------- context

const drawContext = async ($: $T, ui: UI, W: number, snap: Snapshot | null) => {
  const { Box, Text, Button } = ui
  const bd = snap?.bd
  if (!bd) {
    return (
      <Box flexDirection="column">
        <Text dimColor>No breakdown yet. Press r to estimate, f for an exact count.</Text>
        <Button key="full" label="Exact count (token API)" hotkey="f" plain onPress={() => fullCount($, W)} />
      </Box>
    )
  }

  const used = bd.categories.filter(c => c.kind === 'used').sort((a, z) => z.tokens - a.tokens)
  const free = bd.categories.find(c => c.kind === 'free')
  const buffer = bd.categories.find(c => c.kind === 'buffer')
  const deferred = bd.categories.filter(c => c.kind === 'deferred')
  const nameW = Math.min(22, Math.max(...bd.categories.map(c => c.name.length), 8))
  const barW = Math.max(8, W - nameW - 18)
  const maxTok = Math.max(...used.map(c => c.tokens), 1)

  const gridRows = bd.grid.map(row =>
    Line(
      ui,
      row.flatMap(sq => {
        const isFree = sq.name === free?.name
        const isBuf = sq.name === buffer?.name
        const ch = isFree ? '·' : isBuf ? '░' : !sq.filled ? '·' : sq.full >= 0.7 ? '■' : '□'
        return [{ ch, color: (isFree ? C.dim : sq.color) as Color, dim: isFree }, { ch: ' ' }]
      }),
    ),
  )

  const catRow = (c: { name: string; tokens: number; color: string }, max: number, dim = false) =>
    Line(ui, [
      ...cells('■ ', c.color as Color, dim),
      ...cells(pad(c.name, nameW) + ' ', undefined, dim),
      ...cells(hbar(c.tokens / max, barW), c.color as Color, dim),
      ...cells(` ${lpad(fmtTok(c.tokens), 6)} ${lpad(((c.tokens / bd.max) * 100).toFixed(1), 5)}%`, undefined, true),
    ])

  const topN = (W >= 100 ? 8 : 5)
  const listRow = (name: string, tok: number, max: number, color: Color, extra = '') =>
    Line(ui, [
      ...cells(pad(name, Math.max(10, W - barW / 2 - 18)) + ' ', undefined, true),
      ...cells(hbar(tok / max, Math.floor(barW / 2)), color),
      ...cells(` ${lpad(fmtTok(tok), 6)}${extra}`, undefined, true),
    ])

  const section = (title: string, rows: ReturnType<typeof Line>[], note = '') =>
    rows.length === 0 ? null : (
      <Box flexDirection="column">
        <Text bold>
          {title}
          <Text dimColor>{note}</Text>
        </Text>
        {rows}
      </Box>
    )

  const memMax = Math.max(...bd.memory.map(m => m.tokens), 1)
  const mcpMax = Math.max(...bd.mcp.map(m => m.tokens), 1)
  const skMax = Math.max(...bd.skills.map(m => m.tokens), 1)
  const agMax = Math.max(...bd.agents.map(m => m.tokens), 1)
  const home = bd.memory.find(m => m.path.startsWith('/home/'))?.path.split('/').slice(0, 3).join('/')

  const gridAndLegend = W >= 90 ? 'row' : 'column'

  return (
    <Box flexDirection="column" gap={1}>
      <Text>
        <Text bold>{shortModel(bd.model)}</Text>
        <Text dimColor>
          {'  '}
          {fmtTok(bd.total)} / {fmtTok(bd.max)} tokens · {bd.pct}% · window from {bd.source} · {bd.detail === 'full' ? 'exact count' : 'estimate'}
        </Text>
      </Text>
      {Line(ui, stackBar([...used.map(c => ({ v: c.tokens, color: c.color as Color })), ...(buffer ? [{ v: buffer.tokens, color: C.warn as Color }] : [])], W, bd.max))}
      <Box flexDirection={gridAndLegend} gap={3}>
        <Box flexDirection="column">{gridRows}</Box>
        <Box flexDirection="column" flexGrow={1}>
          {used.map(c => catRow(c, maxTok))}
          {buffer && catRow(buffer, maxTok, true)}
          {free && catRow(free, bd.max, true)}
          {deferred.map(c => catRow(c, maxTok, true))}
        </Box>
      </Box>
      {section(
        'Memory files',
        bd.memory.sort((a, z) => z.tokens - a.tokens).slice(0, topN).map(m => listRow(`${m.type.padEnd(8)} ${home ? m.path.replace(home, '~') : m.path}`, m.tokens, memMax, C.accent)),
        `  ${bd.memory.length} files · ${fmtTok(bd.memory.reduce((a, m) => a + m.tokens, 0))}`,
      )}
      {section(
        'MCP servers',
        bd.mcp.slice(0, topN).map(m => listRow(m.server, m.tokens, mcpMax, 'permission', `  ${m.loaded}/${m.tools} loaded`)),
        `  ${bd.mcp.reduce((a, m) => a + m.tools, 0)} tools`,
      )}
      {section(
        'Skills',
        bd.skills.slice(0, topN).map(s => listRow(s.name, s.tokens, skMax, 'planMode')),
        bd.skillTotal ? `  ${bd.skillTotal.included}/${bd.skillTotal.n} listed · ${fmtTok(bd.skillTotal.tokens)}` : '',
      )}
      {section('Agent types', bd.agents.slice(0, topN).map(a => listRow(a.name, a.tokens, agMax, 'ide')), `  ${bd.agents.length}`)}
      <Box flexDirection="row" gap={2}>
        <Button key="full" label="Exact count (token API)" hotkey="f" plain onPress={() => fullCount($, W)} />
        <Button
          key="compact"
          label="Compact now"
          hotkey="c"
          plain
          dimColor
          onPress={async () => {
            const ok = await $.ui.ask('Compact the conversation now?', ['Compact', 'Cancel'])
            if (ok === 'Compact') {
              const r = await $.session.compact()
              $.ui.toast('skip' in r && r.skip ? `Compaction skipped: ${r.skip}` : 'Compacted')
              await refresh($, 'summary', W)
            }
          }}
        />
      </Box>
    </Box>
  )
}

const fullCount = async ($: $T, W: number) => {
  await update($, busyA, () => 'counting with the token API…')
  try {
    await refresh($, 'full', W)
  } finally {
    await update($, busyA, () => '')
  }
}

// ---------------------------------------------------------------- turns

const drawTurns = async ($: $T, ui: UI, W: number) => {
  const { Box, Text, Button, Select } = ui
  const scope = await read($, scopeA)
  const modelPick = await read($, turnModelA)
  const all = await read($, turnsA)
  const seenModels = [...new Set(all.map(t => t.model))]
  const turns = all.filter(
    t =>
      (scope === 'main' ? t.agent === 'main' : scope === 'sub' ? t.agent !== 'main' : true) &&
      (modelPick === '' || t.model === modelPick),
  )
  const axisW = 6
  const room = W - axisW - 1
  const colW = Math.max(1, Math.min(3, Math.floor(room / Math.max(1, Math.min(turns.length, room)) ) - 1))
  const gap = colW > 1 ? 1 : 0
  const n = Math.max(1, Math.floor((room + gap) / (colW + gap)))
  const shown = turns.slice(-n)

  const chart = shown.length
    ? columns(
        ui,
        shown.map(t => ({
          segs: [
            { v: t.in, color: C.in },
            { v: t.cw, color: C.cw },
            { v: t.out, color: C.out },
          ],
        })),
        8,
        colW,
        gap,
        axisW,
        fmtTok,
      )
    : [<Text dimColor>No turns yet: this fills as the conversation runs.</Text>]

  const durMax = Math.max(...shown.map(t => t.ms), 1)
  const tableN = Math.min(12, shown.length)
  const head = `${pad('#', 4)}${pad('agent', 9)}${pad('model', 12)}${lpad('dur', 8)}${lpad('in', 7)}${lpad('c.read', 8)}${lpad('c.write', 8)}${lpad('out', 7)}${lpad('tools', 6)}${lpad('ctx', 5)}`
  const first = all.length - shown.length

  const totals = turns.reduce((a, t) => ({ ms: a.ms + t.ms, out: a.out + t.out, tools: a.tools + t.tools }), { ms: 0, out: 0, tools: 0 })

  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="row" gap={2}>
        <Text bold>Tokens per turn</Text>
        {(['all', 'main', 'sub'] as const).map(s => (
          <Button
            key={`scope-${s}`}
            label={s === 'all' ? 'All' : s === 'main' ? 'Main' : 'Subagents'}
            hotkey={s === 'all' ? 'a' : s === 'main' ? 'm' : 'b'}
            plain
            dimColor={scope !== s}
            onPress={() => update($, scopeA, () => s)}
          />
        ))}
        {seenModels.length > 1 && (
          <Select
            key="turn-model"
            label="Model"
            value={modelPick}
            options={[{ value: '', label: 'All models' }, ...seenModels.map(m => ({ value: m, label: shortModel(m) }))]}
            onSelect={v => update($, turnModelA, () => v)}
          />
        )}
      </Box>
      <Box flexDirection="column">
        {chart}
        {Legend(ui, [
          { label: 'uncached in', color: C.in },
          { label: 'cache write', color: C.cw },
          { label: 'output', color: C.out },
        ])}
        <Text dimColor>cache reads left out of the columns: they dwarf the rest; see the table</Text>
      </Box>
      <Box flexDirection="column">
        <Text bold>Duration</Text>
        {Line(ui, [...cells(spark(shown.map(t => t.ms), durMax), C.accent), ...cells(shown.length ? `  max ${fmtDur(durMax)}` : '', undefined, true)])}
      </Box>
      {tableN > 0 && (
        <Box flexDirection="column">
          <Text bold wrap="truncate">
            {head}
          </Text>
          {shown.slice(-tableN).reverse().map((t, i) => {
            const idx = all.indexOf(t) + 1
            return Line(ui, [
              ...cells(pad(String(idx), 4), undefined, true),
              ...cells(pad(t.agent === 'main' ? 'main' : t.agent.slice(0, 7), 9), t.agent === 'main' ? undefined : 'ide'),
              ...cells(pad(shortModel(t.model), 12), modelColor(t.model)),
              ...cells(lpad(fmtDur(t.ms), 8)),
              ...cells(lpad(fmtTok(t.in), 7), C.in),
              ...cells(lpad(fmtTok(t.cr), 8), C.cr),
              ...cells(lpad(fmtTok(t.cw), 8), C.cw),
              ...cells(lpad(fmtTok(t.out), 7), C.out),
              ...cells(lpad(String(t.tools), 6)),
              ...cells(lpad(t.ctxPct !== undefined ? `${t.ctxPct}%` : '', 5), t.ctxPct !== undefined ? levelColor(t.ctxPct) : undefined),
              ...cells(t.reason !== 'answer' ? `  ${t.reason}` : '', C.bad),
            ])
          })}
          <Text dimColor>
            {turns.length} turns · {fmtDur(totals.ms)} total · avg {fmtDur(totals.ms / Math.max(1, turns.length))} · {fmtTok(totals.out)} out · {totals.tools} tool calls
            {first > 0 ? ` · chart shows last ${shown.length}` : ''}
          </Text>
        </Box>
      )}
    </Box>
  )
}

// ---------------------------------------------------------------- tools

const drawTools = async ($: $T, ui: UI, W: number) => {
  const { Box, Text, Button } = ui
  const sort = await read($, toolSortA)
  const tools = await read($, toolsA)
  const turns = await read($, turnsA)
  const rows = Object.entries(tools).map(([name, s]) => ({ name, ...s, avg: s.ms / Math.max(1, s.n) }))
  rows.sort((a, z) => (sort === 'time' ? z.ms - a.ms : sort === 'errors' ? z.err + z.denied - (a.err + a.denied) : z.n - a.n))
  const nameW = Math.min(28, Math.max(8, ...rows.map(r => r.name.length)) + 1)
  const barW = Math.max(8, W - nameW - 30)
  const metric = (r: (typeof rows)[number]) => (sort === 'time' ? r.ms : sort === 'errors' ? r.err + r.denied : r.n)
  const max = Math.max(...rows.map(metric), 1)

  // Tokens by agent: the main loop against each subagent run.
  const agents = new Map<string, { tok: number; out: number; turns: number; ms: number }>()
  for (const t of turns) {
    const a = agents.get(t.agent) ?? { tok: 0, out: 0, turns: 0, ms: 0 }
    a.tok += sumTok(t)
    a.out += t.out
    a.turns += 1
    a.ms += t.ms
    agents.set(t.agent, a)
  }
  const agentRows = [...agents.entries()].sort((a, z) => z[1].tok - a[1].tok)
  const agMax = Math.max(...agentRows.map(a => a[1].tok), 1)

  // Model split.
  const models = new Map<string, number>()
  for (const t of turns) models.set(shortModel(t.model), (models.get(shortModel(t.model)) ?? 0) + sumTok(t))
  const modelSegs = [...models.entries()].sort((a, z) => z[1] - a[1]).map(([name, v]) => ({ name, v, color: modelColor(name) }))

  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="row" gap={2}>
        <Text bold>Tool calls</Text>
        {(['count', 'time', 'errors'] as const).map((s, i) => (
          <Button
            key={`sort-${s}`}
            label={`by ${s}`}
            hotkey={['n', 't', 'e'][i]}
            plain
            dimColor={sort !== s}
            onPress={() => update($, toolSortA, () => s)}
          />
        ))}
      </Box>
      {rows.length === 0 ? (
        <Text dimColor>No tool calls yet.</Text>
      ) : (
        <Box flexDirection="column">
          {rows.slice(0, 20).map((r, i) =>
            Line(ui, [
              ...cells(pad(r.name, nameW), undefined, true),
              ...cells(hbar(metric(r) / max, barW), SERIES[i % SERIES.length]!),
              ...cells(` ${lpad(String(r.n), 4)}×  avg ${lpad(fmtDur(r.avg), 6)}  `, undefined, true),
              ...cells(r.err ? `${r.err} err ` : '', C.bad),
              ...cells(r.denied ? `${r.denied} denied` : '', C.warn),
            ]),
          )}
          {rows.length > 20 && <Text dimColor>+{rows.length - 20} more</Text>}
        </Box>
      )}
      {agentRows.length > 0 && (
        <Box flexDirection="column">
          <Text bold>Tokens by agent</Text>
          {agentRows.slice(0, 10).map(([id, a]) =>
            Line(ui, [
              ...cells(pad(id === 'main' ? 'main loop' : id.slice(0, 16), 18), id === 'main' ? undefined : 'ide'),
              ...cells(hbar(a.tok / agMax, Math.max(8, W - 50)), id === 'main' ? C.accent : 'ide'),
              ...cells(` ${lpad(fmtTok(a.tok), 7)}  ${a.turns} turns  ${fmtDur(a.ms)}`, undefined, true),
            ]),
          )}
        </Box>
      )}
      {modelSegs.length > 0 && (
        <Box flexDirection="column">
          <Text bold>Tokens by model</Text>
          {Line(ui, stackBar(modelSegs.map(m => ({ v: m.v, color: m.color })), W))}
          {Legend(ui, modelSegs.map(m => ({ label: `${m.name} ${fmtTok(m.v)}`, color: m.color })))}
        </Box>
      )}
    </Box>
  )
}

// ---------------------------------------------------------------- models

const drawModels = async ($: $T, ui: UI, W: number, now: number) => {
  const { Box, Text, Button, Select } = ui
  const turns = await read($, turnsA)
  const hist = await read($, histA)
  const metric = await read($, metricA)
  const scanState = await read($, scanA)

  // This session, from the turns the mod has seen.
  type Agg = { in: number; out: number; cr: number; cw: number; turns: number; ms: number; sub: number }
  const by = new Map<string, Agg>()
  for (const t of turns) {
    const a = by.get(t.model) ?? { in: 0, out: 0, cr: 0, cw: 0, turns: 0, ms: 0, sub: 0 }
    a.in += t.in
    a.out += t.out
    a.cr += t.cr
    a.cw += t.cw
    a.turns += 1
    a.ms += t.ms
    a.sub += t.agent === 'main' ? 0 : 1
    by.set(t.model, a)
  }
  const sess = [...by.entries()].sort((a, z) => sumTok(z[1]) - sumTok(a[1]))
  const sessTotal = sess.reduce((a, [, v]) => a + sumTok(v), 0)
  const nameW = 14
  const head = `${pad('model', nameW)}${lpad('turns', 6)}${lpad('sub', 5)}${lpad('in', 7)}${lpad('c.read', 8)}${lpad('c.write', 8)}${lpad('out', 7)}${lpad('total', 8)}${lpad('share', 7)}${lpad('hit', 5)}${lpad('avg dur', 9)}${lpad('out/turn', 9)}`

  const sessionBlock =
    sess.length === 0 ? (
      <Text dimColor>No turns yet in this session.</Text>
    ) : (
      <Box flexDirection="column">
        {Line(ui, stackBar(sess.map(([m, v]) => ({ v: sumTok(v), color: modelColor(m) })), W))}
        {Legend(ui, sess.map(([m, v]) => ({ label: `${shortModel(m)} ${Math.round((sumTok(v) / Math.max(1, sessTotal)) * 100)}%`, color: modelColor(m) })))}
        <Text bold wrap="truncate">
          {head}
        </Text>
        {sess.map(([m, v]) => {
          const allIn = v.in + v.cr + v.cw
          return Line(ui, [
            ...cells(pad(shortModel(m), nameW), modelColor(m), false, true),
            ...cells(lpad(String(v.turns), 6)),
            ...cells(lpad(String(v.sub), 5), 'ide', true),
            ...cells(lpad(fmtTok(v.in), 7), C.in),
            ...cells(lpad(fmtTok(v.cr), 8), C.cr),
            ...cells(lpad(fmtTok(v.cw), 8), C.cw),
            ...cells(lpad(fmtTok(v.out), 7), C.out),
            ...cells(lpad(fmtTok(sumTok(v)), 8), undefined, false, true),
            ...cells(lpad(`${Math.round((sumTok(v) / Math.max(1, sessTotal)) * 100)}%`, 7)),
            ...cells(lpad(allIn ? `${Math.round((v.cr / allIn) * 100)}%` : '—', 5), undefined, true),
            ...cells(lpad(fmtDur(v.ms / v.turns), 9), undefined, true),
            ...cells(lpad(fmtTok(v.out / v.turns), 9), undefined, true),
          ])
        })}
      </Box>
    )

  // History, from the transcript scan, day by day.
  let historyBlock
  if (!hist) {
    historyBlock = <Text dimColor>Nothing read from the events folder yet. Press s to sync.</Text>
  } else if (!hist.days.some(d => d.models)) {
    historyBlock = <Text dimColor>No per-model data in this range. Press s to sync.</Text>
  } else {
    const pick = (d: HistDayModel | undefined) => (!d ? 0 : metric === 'output' ? d.out : metric === 'requests' ? d.n : d.tok)
    const names = [...new Set(hist.days.flatMap(d => Object.keys(d.models ?? {})))]
    const totals = names
      .map(m => ({ m, v: hist.days.reduce((a, d) => a + pick(d.models?.[m]), 0) }))
      .sort((a, z) => z.v - a.v)
    const grand = totals.reduce((a, t) => a + t.v, 0)
    const days = hist.days
    const axisW = 7
    const room = W - axisW - 1
    const colW = Math.max(1, Math.min(4, Math.floor(room / days.length) - 1))
    const gap = Math.floor(room / days.length) > 1 ? 1 : 0
    const fmtAxis = metric === 'requests' ? (n: number) => String(Math.round(n)) : fmtTok
    const chart = columns(
      ui,
      days.map(d => ({ segs: totals.map(t => ({ v: pick(d.models?.[t.m]), color: modelColor(t.m) })) })),
      10,
      colW,
      gap,
      axisW,
      fmtAxis,
    )
    const span = days.length * colW + (days.length - 1) * gap
    const a = days[0]?.date.slice(5) ?? ''
    const z = days[days.length - 1]?.date.slice(5) ?? ''
    const sparkW = Math.max(7, Math.min(days.length, W - 60))
    const maxV = Math.max(...totals.map(t => t.v), 1)
    historyBlock = (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          {chart}
          <Text dimColor wrap="truncate">
            {' '.repeat(axisW + 1) + a + ' '.repeat(Math.max(1, span - a.length - z.length)) + z}
          </Text>
          {Legend(ui, totals.map(t => ({ label: shortModel(t.m), color: modelColor(t.m) })))}
        </Box>
        <Box flexDirection="column">
          <Text bold wrap="truncate">
            {`${pad('model', nameW)}${pad('share', Math.max(8, W - nameW - sparkW - 34))}${lpad(metric === 'requests' ? 'requests' : metric === 'output' ? 'output' : 'tokens', 9)}${lpad('%', 5)}${lpad('days', 6)}  daily`}
          </Text>
          {totals.map(t => {
            const series = days.map(d => pick(d.models?.[t.m]))
            const activeDays = series.filter(v => v > 0).length
            return Line(ui, [
              ...cells(pad(shortModel(t.m), nameW), modelColor(t.m), false, true),
              ...cells(hbar(t.v / maxV, Math.max(8, W - nameW - sparkW - 34)), modelColor(t.m)),
              ...cells(lpad(metric === 'requests' ? String(t.v) : fmtTok(t.v), 9)),
              ...cells(lpad(`${Math.round((t.v / Math.max(1, grand)) * 100)}%`, 5), undefined, true),
              ...cells(lpad(String(activeDays), 6), undefined, true),
              ...cells('  ' + spark(series.slice(-sparkW)), modelColor(t.m)),
            ])
          })}
        </Box>
        <Text dimColor>
          last {hist.rangeDays} days · synced {fmtDur(now - hist.scannedAt)} ago{scanState === 'scanning' ? ' · syncing…' : ''}
        </Text>
      </Box>
    )
  }

  return (
    <Box flexDirection="column" gap={1}>
      <Text bold>This session by model</Text>
      {sessionBlock}
      <Box flexDirection="row" gap={2} flexWrap="wrap">
        <Text bold>History by model</Text>
        <Select
          key="model-metric"
          label="Metric"
          value={metric}
          options={[
            { value: 'total', label: 'All tokens' },
            { value: 'output', label: 'Output tokens' },
            { value: 'requests', label: 'API requests' },
          ]}
          onSelect={v => update($, metricA, () => v as HistMetric)}
        />
        <Button
          key="model-scan"
          label={scanState === 'scanning' ? 'Syncing…' : 'Sync'}
          hotkey="s"
          plain
          onPress={() => sync($, { backfill: true })}
        />
      </Box>
      {historyBlock}
      {scanState && scanState !== 'scanning' && <Text color={C.bad}>{scanState}</Text>}
    </Box>
  )
}

// ---------------------------------------------------------------- sessions (all time)

const drawSessions = async ($: $T, ui: UI, W: number, now: number) => {
  const { Box, Text, Button } = ui
  const saved = await read($, savedA)
  const currentId = await $.session.id()
  const sessions = [...saved.sessions].sort((a, z) => z.lastAt - a.lastAt)

  if (sessions.length === 0 && Object.keys(saved.costDays).length === 0) {
    return (
      <Text dimColor>
        No sessions in the events folder yet. Press r to rebuild them from your transcripts.
      </Text>
    )
  }

  // Daily cost, last 30 days, from the real per-day ledger.
  const N = 30
  const days = Array.from({ length: N }, (_, i) => dayKey(now - (N - 1 - i) * 86_400_000))
  const costs = days.map(d => saved.costDays[d] ?? 0)
  const allCost = Object.values(saved.costDays).reduce((a, v) => a + v, 0)
  const week = costs.slice(-7).reduce((a, v) => a + v, 0)
  const month = costs.reduce((a, v) => a + v, 0)
  const recorded = Object.keys(saved.costDays).sort()[0]

  const axisW = 7
  const room = W - axisW - 1
  const colW = Math.max(1, Math.min(3, Math.floor(room / N) - 1))
  const gap = Math.floor(room / N) > 1 ? 1 : 0
  const chart = columns(ui, costs.map(v => ({ segs: [{ v, color: C.accent as Color }] })), 8, colW, gap, axisW, n => fmtUsd(n))
  const span = N * colW + (N - 1) * gap
  const xa = days[0]!.slice(5)
  const xz = 'today'

  // Tokens by model, all sessions.
  const byModel = new Map<string, number>()
  for (const s of sessions) for (const [m, t] of Object.entries(s.models)) byModel.set(m, (byModel.get(m) ?? 0) + sumTok(t))
  const modelSegs = [...byModel.entries()].sort((a, z) => z[1] - a[1])

  const home = sessions.find(s => s.cwd.startsWith('/home/'))?.cwd.split('/').slice(0, 3).join('/')
  const proj = (cwd: string) => (home && cwd.startsWith(home) ? '~' + cwd.slice(home.length) : cwd) || '—'
  const usdMax = Math.max(...sessions.map(s => s.usd), 0.01)
  const projW = Math.min(24, Math.max(8, ...sessions.slice(0, 15).map(s => proj(s.cwd).length)) + 1)
  const barW = Math.max(6, W - projW - 62)

  const tools = Object.entries(saved.toolsAll).sort((a, z) => z[1].n - a[1].n).slice(0, 8)
  const toolMax = Math.max(...tools.map(t => t[1].n), 1)

  const kpi = (label: string, value: string, color?: Color) => (
    <Box flexDirection="column" marginRight={3}>
      <Text dimColor>{label}</Text>
      <Text bold color={color}>
        {value}
      </Text>
    </Box>
  )

  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="row" flexWrap="wrap">
        {kpi('All recorded', fmtUsd(allCost), C.accent)}
        {kpi('Last 30 days', fmtUsd(month))}
        {kpi('Last 7 days', fmtUsd(week))}
        {kpi('Sessions', String(sessions.length))}
        {kpi('Avg / session', fmtUsd(sessions.length ? sessions.reduce((a, s) => a + s.usd, 0) / sessions.length : undefined))}
        {kpi('Tokens', fmtTok(sessions.reduce((a, s) => a + sumTok(s.tok), 0)))}
      </Box>
      <Box flexDirection="column">
        <Text bold>Cost per day</Text>
        {chart}
        <Text dimColor wrap="truncate">
          {' '.repeat(axisW + 1) + xa + ' '.repeat(Math.max(1, span - xa.length - xz.length)) + xz}
        </Text>
      </Box>
      {modelSegs.length > 0 && (
        <Box flexDirection="column">
          <Text bold>Tokens by model, all sessions</Text>
          {Line(ui, stackBar(modelSegs.map(([m, v]) => ({ v, color: modelColor(m) })), W))}
          {Legend(ui, modelSegs.map(([m, v]) => ({ label: `${shortModel(m)} ${fmtTok(v)}`, color: modelColor(m) })))}
        </Box>
      )}
      <Box flexDirection="column">
        <Text bold wrap="truncate">
          {`  ${pad('when', 12)}${pad('project', projW)}${lpad('length', 8)}${lpad('turns', 6)}${lpad('sub', 6)}${lpad('tokens', 8)}${lpad('peak', 7)}  ${pad('model', 12)} ${pad('cost', barW)} `}
        </Text>
        {sessions.slice(0, 15).map(s => {
          const top = Object.entries(s.models).sort((a, z) => sumTok(z[1]) - sumTok(a[1]))[0]?.[0] ?? '?'
          const d = new Date(s.startedAt)
          const when = `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
          return Line(ui, [
            ...cells(s.id === currentId ? '● ' : s.src === 'live' ? '◦ ' : '  ', s.id === currentId ? C.ok : C.dim, s.id !== currentId),
            ...cells(pad(when, 12), undefined, true),
            ...cells(pad(proj(s.cwd), projW)),
            ...cells(lpad(fmtDur(s.lastAt - s.startedAt), 8), undefined, true),
            ...cells(lpad(String(s.turns), 6)),
            ...cells(lpad(String(s.sub), 6), 'ide', true),
            ...cells(lpad(fmtTok(sumTok(s.tok)), 8), undefined, true),
            ...cells(lpad(s.peakCtx ? `${s.peakCtx}%` : s.peakTok ? fmtTok(s.peakTok) : '', 7), s.peakCtx ? levelColor(s.peakCtx) : s.peakTok >= 300_000 ? C.warn : undefined),
            ...cells('  ' + pad(shortModel(top), 12) + ' ', modelColor(top)),
            ...(s.usd > 0
              ? [...cells(hbar(s.usd / usdMax, barW), C.accent), ...cells(` ${fmtUsd(s.usd)}`, undefined, false, true)]
              : cells(pad('', barW) + ' —', undefined, true)),
          ])
        })}
        {sessions.length > 15 && <Text dimColor>+{sessions.length - 15} older sessions</Text>}
      </Box>
      {tools.length > 0 && (
        <Box flexDirection="column">
          <Text bold>Tools, all sessions</Text>
          {tools.map(([name, t], i) =>
            Line(ui, [
              ...cells(pad(name, 22), undefined, true),
              ...cells(hbar(t.n / toolMax, Math.max(8, W - 52)), SERIES[i % SERIES.length]!),
              ...cells(` ${lpad(String(t.n), 6)}×  avg ${lpad(fmtDur(t.ms / Math.max(1, t.n)), 6)}`, undefined, true),
              ...cells(t.err ? `  ${t.err} err` : '', C.bad),
            ]),
          )}
        </Box>
      )}
      <Text dimColor wrap="wrap">
        ● this session · ◦ recorded live by the mod · others rebuilt from transcripts (tokens, no cost) · cost recorded since {recorded ?? '—'} · events in {saved.eventsDir.replace(homeDir($), '~') || '~/.claude/usage-events'}
      </Text>
    </Box>
  )
}

// ---------------------------------------------------------------- optimize: skills tracking
//
// Each skill run is charged the turn it ran in: that turn's tokens, time,
// tool errors (with a short sample of each) and whether it was interrupted.
// The events carry it; the aggregate adds it up.

// Skills expanded but not yet attributed to a turn, and their errors so far:
// sent with the turn's event, where the aggregate charges each skill the turn.
let activeSkills = new Set<string>()
let activeErrors: string[] = []

const loadSkills = async ($: $T) => {
  const dismissed = ((await $.store.get('dismissed')) as string[] | undefined) ?? []
  await update($, dismissedA, () => dismissed)
  const review = (await $.store.get('review')) as Review | undefined
  if (review) await update($, reviewA, () => review)
  const proposal = (await $.store.get('proposal')) as Proposal | undefined
  if (proposal) await update($, proposalA, () => proposal)
}

// ---------------------------------------------------------------- optimize: findings

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')

const computeFindings = (
  snap: Snapshot | null,
  saved: Saved,
  skills: Record<string, SkillStat>,
  since: number,
  turns: TurnRec[],
  tools: Record<string, ToolStat>,
  now: number,
): Finding[] => {
  const out: Finding[] = []
  const bd = snap?.bd
  const sessionsSince = saved.sessions.filter(s => s.startedAt >= since).length

  // Context pressure, now.
  if ((snap?.ctxPct ?? 0) >= 80) {
    out.push({
      id: 'ctx-now', sev: 'high', area: 'Context',
      title: `Context is ${snap!.ctxPct}% full`,
      detail: 'Every request now re-reads most of the window. Compact at a natural break to cut the cost of each turn and avoid an automatic compaction mid-task.',
      saves: snap?.ctxTokens ? Math.round(snap.ctxTokens * 0.6) : undefined,
      action: { kind: 'compact' },
    })
  }

  // Context pressure, across sessions.
  const recent = [...saved.sessions].sort((a, z) => z.lastAt - a.lastAt).slice(0, 20)
  const full = recent.filter(s => s.peakCtx >= 90 || s.peakTok >= 300_000).length
  if (full >= 3) {
    out.push({
      id: 'ctx-sessions', sev: 'med', area: 'Context',
      title: `${full} of your last ${recent.length} sessions ran past 90% or 300k tokens of context`,
      detail: 'Long sessions pay for their whole history on every request. Hand exploration to subagents, /compact between tasks, or start a new session per task.',
    })
  }

  // Rate limits.
  for (const r of snap?.rate ?? []) {
    if (r.pct >= 80) {
      out.push({
        id: `rate-${r.kind}`, sev: 'high', area: 'Limits',
        title: `${rateLabel(r.kind)} limit at ${r.pct}%`,
        detail: 'Move routine work (searches, edits, tests) to a smaller model or subagents on Sonnet/Haiku until the window resets.',
      })
    }
  }

  // Cache efficiency in this session.
  const tot = turns.reduce((a, t) => ({ in: a.in + t.in, cr: a.cr + t.cr, cw: a.cw + t.cw }), { in: 0, cr: 0, cw: 0 })
  const allIn = tot.in + tot.cr + tot.cw
  if (turns.length >= 5 && allIn > 0 && tot.cr / allIn < 0.6) {
    out.push({
      id: 'cache-low', sev: 'med', area: 'Cache',
      title: `Cache hit only ${Math.round((tot.cr / allIn) * 100)}% this session`,
      detail: 'Cache writes cost more than reads. Switching models, editing CLAUDE.md or MCP/tool sets mid-session, and long idle gaps (cache expiry) all force rewrites.',
      saves: tot.cw,
    })
  }

  // Subagents on the biggest model.
  const sub = turns.filter(t => t.agent !== 'main')
  const subTok = sub.reduce((a, t) => a + sumTok(t), 0)
  const subOpus = sub.filter(t => /opus/i.test(t.model)).reduce((a, t) => a + sumTok(t), 0)
  if (sub.length >= 3 && subTok > 0 && subOpus / subTok >= 0.5) {
    out.push({
      id: 'sub-opus', sev: 'med', area: 'Models',
      title: `${Math.round((subOpus / subTok) * 100)}% of subagent tokens ran on Opus`,
      detail: 'Your CLAUDE.md asks for the smallest model that does the job: haiku for searches and lookups, sonnet for routine coding and tests. Set `model` when spawning, or in the agent definition.',
      saves: Math.round(subOpus * 0.5),
      action: { kind: 'tab', tab: 'models' },
    })
  }

  // MCP servers carried but never called.
  if (bd && sessionsSince >= 3) {
    const calledServers = new Set(
      Object.keys(saved.toolsAll)
        .filter(n => n.startsWith('mcp__'))
        .map(n => norm(n.split('__')[1] ?? '')),
    )
    for (const m of bd.mcp) {
      if (m.loaded === 0 || m.tokens < 800) continue
      const key = norm(m.server)
      const used = [...calledServers].some(c => c === key || c.endsWith(key) || key.endsWith(c))
      if (!used) {
        out.push({
          id: `mcp-${key}`, sev: m.tokens >= 3000 ? 'med' : 'low', area: 'Context',
          title: `MCP server "${m.server}" costs ${fmtTok(m.tokens)} tokens per request, never called`,
          detail: `${m.loaded} of its ${m.tools} tools are loaded in every request, and none was called in ${sessionsSince} recorded sessions. Disable it in /mcp, or scope it to the projects that need it.`,
          saves: m.tokens,
        })
      }
    }
  }

  // Skills listed but never run.
  if (bd && sessionsSince >= 5) {
    for (const s of bd.skills) {
      if (s.tokens < 60 || skills[s.name]) continue
      out.push({
        id: `skill-unused-${s.name}`, sev: 'low', area: 'Skills',
        title: `Skill "${s.name}" unused in ${sessionsSince} sessions`,
        detail: `Its listing costs ${fmtTok(s.tokens)} tokens on every request. Turn it off in your user settings if you don't need it.`,
        saves: s.tokens,
        action: { kind: 'skill-off', skill: s.name },
      })
    }
  }

  // Big memory files.
  for (const m of bd?.memory ?? []) {
    if (m.tokens >= 4000) {
      out.push({
        id: `mem-${m.path}`, sev: 'low', area: 'Context',
        title: `${m.path.split('/').slice(-2).join('/')} is ${fmtTok(m.tokens)} tokens`,
        detail: 'Memory files load into every request. Move rarely needed detail into a skill or a linked doc read on demand.',
        saves: Math.round(m.tokens / 2),
      })
    }
  }

  // Skills that go badly.
  for (const s of Object.values(skills)) {
    if (s.n < 3) continue
    const errRate = s.errors / s.n
    const abortRate = s.aborted / s.n
    if (errRate >= 1 || abortRate >= 0.3) {
      out.push({
        id: `skill-rough-${s.name}`, sev: 'med', area: 'Skills',
        title: `Skill "${s.name}" struggles: ${errRate.toFixed(1)} tool errors/run, ${Math.round(abortRate * 100)}% interrupted`,
        detail: 'Have Claude read the skill with its recent errors and propose a revision you can review and apply.',
        action: { kind: 'improve', skill: s.name },
      })
    }
    if (s.promptTok >= 5000) {
      out.push({
        id: `skill-big-${s.name}`, sev: 'low', area: 'Skills',
        title: `Skill "${s.name}" expands to ${fmtTok(s.promptTok)} tokens each run`,
        detail: 'Move reference detail into files the skill reads only when needed, and keep SKILL.md to the steps.',
        saves: Math.round(s.promptTok / 2),
        action: { kind: 'improve', skill: s.name },
      })
    }
  }

  // Tools that fail often.
  for (const [name, t] of Object.entries(saved.toolsAll)) {
    if (t.n >= 10 && t.err / t.n >= 0.2) {
      out.push({
        id: `tool-err-${name}`, sev: 'low', area: 'Tools',
        title: `${name} fails ${Math.round((t.err / t.n) * 100)}% of the time (${t.err}/${t.n})`,
        detail: 'Each failed call costs a round trip. A note in CLAUDE.md about the right invocation, or a permission rule, often fixes the repeat cause.',
      })
    }
  }

  // Spend trend.
  const day = (k: number) => dayKey(now - k * 86_400_000)
  const sumDays = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => saved.costDays[day(from + i)] ?? 0).reduce((a, v) => a + v, 0)
  const thisWeek = sumDays(0, 7)
  const lastWeek = sumDays(7, 14)
  if (lastWeek > 1 && thisWeek > lastWeek * 1.5) {
    out.push({
      id: `trend-${day(0)}`, sev: 'low', area: 'Cost',
      title: `Spend up ${Math.round((thisWeek / lastWeek - 1) * 100)}% on last week (${fmtUsd(thisWeek)} vs ${fmtUsd(lastWeek)})`,
      detail: 'See the Sessions tab for which sessions drove it.',
      action: { kind: 'tab', tab: 'sessions' },
    })
  }

  const rank = { high: 0, med: 1, low: 2 }
  return out.sort((a, z) => rank[a.sev] - rank[z.sev] || (z.saves ?? 0) - (a.saves ?? 0))
}

// ---------------------------------------------------------------- optimize: actions

const homeDir = ($: $T) => $.plugin.root.split('/.claude/')[0] ?? ''

const isEditable = (path: string) => !/\/\.claude\/plugins\/(cache|marketplaces)\//.test(path)

const turnSkillOff = async ($: $T, skill: string) => {
  const file = `${homeDir($)}/.claude/settings.json`
  const pick = await $.ui
    .ask(`Turn off skill "${skill}" in ${file.replace(homeDir($), '~')} (skillOverrides, after a backup)?`, ['Turn off', 'Cancel'])
    .catch(() => 'Cancel')
  if (pick !== 'Turn off') return
  try {
    const text = await $.fs.read(file)
    const json = JSON.parse(text) as { skillOverrides?: Record<string, string> }
    await $.fs.write(`${file}.bak-usage-dashboard`, text)
    json.skillOverrides = { ...(json.skillOverrides ?? {}), [skill]: 'off' }
    await $.fs.write(file, JSON.stringify(json, null, 2) + '\n')
    $.ui.toast(`Skill "${skill}" turned off for new sessions`)
  } catch (err) {
    $.ui.toast(`Could not update settings: ${String(err).slice(0, 100)}`)
  }
}

const IMPROVE_SYSTEM = `You improve Claude Code skills. A skill is a SKILL.md file: YAML frontmatter (name, description, ...) then instructions Claude follows when the skill runs. The description decides when the skill triggers; the body is read in full each run, so every token there is paid on every run.

Revise the skill to fix the problems the usage data shows and to make it cheaper to run, without changing what it is for:
- Keep the frontmatter keys; tighten the description only if triggering looks wrong.
- Fix instructions that plausibly cause the recorded tool errors or interruptions.
- Cut repetition and reference detail that is not needed on every run.
- Keep the author's voice and any paths, commands and names exactly as written unless they are the cause of an error.
If the skill is already good, return it unchanged and say so.

Answer with one JSON object inside <json></json> tags and nothing else:
{"summary": "<two sentences>", "changes": ["<one line per change>"], "content": "<the full new SKILL.md>"}`

const improveSkill = async ($: $T, name: string) => {
  const s = (await read($, skillsA))[name]
  if (!s?.path) {
    $.ui.toast(`No file recorded for "${name}" yet: run the skill once first`)
    return
  }
  if (!isEditable(s.path)) {
    $.ui.toast(`"${name}" is an installed plugin copy; edit its source instead`)
    return
  }
  await update($, optBusyA, () => `reviewing ${name} with Claude…`)
  try {
    const original = await $.fs.read(s.path)
    const stats = {
      runs: s.n,
      avgPromptTokens: s.promptTok,
      avgTurnTokens: Math.round(s.turnTok / Math.max(1, s.n)),
      avgTurnSeconds: Math.round(s.ms / Math.max(1, s.n) / 1000),
      toolErrorsPerRun: +(s.errors / Math.max(1, s.n)).toFixed(2),
      interruptedRuns: s.aborted,
      recentErrors: s.errSamples,
    }
    const r = await $.model.complete({
      model: 'opus',
      system: IMPROVE_SYSTEM,
      prompt: `Skill: ${name}\nPath: ${s.path}\n\nUsage data:\n${JSON.stringify(stats, null, 2)}\n\nCurrent SKILL.md:\n<skill>\n${original}\n</skill>`,
      maxTokens: 16_000,
      timeoutMs: 240_000,
    })
    if (!r.isAnswered) {
      $.ui.toast(`Review failed: ${r.reason}`)
      return
    }
    const m = /<json>([\s\S]*)<\/json>/.exec(r.text)
    const parsed = JSON.parse(m?.[1] ?? r.text) as { summary?: string; changes?: string[]; content?: string }
    if (!parsed.content) throw new Error('no content in reply')
    const proposal: Proposal = {
      skill: name,
      path: s.path,
      summary: parsed.summary ?? '',
      changes: parsed.changes ?? [],
      original,
      content: parsed.content.endsWith('\n') ? parsed.content : parsed.content + '\n',
      model: 'opus',
      at: await $.clock.now(),
      outTok: r.usage.output_tokens,
    }
    await update($, proposalA, () => proposal)
    await $.store.set('proposal', proposal)
    await update($, tabA, () => 'optimize')
  } catch (err) {
    $.ui.toast(`Review failed: ${String(err).slice(0, 120)}`)
  } finally {
    await update($, optBusyA, () => '')
  }
}

const applyProposal = async ($: $T) => {
  const p = await read($, proposalA)
  if (!p) return
  const pick = await $.ui
    .ask(`Write the revised SKILL.md for "${p.skill}", keeping the current file as a .bak copy?`, ['Apply', 'Cancel'])
    .catch(() => 'Cancel')
  if (pick !== 'Apply') return
  try {
    const current = await $.fs.read(p.path)
    if (current !== p.original) {
      $.ui.toast('The skill changed since the review; run the review again')
      return
    }
    await $.fs.write(`${p.path}.bak-${dayKey(await $.clock.now())}-${Date.now() % 100000}`, current)
    await $.fs.write(p.path, p.content)
    await discardProposal($)
    $.ui.toast(`Updated ${p.skill}: new sessions use the revised skill`)
  } catch (err) {
    $.ui.toast(`Could not write: ${String(err).slice(0, 120)}`)
  }
}

const discardProposal = async ($: $T) => {
  await update($, proposalA, () => null)
  await $.store.delete('proposal')
}

const REVIEW_SYSTEM = `You are reviewing one person's Claude Code usage to cut cost and improve results. You get aggregated numbers only. Give the five changes with the biggest expected effect, most valuable first, each as a short markdown bullet: what to change, why (cite the numbers), and the expected effect. Be concrete about Claude Code features (subagent model choice, /compact, skills, MCP scoping, CLAUDE.md size, prompt caching). No preamble, under 250 words.`

const usageReview = async ($: $T, findings: Finding[]) => {
  await update($, optBusyA, () => 'asking Claude for a usage review…')
  try {
    const saved = await read($, savedA)
    const skills = await read($, skillsA)
    const snap = await read($, snapA)
    const now = await $.clock.now()
    const recent = [...saved.sessions].sort((a, z) => z.lastAt - a.lastAt).slice(0, 25)
    const byModel: Record<string, number> = {}
    for (const s of saved.sessions) for (const [m, t] of Object.entries(s.models)) byModel[m] = (byModel[m] ?? 0) + sumTok(t)
    const data = {
      costLast14Days: Array.from({ length: 14 }, (_, i) => {
        const d = dayKey(now - (13 - i) * 86_400_000)
        return [d, +(saved.costDays[d] ?? 0).toFixed(2)]
      }),
      sessions: recent.map(s => ({
        project: s.cwd.replace(homeDir($), '~'), usd: +s.usd.toFixed(2), turns: s.turns, subagentTurns: s.sub,
        tokens: sumTok(s.tok), cacheReadShare: +(s.tok.cr / Math.max(1, s.tok.in + s.tok.cr + s.tok.cw)).toFixed(2), peakCtxPct: s.peakCtx,
        minutes: Math.round((s.lastAt - s.startedAt) / 60000),
      })),
      tokensByModel: byModel,
      context: snap?.bd
        ? { window: snap.bd.max, categories: snap.bd.categories.map(c => [c.name, c.tokens]), mcp: snap.bd.mcp.map(m => [m.server, m.tokens]), skillListingTokens: snap.bd.skillTotal?.tokens }
        : undefined,
      skills: Object.values(skills).map(s => ({ name: s.name, runs: s.n, promptTok: s.promptTok, avgTurnTok: Math.round(s.turnTok / Math.max(1, s.n)), errorsPerRun: +(s.errors / Math.max(1, s.n)).toFixed(2), interrupted: s.aborted })),
      tools: Object.entries(saved.toolsAll).sort((a, z) => z[1].n - a[1].n).slice(0, 15).map(([n, t]) => [n, t.n, t.err]),
      rateLimits: snap?.rate,
      ruleFindings: findings.map(f => f.title),
    }
    const r = await $.model.complete({
      model: 'sonnet',
      system: REVIEW_SYSTEM,
      prompt: `Usage data (JSON):\n${JSON.stringify(data)}`,
      maxTokens: 2000,
      timeoutMs: 120_000,
    })
    if (!r.isAnswered) {
      $.ui.toast(`Review failed: ${r.reason}`)
      return
    }
    const review: Review = { text: r.text.trim(), at: now, model: 'sonnet' }
    await update($, reviewA, () => review)
    await $.store.set('review', review)
  } catch (err) {
    $.ui.toast(`Review failed: ${String(err).slice(0, 120)}`)
  } finally {
    await update($, optBusyA, () => '')
  }
}

// A unified diff of two texts, by longest common subsequence of lines.
const unifiedDiff = (a: string, b: string, context = 2): string => {
  const x = a.split('\n')
  const y = b.split('\n')
  const n = x.length
  const m = y.length
  if (n * m > 4_000_000) return `--- before (${n} lines)\n+++ after (${m} lines)\n@@ too large to diff here @@`
  const L: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i]![j] = x[i] === y[j] ? L[i + 1]![j + 1]! + 1 : Math.max(L[i + 1]![j]!, L[i]![j + 1]!)
  const ops: { t: ' ' | '-' | '+'; s: string }[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (x[i] === y[j]) ops.push({ t: ' ', s: x[i++]! }), j++
    else if (L[i + 1]![j]! >= L[i]![j + 1]!) ops.push({ t: '-', s: x[i++]! })
    else ops.push({ t: '+', s: y[j++]! })
  }
  while (i < n) ops.push({ t: '-', s: x[i++]! })
  while (j < m) ops.push({ t: '+', s: y[j++]! })
  const keep = ops.map((o, k) => o.t !== ' ' || ops.slice(Math.max(0, k - context), k + context + 1).some(p => p.t !== ' '))
  const lines: string[] = ['--- SKILL.md', '+++ SKILL.md (proposed)']
  let gap = false
  ops.forEach((o, k) => {
    if (keep[k]) {
      if (gap) lines.push('@@ … @@')
      gap = false
      lines.push(o.t + o.s)
    } else gap = true
  })
  return lines.join('\n')
}

// ---------------------------------------------------------------- optimize: drawing

const SEV: Record<Finding['sev'], { glyph: string; color: Color; label: string }> = {
  high: { glyph: '●', color: 'error', label: 'high' },
  med: { glyph: '●', color: 'warning', label: 'medium' },
  low: { glyph: '●', color: 'suggestion', label: 'low' },
}

const drawOptimize = async ($: $T, ui: UI, W: number, now: number) => {
  const { Box, Text, Button, Select, Markdown, Code } = ui
  const snap = await read($, snapA)
  const saved = await read($, savedA)
  const skills = await read($, skillsA)
  const since = await read($, skillsSinceA)
  const turns = await read($, turnsA)
  const tools = await read($, toolsA)
  const dismissed = await read($, dismissedA)
  const proposal = await read($, proposalA)
  const review = await read($, reviewA)
  const busy = await read($, optBusyA)
  const pickRaw = await read($, skillPickA)

  const all = computeFindings(snap, saved, skills, since, turns, tools, now)
  const findings = all.filter(f => !dismissed.includes(f.id))
  const saves = findings.reduce((a, f) => a + (f.saves ?? 0), 0)
  const counts = { high: 0, med: 0, low: 0 }
  for (const f of findings) counts[f.sev] += 1

  const actionButton = (f: Finding) => {
    const a = f.action
    if (!a) return null
    const label = a.kind === 'compact' ? 'Compact now' : a.kind === 'skill-off' ? 'Turn skill off' : a.kind === 'improve' ? 'Improve with Claude' : `Open ${a.tab}`
    return (
      <Button
        key={`opt-act-${f.id}`}
        label={label}
        plain
        onPress={async () => {
          if (a.kind === 'compact') {
            const pick = await $.ui.ask('Compact the conversation now?', ['Compact', 'Cancel']).catch(() => 'Cancel')
            if (pick === 'Compact') await $.session.compact()
          } else if (a.kind === 'skill-off') await turnSkillOff($, a.skill)
          else if (a.kind === 'improve') await improveSkill($, a.skill)
          else await update($, tabA, () => a.tab)
        }}
      />
    )
  }

  const findingRows = findings.slice(0, 12).map(f => (
    <Box flexDirection="column">
      {Line(ui, [
        ...cells(`${SEV[f.sev].glyph} `, SEV[f.sev].color),
        ...cells(pad(f.area, 9), undefined, true),
        ...cells(f.title, undefined, false, true),
        ...cells(f.saves ? `  ~${fmtTok(f.saves)} tok` : '', C.ok, true),
      ])}
      <Box flexDirection="row" marginLeft={11}>
        <Text dimColor wrap="wrap">
          {f.detail}
        </Text>
      </Box>
      <Box flexDirection="row" marginLeft={11} gap={2}>
        {actionButton(f)}
        <Button
          key={`opt-x-${f.id}`}
          label="Dismiss"
          plain
          dimColor
          onPress={async () => {
            const next = [...(await read($, dismissedA)), f.id]
            await update($, dismissedA, () => next)
            await $.store.set('dismissed', next)
          }}
        />
      </Box>
    </Box>
  ))

  // Skills table.
  const list = Object.values(skills).sort((a, z) => z.n - a.n)
  const pick = pickRaw && skills[pickRaw] ? pickRaw : list.find(s => s.path && isEditable(s.path))?.name ?? ''
  const nameW = Math.min(30, Math.max(8, ...list.map(s => s.name.length)) + 1)
  const skillHead = `${pad('skill', nameW)}${lpad('runs', 5)}${lpad('prompt', 8)}${lpad('turn tok', 10)}${lpad('avg time', 9)}${lpad('err/run', 8)}${lpad('stopped', 8)}  last`

  const sinceDays = since ? Math.max(0, Math.floor((now - since) / 86_400_000)) : 0

  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="row" flexWrap="wrap" gap={3}>
        <Text bold>Findings</Text>
        {Line(ui, [
          ...cells(`${counts.high} high `, 'error'),
          ...cells(`${counts.med} medium `, 'warning'),
          ...cells(`${counts.low} low`, 'suggestion'),
          ...cells(saves ? `   ~${fmtTok(saves)} tokens/request to win back` : '', C.ok),
        ])}
        {dismissed.length > 0 && (
          <Button
            key="opt-restore"
            label={`Restore ${dismissed.length} dismissed`}
            plain
            dimColor
            onPress={async () => {
              await update($, dismissedA, () => [])
              await $.store.set('dismissed', [])
            }}
          />
        )}
      </Box>
      {findingRows.length ? findingRows : <Text dimColor>No findings right now. They come from this session's context breakdown and the data saved across sessions, so more appear as data builds up.</Text>}

      <Box flexDirection="column">
        <Text bold>
          Skills <Text dimColor>· tracked {sinceDays ? `for ${sinceDays}d` : 'from today'} · each run is charged the turn it ran in</Text>
        </Text>
        {list.length === 0 ? (
          <Text dimColor>No skill runs recorded yet.</Text>
        ) : (
          <Box flexDirection="column">
            <Text bold wrap="truncate">
              {skillHead}
            </Text>
            {list.slice(0, 12).map(s => {
              const errRate = s.errors / Math.max(1, s.n)
              return Line(ui, [
                ...cells(pad(s.name, nameW), s.name === pick ? C.accent : undefined, false, s.name === pick),
                ...cells(lpad(String(s.n), 5)),
                ...cells(lpad(fmtTok(s.promptTok), 8), s.promptTok >= 5000 ? C.warn : undefined, true),
                ...cells(lpad(fmtTok(s.turnTok / Math.max(1, s.n)), 10), undefined, true),
                ...cells(lpad(fmtDur(s.ms / Math.max(1, s.n)), 9), undefined, true),
                ...cells(lpad(errRate.toFixed(1), 8), errRate >= 1 ? C.bad : undefined),
                ...cells(lpad(String(s.aborted), 8), s.aborted ? C.warn : undefined),
                ...cells(`  ${fmtDur(now - s.lastAt)} ago`, undefined, true),
                ...cells(s.path && !isEditable(s.path) ? '  (plugin copy)' : '', undefined, true),
              ])
            })}
          </Box>
        )}
        {list.length > 0 && (
          <Box flexDirection="row" gap={2} marginTop={1}>
            <Select
              key="opt-skill"
              label="Skill"
              value={pick}
              options={list.map(s => ({ value: s.name, label: s.name }))}
              onSelect={v => update($, skillPickA, () => v)}
            />
            <Button key="opt-improve" label="Improve with Claude" hotkey="i" plain onPress={() => improveSkill($, pick)} />
          </Box>
        )}
      </Box>

      {proposal && (
        <Box flexDirection="column" borderStyle="round" borderColor={C.accent} paddingX={1}>
          <Text bold>
            Proposed revision · {proposal.skill}
            <Text dimColor>
              {'  '}
              {fmtTok(proposal.original.length / 4)} → {fmtTok(proposal.content.length / 4)} tokens · {fmtDur(now - proposal.at)} ago
            </Text>
          </Text>
          <Text>{proposal.summary}</Text>
          {proposal.changes.map(c => (
            <Text dimColor>• {c}</Text>
          ))}
          <Code source={unifiedDiff(proposal.original, proposal.content)} format="diff" language="markdown" path={proposal.path} />
          <Box flexDirection="row" gap={2}>
            <Button key="opt-apply" label="Apply" hotkey="y" variant="primary" onPress={() => applyProposal($)} />
            <Button key="opt-discard" label="Discard" hotkey="n" plain dimColor onPress={() => discardProposal($)} />
          </Box>
        </Box>
      )}

      <Box flexDirection="column">
        <Box flexDirection="row" gap={2}>
          <Text bold>Claude's usage review</Text>
          <Button key="opt-review" label={review ? 'Run again' : 'Run review'} hotkey="v" plain onPress={() => usageReview($, all)} />
          <Text dimColor>sends aggregated numbers only, on Sonnet</Text>
        </Box>
        {review ? (
          <Box flexDirection="column">
            <Markdown text={review.text} />
            <Text dimColor>{fmtDur(now - review.at)} ago</Text>
          </Box>
        ) : (
          <Text dimColor>Not run yet.</Text>
        )}
      </Box>
      {busy && <Text color={C.accent}>{busy}</Text>}
    </Box>
  )
}

// ---------------------------------------------------------------- history

const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

const drawHistory = async ($: $T, ui: UI, W: number, now: number) => {
  const { Box, Text, Button, Select } = ui
  const hist = await read($, histA)
  const range = await read($, rangeA)
  const metric = await read($, metricA)
  const scanState = await read($, scanA)

  const controls = (
    <Box flexDirection="row" gap={2} flexWrap="wrap">
      <Select
        key="range"
        label="Range"
        value={String(range)}
        options={[7, 14, 30, 90].map(d => ({ value: String(d), label: `${d} days` }))}
        onSelect={async v => {
          await update($, rangeA, () => Number(v))
          await sync($)
        }}
      />
      <Select
        key="metric"
        label="Metric"
        value={metric}
        options={[
          { value: 'total', label: 'All tokens' },
          { value: 'output', label: 'Output tokens' },
          { value: 'requests', label: 'API requests' },
        ]}
        onSelect={v => update($, metricA, () => v as HistMetric)}
      />
      <Button key="scan" label={scanState === 'scanning' ? 'Syncing…' : 'Sync'} hotkey="s" plain onPress={() => sync($, { backfill: true })} />
    </Box>
  )

  if (!hist) {
    return (
      <Box flexDirection="column" gap={1}>
        {controls}
        <Text dimColor>
          History reads the central events folder (~/.claude/usage-events). Press s to sync it, rebuilding sessions that ran without the mod from their transcripts.
        </Text>
        {scanState && scanState !== 'scanning' && <Text color={C.bad}>{scanState}</Text>}
      </Box>
    )
  }

  const days = hist.days
  const segsOf = (d: HistDay) =>
    metric === 'output'
      ? [{ v: d.out, color: C.out as Color }]
      : metric === 'requests'
        ? [{ v: d.n, color: C.accent as Color }]
        : [
            { v: d.in, color: C.in as Color },
            { v: d.cr, color: C.cr as Color },
            { v: d.cw, color: C.cw as Color },
            { v: d.out, color: C.out as Color },
          ]
  const axisW = 7
  const room = W - axisW - 1
  const colW = Math.max(1, Math.min(4, Math.floor(room / days.length) - 1))
  const gap = Math.floor(room / days.length) > 1 ? 1 : 0
  const fmtAxis = metric === 'requests' ? (n: number) => String(Math.round(n)) : fmtTok
  const chart = columns(ui, days.map(d => ({ segs: segsOf(d) })), 10, colW, gap, axisW, fmtAxis)
  const span = days.length * colW + (days.length - 1) * gap
  const firstLbl = days[0]?.date.slice(5) ?? ''
  const lastLbl = days[days.length - 1]?.date.slice(5) ?? ''
  const xAxis = ' '.repeat(axisW + 1) + firstLbl + ' '.repeat(Math.max(1, span - firstLbl.length - lastLbl.length)) + lastLbl

  const totals = days.reduce((a, d) => ({ in: a.in + d.in, out: a.out + d.out, cr: a.cr + d.cr, cw: a.cw + d.cw, n: a.n + d.n }), {
    in: 0, out: 0, cr: 0, cw: 0, n: 0,
  })
  const active = days.filter(d => d.n > 0)
  const peak = days.reduce((a, d) => (sumTok(d) > sumTok(a) ? d : a), days[0]!)
  const allIn = totals.in + totals.cr + totals.cw

  // Heatmap: weekday by hour.
  const heatMax = Math.max(...hist.heat.flat(), 1)
  const cellW = W >= 4 + 24 * 3 ? 3 : W >= 4 + 24 * 2 ? 2 : 1
  const heatRows = hist.heat.map((row, d) =>
    Line(ui, [
      ...cells(DOW[d]! + ' ', undefined, true),
      ...row.flatMap(v => {
        const lvl = v === 0 ? 0 : Math.min(4, 1 + Math.floor((v / heatMax) * 3.999))
        return cells(SHADES[lvl]!.repeat(cellW), lvl === 0 ? C.dim : C.accent, lvl === 0)
      }),
    ]),
  )
  const hourAxis = '    ' + Array.from({ length: 24 }, (_, h) => (h % 6 === 0 ? String(h).padEnd(cellW * 6) : '')).join('')

  const groupRows = (list: HistGroup[], n: number, color: (i: number) => Color, label = (s: string) => s) => {
    const sorted = [...list].sort((a, z) => sumTok(z) - sumTok(a)).slice(0, n)
    const max = Math.max(...sorted.map(sumTok), 1)
    const nameW = Math.min(26, Math.max(8, ...sorted.map(g => label(g.name).length)) + 1)
    return sorted.map((g, i) =>
      Line(ui, [
        ...cells(pad(label(g.name), nameW), undefined, true),
        ...cells(hbar(sumTok(g) / max, Math.max(8, W - nameW - 30)), color(i)),
        ...cells(` ${lpad(fmtTok(sumTok(g)), 7)}  ${lpad(fmtTok(g.out), 6)} out  ${g.n} req`, undefined, true),
      ]),
    )
  }

  const subShare = hist.main + hist.sub > 0 ? hist.sub / (hist.main + hist.sub) : 0

  return (
    <Box flexDirection="column" gap={1}>
      {controls}
      <Box flexDirection="row" flexWrap="wrap" gap={3}>
        <Text>
          <Text dimColor>total </Text>
          <Text bold>{fmtTok(sumTok(totals))}</Text>
        </Text>
        <Text>
          <Text dimColor>output </Text>
          <Text bold color={C.out}>{fmtTok(totals.out)}</Text>
        </Text>
        <Text>
          <Text dimColor>requests </Text>
          <Text bold>{totals.n}</Text>
        </Text>
        <Text>
          <Text dimColor>active days </Text>
          <Text bold>
            {active.length}/{days.length}
          </Text>
        </Text>
        <Text>
          <Text dimColor>cache hit </Text>
          <Text bold color={C.ok}>{allIn ? Math.round((totals.cr / allIn) * 100) : 0}%</Text>
        </Text>
        <Text>
          <Text dimColor>peak </Text>
          <Text bold>{peak?.date.slice(5)}</Text>
          <Text dimColor> {fmtTok(peak ? sumTok(peak) : 0)}</Text>
        </Text>
      </Box>
      <Box flexDirection="column">
        {chart}
        <Text dimColor wrap="truncate">
          {xAxis}
        </Text>
        {metric === 'total' &&
          Legend(ui, [
            { label: 'input', color: C.in },
            { label: 'cache read', color: C.cr },
            { label: 'cache write', color: C.cw },
            { label: 'output', color: C.out },
          ])}
      </Box>
      <Box flexDirection="column">
        <Text bold>When you work · API requests by weekday and hour</Text>
        {heatRows}
        <Text dimColor>{hourAxis}</Text>
      </Box>
      <Box flexDirection="column">
        <Text bold>Models</Text>
        {groupRows(hist.models, 6, i => modelColor([...hist.models].sort((a, z) => sumTok(z) - sumTok(a))[i]?.name ?? ''), shortModel)}
      </Box>
      <Box flexDirection="column">
        <Text bold>Projects</Text>
        {groupRows(hist.projects, 8, () => C.accent)}
      </Box>
      <Box flexDirection="column">
        <Text bold>Main loop vs subagents</Text>
        {Line(ui, stackBar([{ v: hist.main, color: C.accent }, { v: hist.sub, color: 'ide' }], W))}
        {Legend(ui, [
          { label: `main ${fmtTok(hist.main)}`, color: C.accent },
          { label: `subagents ${fmtTok(hist.sub)} (${Math.round(subShare * 100)}%)`, color: 'ide' },
        ])}
      </Box>
      <Text dimColor>
        {hist.files} session files · last {hist.rangeDays} days · synced {fmtDur(now - hist.scannedAt)} ago
        {scanState === 'scanning' ? ' · syncing…' : scanState ? ` · ${scanState}` : ''}
      </Text>
    </Box>
  )
}
