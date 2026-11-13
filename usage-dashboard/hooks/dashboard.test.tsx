import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const PANE = {
  plugin: 'usage-dashboard',
  component: 'Pane',
  requestId: 'usage-dashboard',
  props: {
    title: 'Usage',
    isFocused: true,
    bodyColumns: 120,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 60 },
    view: {},
  },
} as const

const turn = (i: number, agent = 'main') => ({
  id: `t${i}`, at: 1_700_000_000_000 + i * 60_000, ms: 4000 + i * 900, model: 'claude-opus-5-5', agent,
  tools: i % 4, reason: i === 3 ? 'aborted' : 'answer', in: 20 + i, out: 400 * i, cr: 30_000 + i * 2000, cw: 1500 * i, ctxPct: 10 + i * 3,
})

const grid = Array.from({ length: 10 }, (_, r) =>
  Array.from({ length: 10 }, (_, c) => {
    const n = r * 10 + c
    const name = n < 8 ? 'System prompt' : n < 20 ? 'Messages' : n < 90 ? 'Free space' : 'Autocompact buffer'
    return { color: n < 8 ? 'promptBorder' : n < 20 ? 'claude' : 'inactive', filled: n < 20, full: 1, name }
  }),
)

const SEED: Record<string, unknown> = {
  turns: { shape: 'turns-1', value: [turn(1), turn(2), turn(3), { ...turn(4, 'agent-abc123'), model: 'claude-haiku-5-5' }, turn(5)] },
  tools: { shape: 'tools-1', value: { Bash: { n: 12, err: 2, ms: 9000, denied: 1 }, Read: { n: 30, err: 0, ms: 1200, denied: 0 } } },
  snap: {
    shape: 'snap-1',
    value: {
      at: 1_700_000_300_000, startedAt: 1_700_000_000_000, ctxTokens: 42_000, ctxWindow: 200_000, ctxPct: 21,
      rate: [{ kind: 'five_hour', pct: 23.5, resetsAt: '2023-11-14T23:00:00Z' }, { kind: 'seven_day', pct: 61 }],
      usd: 1.234,
      bd: {
        detail: 'summary', model: 'claude-opus-5-5', total: 42_000, max: 200_000, pct: 21, source: 'auto', autoCompactAt: 180_000,
        categories: [
          { name: 'System prompt', tokens: 16_000, color: 'promptBorder', kind: 'used' },
          { name: 'Messages', tokens: 26_000, color: 'claude', kind: 'used' },
          { name: 'Free space', tokens: 138_000, color: 'inactive', kind: 'free' },
          { name: 'Autocompact buffer', tokens: 20_000, color: 'inactive', kind: 'buffer' },
          { name: 'MCP tools (deferred)', tokens: 9000, color: 'inactive', kind: 'deferred' },
        ],
        grid,
        memory: [{ path: '/home/x/.claude/CLAUDE.md', type: 'User', tokens: 900 }],
        mcp: [{ server: 'easel', tokens: 1200, tools: 3, loaded: 1 }],
        skills: [{ name: 'dataviz', tokens: 300 }],
        skillTotal: { n: 30, included: 28, tokens: 4000 },
        agents: [{ name: 'Explore', tokens: 200 }],
      },
    },
  },
  history: {
    shape: 'hist-1',
    value: {
      scannedAt: 1_700_000_000_000, rangeDays: 7, files: 12,
      days: Array.from({ length: 7 }, (_, i) => ({ date: `2023-11-0${i + 1}`, in: 100 * i, out: 9000 * i, cr: 900_000 * i, cw: 40_000, n: 30 * i, sessions: i, models: { 'claude-opus-5-5': { tok: 900_000 * i, out: 8000 * i, n: 20 * i }, 'claude-haiku-5-5': { tok: 50_000 * i, out: 1000 * i, n: 10 * i } } })),
      models: [{ name: 'claude-opus-5-5', in: 1, out: 2, cr: 3, cw: 4, n: 5 }],
      projects: [{ name: '~/proj', in: 1, out: 2, cr: 3, cw: 4, n: 5 }],
      heat: Array.from({ length: 7 }, (_, d) => Array.from({ length: 24 }, (_, h) => (d * h) % 9)),
      main: 1000, sub: 500,
    },
  },
}

const TABS = [
  ['1', /Cost/],
  ['2', /System prompt/],
  ['3', /Tokens per turn/],
  ['4', /Tool calls/],
  ['5', /When you work/],
  ['6', /History by model/],
] as const

test('each tab draws its own content, on terminal and desktop', async ($, on) => {
  const seeded: Record<string, unknown> = { ...SEED }
  on('state.get', (_, e) => {
    const k = (e as { key: string }).key
    return { value: k in seeded ? { value: seeded[k], version: 1 } : { value: undefined, version: 0 } }
  })
  on('clock.now', () => ({ value: 1_700_000_400_000 }))

  for (const [hotkey, marker] of TABS) {
    seeded.tab = { '1': 'overview', '2': 'context', '3': 'turns', '4': 'tools', '5': 'history', '6': 'models' }[hotkey]
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ ...PANE, surface })
      expect((await ui.find({ type: 'Text', text: marker }))?.text).toMatch(marker)
      await ui.unmount()
    }
  }
})

test('the empty state draws on every surface', async ($, on) => {
  on('clock.now', () => ({ value: 1_700_000_400_000 }))
  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /waiting for first reading/ })).toBeDefined()
    await ui.press({ key: 'tab-history' })
    expect(await ui.find({ type: 'Text', text: /Press s to sync/ })).toBeDefined()
    await ui.press({ key: 'tab-overview' })
    await ui.unmount()
  }
})

test('the models tab splits the session and history by model', async ($, on) => {
  on('state.get', (_, e) => {
    const k = (e as { key: string }).key
    const v = k === 'tab' ? 'models' : SEED[k]
    return { value: v === undefined ? { value: undefined, version: 0 } : { value: v, version: 1 } }
  })
  on('clock.now', () => ({ value: 1_700_000_400_000 }))
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /haiku-5-5/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /opus-5-5/ })).toBeDefined()
    await ui.unmount()
  }
})

// Stands in for scripts/events.py: records each emitted event, answers backfill and aggregate.
const stubEvents = (on: On, emitted: Record<string, unknown>[], agg: Record<string, unknown>) =>
  on('process.run', (_, e) => {
    const { argv, init } = e as { argv: string[]; init?: { stdin?: string } }
    const cmd = argv[3]
    if (cmd === 'emit') emitted.push(JSON.parse(init?.stdin ?? '{}') as Record<string, unknown>)
    const stdout = cmd === 'aggregate' ? JSON.stringify(agg) : cmd === 'backfill' ? '{"written":0,"skipped":0}' : ''
    return { value: { exitCode: 0, stdout, stderr: '' } } as never
  })

const AGG = {
  eventsDir: '/home/x/.claude/usage-events',
  history: (SEED.history as { value: Record<string, unknown> }).value,
  sessions: [
    { id: 'sess-1', cwd: '/home/x/proj', startedAt: 1_700_000_000_000, lastAt: 1_700_000_300_000, usd: 0.75, turns: 3, sub: 1, reqs: 0,
      tok: { in: 1, out: 2, cr: 3, cw: 4 }, models: { 'claude-opus-5-5': { in: 1, out: 2, cr: 3, cw: 4, turns: 3 } }, tools: 2, peakCtx: 15, peakTok: 30_000, src: 'live' },
    { id: 'old-bf', cwd: '/home/x/infra', startedAt: 1_699_000_000_000, lastAt: 1_699_000_900_000, usd: 0, turns: 40, sub: 200, reqs: 900,
      tok: { in: 10, out: 20, cr: 300_000_000, cw: 40 }, models: { 'claude-opus-5-5': { in: 10, out: 20, cr: 300_000_000, cw: 40, turns: 900 } }, tools: 0, peakCtx: 0, peakTok: 410_000, src: 'backfill' },
  ],
  costDays: { '2023-11-14': 0.75 },
  toolsAll: { Bash: { n: 3, err: 0, ms: 90, denied: 0 } },
  skillsAll: {},
  since: 1_699_000_000_000,
}

test('turns go to the events folder; the all-time tabs read the aggregate', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on, {})
  const emitted: Record<string, unknown>[] = []
  stubEvents(on, emitted, AGG)
  on('session.id', () => ({ value: 'sess-1' }))
  on('session.usage', () => ({
    value: { startedAt: clock.now(), context: { window: 200_000, tokens: 30_000, percent: 15 }, rateLimits: [], cost: { usd: 0.75 } },
  }))
  on('command.register', () => ({ value: { command: 'usage-dash' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.call', () => ({ result: {} }))
  on('turn.complete', (_, e) => ({ text: e.answer }))

  await $.session.start({ cwd: '/home/x/proj', surface: 'terminal', isInteractive: true })
  await clock.settle()
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  await $.turn.complete({
    turnId: 't1', answer: 'ok', durationMs: 5000, isAborted: false, reason: 'answer',
    usage: { model: 'claude-opus-5-5', input_tokens: 10, output_tokens: 500, cache_read_input_tokens: 20_000, cache_creation_input_tokens: 3000 },
  })
  await clock.settle()

  expect(emitted[0]?.t).toBe('start')
  expect(emitted[0]?.cwd).toBe('/home/x/proj')
  const turn = emitted.find(ev => ev.t === 'turn')!
  expect(turn.sid).toBe('sess-1')
  expect(turn.out).toBe(500)
  expect(turn.usd).toBe(0.75)
  expect((turn.toolStats as Record<string, { n: number }>).Bash?.n).toBe(1)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'tab-sessions' })
    expect(await ui.find({ type: 'Text', text: /Cost per day/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /infra/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /410k/ })).toBeDefined()
    await ui.press({ key: 'tab-overview' })
    await ui.unmount()
  }
})

const SKILL = {
  name: 'deploy', path: '/home/x/.claude/skills/deploy/SKILL.md', source: 'userSettings', n: 4, promptTok: 6200,
  turnTok: 400_000, out: 9000, ms: 240_000, errors: 6, aborted: 2, lastAt: 1_700_000_000_000, errSamples: ['Bash: exit 1 no such host'],
}

test('optimize tab: findings, skills table and a proposal diff', async ($, on) => {
  const snap = { ...(SEED.snap as { value: Record<string, unknown> }).value, ctxPct: 86 }
  const seeded: Record<string, unknown> = {
    ...SEED,
    tab: 'optimize',
    snap: { shape: 'snap-1', value: snap },
    skillsAll: { shape: 'skills-1', value: { deploy: SKILL } },
    skillsSince: 1_600_000_000_000,
    proposal: {
      shape: 'proposal-1',
      value: { skill: 'deploy', path: SKILL.path, summary: 'Tighter steps.', changes: ['Fix host name'], original: 'a\nold line\nc\n', content: 'a\nnew line\nc\n', model: 'opus', at: 1_700_000_000_000, outTok: 900 },
    },
  }
  on('state.get', (_, e) => {
    const k = (e as { key: string }).key
    return { value: k in seeded ? { value: seeded[k], version: 1 } : { value: undefined, version: 0 } }
  })
  on('clock.now', () => ({ value: 1_700_000_400_000 }))
  on('session.id', () => ({ value: 's1' }))
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /Context is 86% full/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /struggles/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Proposed revision/ })).toBeDefined()
    expect(await ui.find({ key: 'opt-apply' })).toBeDefined()
    await ui.unmount()
  }
})

test('improve with Claude, then apply: backup written, file replaced', async ($, on) => {
  const clock = mock.clock(on)
  const mem: Record<string, unknown> = {}
  stubEvents(on, [], { ...AGG, skillsAll: { deploy: SKILL } })
  const files: Record<string, string> = { [SKILL.path]: '---\nname: deploy\n---\nold steps\n' }
  on('store.get', (_, e) => ({ value: mem[(e as { key: string }).key] }))
  on('store.set', (_, e) => {
    const { key, value } = e as { key: string; value: unknown }
    mem[key] = JSON.parse(JSON.stringify(value))
    return { value: undefined }
  })
  on('store.delete', (_, e) => {
    delete mem[(e as { key: string }).key]
    return { value: undefined }
  })
  on('store.keys', () => ({ value: Object.keys(mem) }))
  on('fs.read', (_, e) => ({ value: files[(e as { path: string }).path] ?? '' }))
  on('fs.write', (_, e) => {
    const { path, text } = e as { path: string; text: string }
    files[path] = text
    return { value: undefined }
  })
  on('model.complete', () => ({
    value: {
      isAnswered: true,
      text: '<json>{"summary":"Clearer.","changes":["Rewrote steps"],"content":"---\\nname: deploy\\n---\\nnew steps\\n"}</json>',
      usage: { input_tokens: 1, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    },
  }))
  on('tool.call', { tool: 'AskUserQuestion' }, (_, e) => ({ result: { questions: [], answers: { [(e as { questions: { question: string }[] }).questions[0]!.question]: 'Apply' } } }) as never)
  on('session.id', () => ({ value: 's1' }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200_000 }, rateLimits: [] } }))
  on('command.register', () => ({ value: { command: 'usage-dash' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/home/x', surface: 'terminal', isInteractive: true })
  await clock.settle()

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'tab-optimize' })
  await ui.press({ key: 'opt-improve' })
  expect(await ui.find({ type: 'Text', text: /Proposed revision/ })).toBeDefined()
  await ui.press({ key: 'opt-apply' })
  expect(files[SKILL.path]).toContain('new steps')
  expect(Object.keys(files).some(k => k.includes('.bak-') && files[k]!.includes('old steps'))).toBe(true)
  expect(await ui.find({ type: 'Text', text: /Proposed revision/ })).toBeUndefined()
  await ui.unmount()
})
