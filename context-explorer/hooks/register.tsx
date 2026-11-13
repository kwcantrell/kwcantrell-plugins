import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { ContextItem, ExplorerView, Usage } from '../types'

const PANE = 'context-explorer'
const TITLE = 'Context explorer'

/** Each group's tab label, colour (a theme key) and hotkey. */
const GROUPS = [
  { name: 'Instruction files', short: 'Files', color: 'claude', hotkey: '1' },
  { name: 'Context blocks', short: 'Blocks', color: 'suggestion', hotkey: '2' },
  { name: 'System prompt', short: 'Prompt', color: 'permission', hotkey: '3' },
  { name: 'Skills', short: 'Skills', color: 'success', hotkey: '4' },
  { name: 'Skills invoked', short: 'Invoked', color: 'autoAccept', hotkey: '5' },
  { name: 'Tools', short: 'Tools', color: 'warning', hotkey: '6' },
] as const
/** Category colours for the bar, grid and legend (RGB). */
const PALETTE = [0xd97757, 0x5b9bd5, 0xb58bd6, 0x6bbf59, 0x4fb6b0, 0xe0b341, 0xe07a9b, 0x8a9bb0, 0xd9534f, 0xa3c45a]
const FREE_RGB = 0x5a5a5a
const BUFFER_RGB = 0x8a8a8a
const DEFAULT = 0x01000000
const SQUARE = 0x25a0 // ■
const HOLLOW = 0x25a1 // □
const DOT = 0x00b7 // ·
const BUFFER_GLYPH = 0x2592 // ▒
const SPACE = 0x20
const colorOf = (group: string) => GROUPS.find(g => g.name === group)?.color ?? 'text'

// Tags changed with v0.2: items gained `tokens`, the view gained tabs.
const snapshot = atom({ plugin: 'context-explorer', key: 'snapshot' } as const, [], {
  shape: 'items-2',
})
const captured = atom({ plugin: 'context-explorer', key: 'captured' } as const, [], {
  shape: 'items-2',
})
const skillBodies = atom({ plugin: 'context-explorer', key: 'skillBodies' } as const, [], {
  shape: 'items-2',
})
const view = atom(
  { plugin: 'context-explorer', key: 'view' } as const,
  { tab: 'Instruction files', selected: null, filter: '', sort: 'size', isRaw: false } as ExplorerView,
  { shape: 'view-2' },
)
const usage = atom(
  { plugin: 'context-explorer', key: 'usage' } as const,
  { total: 0, max: 0, slices: [] } as Usage,
  { shape: 'usage-1' },
)
const isLoading = atom({ plugin: 'context-explorer', key: 'isLoading' } as const, false)

const approx = (text: string) => Math.ceil(text.length / 4)
const fmt = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`)
const home = (p: string) => p.replace(/^\/home\/[^/]+/, '~')
/** Exactly `n` cells: cut in the middle with … when longer, padded when shorter. */
const cell = (text: string, n: number) => {
  if (n <= 0) return ''
  if (text.length <= n) return text.padEnd(n)
  const head = Math.ceil((n - 1) / 2)

  return text.slice(0, head) + '…' + text.slice(text.length - (n - 1 - head))
}

const upsert = (list: ContextItem[], items: ContextItem[]) => {
  const ids = new Set(items.map(i => i.id))

  return [...list.filter(i => !ids.has(i.id)), ...items]
}

/** A bar of `width` cells, `share` of them filled. */
const bar = (share: number, width: number) => {
  const filled = Math.max(share > 0 ? 1 : 0, Math.round(share * width))

  return { on: '█'.repeat(Math.min(width, filled)), off: '·'.repeat(Math.max(0, width - filled)) }
}

/** Reads what the engine can tell us now and stores it as the snapshot. */
async function refresh($: EngineInterface): Promise<void> {
  await update($, isLoading, () => true)
  const items: ContextItem[] = []
  const safe = async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    try {
      return await fn()
    } catch {
      return undefined
    }
  }

  const used = await safe(() => $.session.usage({ breakdown: 'summary' }))
  const breakdown = used?.context.breakdown

  if (breakdown) {
    await update($, usage, () => ({
      total: breakdown.totalTokens,
      max: breakdown.rawMaxTokens,
      slices: breakdown.categories
        .filter(c => !c.isDeferred && c.tokens > 0)
        .map(c => ({ name: c.name, tokens: c.tokens, color: c.color, kind: c.kind })),
    }))
  }

  for (const file of breakdown?.memoryFiles ?? []) {
    const text = await safe(() => $.fs.read(file.path))
    items.push({
      id: `Instruction files:${file.path}`,
      group: 'Instruction files',
      title: home(file.path),
      meta: file.type,
      tokens: file.tokens,
      text: typeof text === 'string' ? text : '(could not read the file)',
    })
  }

  const composed = await safe(() => $.prompt.compose())
  for (const section of composed?.sections ?? []) {
    items.push({
      id: `System prompt:${section.id}`,
      group: 'System prompt',
      title: section.id,
      meta: section.scope,
      tokens: approx(section.text),
      text: section.text,
    })
  }

  const commands = (await safe(() => $.command.list())) ?? []
  const describe = new Map(commands.map(c => [c.name, c.description]))
  const userDir = (breakdown?.memoryFiles ?? [])
    .map(f => f.path)
    .find(p => /\/\.claude\/CLAUDE\.md$/.test(p))
    ?.replace(/CLAUDE\.md$/, '')
  for (const skill of breakdown?.skills?.skillFrontmatter ?? []) {
    let body = ''
    const candidates =
      skill.source === 'userSettings' && userDir
        ? [`${userDir}skills/${skill.name}/SKILL.md`]
        : skill.source === 'projectSettings'
          ? [`.claude/skills/${skill.name}/SKILL.md`]
          : []
    for (const path of candidates) {
      const text = await safe(() => $.fs.read(path))
      if (typeof text === 'string') {
        body = `*${home(path)}*\n\n${text}`
        break
      }
    }
    items.push({
      id: `Skills:${skill.name}`,
      group: 'Skills',
      title: skill.name,
      meta: skill.pluginName ?? skill.source,
      tokens: skill.tokens,
      text:
        `> ${describe.get(skill.name) ?? ''}\n\n` +
        (body ||
          '_Only the listing above is in context. The full body appears under **Invoked** once the skill runs._'),
    })
  }

  for (const tool of (await safe(() => $.tool.list())) ?? []) {
    items.push({
      id: `Tools:${tool.name}`,
      group: 'Tools',
      title: tool.name,
      meta: tool.mcp ? 'mcp' : 'built-in',
      tokens: approx(tool.description),
      text: tool.description,
    })
  }

  await update($, snapshot, () => items)
  await update($, isLoading, () => false)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({
      name: 'context-explorer',
      description: 'Browse the CLAUDE.md, MEMORY.md, skills, tools and prompt sections in context',
    })

    return started
  })

  on('command.run', { command: 'context-explorer' }, async $ => {
    await $.ui.open({ id: PANE, title: TITLE, focus: true })
    void refresh($)

    return { text: 'Context explorer opened.' }
  })

  // The first message's context blocks and the instruction files behind them,
  // as the model actually received them.
  on('prompt.context', async ($, e, next) => {
    const result = await next(e)
    const items: ContextItem[] = result.blocks.map(block => ({
      id: `Context blocks:${block.name}`,
      group: 'Context blocks',
      title: block.name,
      meta: 'first message',
      tokens: approx(block.text),
      text: block.text,
    }))
    for (const file of result.instructionFiles ?? e.instructionFiles ?? []) {
      items.push({
        id: `Instruction files:${file.path}`,
        group: 'Instruction files',
        title: home(file.path),
        meta: `${file.kind}${file.parent ? ' · imported' : ''} · as sent`,
        tokens: approx(file.content),
        text: file.content,
      })
    }
    void update($, captured, list => upsert(list, items))

    return result
  })

  // A skill's full body, the moment it is expanded for the model.
  on('skill.prompt', async ($, e, next) => {
    const result = await next(e)
    void update($, skillBodies, list =>
      upsert(list, [
        {
          id: `Skills invoked:${e.skill}`,
          group: 'Skills invoked',
          title: e.skill,
          meta: e.pluginName ?? e.source,
          tokens: approx(result.text),
          text: (e.path ? `*${home(e.path)}*\n\n` : '') + result.text,
        },
      ]),
    )

    return result
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Input, Markdown } = $.ui.resolve(e)
    // Raster is the terminal's alone; elsewhere the grid gives way to the bar.
    const Raster = e.surface === 'terminal' ? $.ui.resolve(e).Raster : null
    const v = await read($, view)
    const loading = await read($, isLoading)
    const u = await read($, usage)
    // What the model received wins over the file on disk for the same path.
    const all = upsert(await read($, snapshot), [
      ...(await read($, captured)),
      ...(await read($, skillBodies)),
    ])
    const width = Math.max(30, e.props.bodyColumns ?? 60)

    const setView = (fn: (v: ExplorerView) => ExplorerView) => update($, view, fn)
    const toTop = () => void $.ui.scroll({ in: PANE, to: 'start' }).catch(() => {})

    const needle = v.filter.trim().toLowerCase()
    const matches = (i: ContextItem) =>
      !needle || i.title.toLowerCase().includes(needle) || i.text.toLowerCase().includes(needle)
    const sorted = (list: ContextItem[]) =>
      [...list].sort((a, b) =>
        v.sort === 'size' ? b.tokens - a.tokens : a.title.localeCompare(b.title),
      )
    const inTab = (tab: string) => sorted(all.filter(i => i.group === tab && matches(i)))

    // ── The window, as /context counts it: one colour per category, shared by
    // the one-line bar (detail view) and the grid (list view).
    const usedSlices = u.slices.filter(s => s.kind === 'used')
    const rgbOf = (slice: { name: string; kind: string }) =>
      slice.kind === 'free'
        ? FREE_RGB
        : slice.kind === 'buffer'
          ? BUFFER_RGB
          : PALETTE[usedSlices.findIndex(s => s.name === slice.name) % PALETTE.length] ?? 0x888888
    const hex = (rgb: number) => '#' + rgb.toString(16).padStart(6, '0')
    const pct = u.max ? Math.round((u.total / u.max) * 100) : 0
    const title = (
      <Text>
        <Text bold>Context </Text>
        <Text color={pct > 80 ? 'error' : pct > 60 ? 'warning' : 'success'}>{fmt(u.total)}</Text>
        <Text dimColor> / {fmt(u.max)} tokens · {pct}%</Text>
      </Text>
    )

    const compactBar = (() => {
      if (!u.max) return null
      const cells = Math.min(width, 100)
      let left = cells
      const parts = u.slices
        .filter(s => s.kind !== 'free')
        .map(s => {
          const n = Math.min(left, Math.max(1, Math.round((s.tokens / u.max) * cells)))
          left -= n

          return <Text color={hex(rgbOf(s))}>{(s.kind === 'buffer' ? '▒' : '█').repeat(n)}</Text>
        })

      return (
        <Box flexDirection="column" marginBottom={1}>
          {title}
          <Text>
            {parts}
            <Text dimColor>{'·'.repeat(Math.max(0, left))}</Text>
          </Text>
        </Box>
      )
    })()

    const grid = (() => {
      if (!u.max) return null
      if (!Raster) return compactBar
      const across = width >= 100 ? 25 : 20
      const down = 10
      const per = u.max / (across * down)
      // Each square: [glyph, rgb]; used rows fill in order, the buffer sits at the end.
      const squares: [number, number][] = []
      for (const slice of usedSlices) {
        const n = slice.tokens / per
        for (let i = 0; i < Math.floor(n); i++) squares.push([SQUARE, rgbOf(slice)])
        const frac = n - Math.floor(n)
        if (frac > 0.05) squares.push([frac >= 0.7 ? SQUARE : HOLLOW, rgbOf(slice)])
      }
      const buffer = u.slices.find(s => s.kind === 'buffer')
      const bufferSquares = buffer ? Math.round(buffer.tokens / per) : 0
      while (squares.length < across * down - bufferSquares) squares.push([DOT, FREE_RGB])
      while (squares.length < across * down) squares.push([BUFFER_GLYPH, BUFFER_RGB])
      squares.length = across * down

      // Two terminal cells per square, so the grid reads square.
      const words = new Uint32Array(across * 2 * down * 3)
      squares.forEach(([glyph, rgb], i) => {
        words.set([glyph, rgb, DEFAULT, SPACE, rgb, DEFAULT], i * 6)
      })
      const bytes = new Uint8Array(words.buffer)
      let binary = ''
      for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!)

      const legendRoom = Math.max(0, width - across * 2 - 3)
      const isBeside = legendRoom >= 28
      const nameRoom = Math.max(8, (isBeside ? legendRoom : width) - 16)
      const legend = (
        <Box flexDirection="column" marginLeft={isBeside ? 3 : 0} marginTop={isBeside ? 0 : 1}>
          {u.slices.map(s => (
            <Text>
              <Text color={hex(rgbOf(s))}>
                {s.kind === 'free' ? '·' : s.kind === 'buffer' ? '▒' : '■'}
              </Text>{' '}
              {cell(s.name, nameRoom)}
              <Text dimColor>
                {fmt(s.tokens).padStart(7)} {`${((s.tokens / u.max) * 100).toFixed(1)}%`.padStart(6)}
              </Text>
            </Text>
          ))}
          <Text dimColor>{'\n'}one square ≈ {fmt(Math.round(per))} tokens</Text>
        </Box>
      )

      return (
        <Box flexDirection="column" marginBottom={1}>
          {title}
          <Box flexDirection={isBeside ? 'row' : 'column'} marginTop={1}>
            <Raster key="grid" columns={across * 2} rows={down} cells={btoa(binary)} />
            {legend}
          </Box>
        </Box>
      )
    })()

    // ── Detail view.
    const chosen = v.selected ? all.find(i => i.id === v.selected) : undefined
    if (chosen) {
      const siblings = inTab(chosen.group)
      const at = siblings.findIndex(i => i.id === chosen.id)
      const go = (step: number) => {
        const next = siblings[(at + step + siblings.length) % siblings.length]
        if (next) void setView(s => ({ ...s, selected: next.id }))
        toTop()
      }
      const lines = chosen.text.split('\n')
      const gutter = String(lines.length).length
      const groupTotal = all.filter(i => i.group === chosen.group).reduce((n, i) => n + i.tokens, 0)
      const share = groupTotal ? chosen.tokens / groupTotal : 0
      const b = bar(share, 20)
      const color = colorOf(chosen.group)

      return (
        <Box flexDirection="column">
          {compactBar}
          <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
            <Button key="back" hotkey="b" autoFocus onPress={() => setView(s => ({ ...s, selected: null }))}>
              ← Back
            </Button>
            <Button key="prev" hotkey="p" onPress={() => go(-1)}>
              ◂ Prev
            </Button>
            <Button key="next" hotkey="n" onPress={() => go(1)}>
              Next ▸
            </Button>
            <Button key="raw" hotkey="m" onPress={() => setView(s => ({ ...s, isRaw: !s.isRaw }))}>
              {v.isRaw ? 'Rendered' : 'Raw'}
            </Button>
            <Button key="copy" hotkey="c" onPress={p => $.ui.copy({ text: chosen.text, surface: p.surface })}>
              Copy
            </Button>
          </Box>
          <Box
            flexDirection="column"
            borderStyle="round"
            borderColor={color}
            paddingX={1}
            marginTop={1}
          >
            <Text>
              <Text color={color}>{chosen.group}</Text>
              <Text dimColor> › </Text>
              <Text bold>{chosen.title}</Text>
              <Text dimColor>
                {'  '}
                {at + 1}/{siblings.length}
              </Text>
            </Text>
            <Text>
              <Text color={color}>{b.on}</Text>
              <Text dimColor>{b.off}</Text>
              <Text dimColor>
                {' '}
                ~{fmt(chosen.tokens)} tok · {Math.round(share * 100)}% of {chosen.group.toLowerCase()} ·{' '}
                {lines.length} lines · {chosen.meta}
              </Text>
            </Text>
          </Box>
          <Box flexDirection="column" marginTop={1}>
            {!chosen.text && <Text dimColor>(empty)</Text>}
            {chosen.text && !v.isRaw && <Markdown key="body" text={chosen.text} />}
            {chosen.text &&
              v.isRaw &&
              lines.map((line, n) => {
                const isHit = !!needle && line.toLowerCase().includes(needle)

                return (
                  <Text>
                    <Text dimColor>{String(n + 1).padStart(gutter)} │ </Text>
                    {isHit ? (
                      <Text color="inverseText" backgroundColor="warning">
                        {line}
                      </Text>
                    ) : (
                      line
                    )}
                  </Text>
                )
              })}
          </Box>
        </Box>
      )
    }

    // ── List view: tabs, then the tab's items with a size bar each.
    const rows = inTab(v.tab)
    const most = Math.max(1, ...rows.map(i => i.tokens))
    const tabColor = colorOf(v.tab)
    const metaRoom = Math.min(14, Math.max(0, width - 40))
    // bar 8 · space · title · space · tokens 6 · 2 spaces · meta
    const titleRoom = Math.max(10, width - 8 - 1 - 1 - 6 - (metaRoom ? 2 + metaRoom : 0) - 1)

    return (
      <Box flexDirection="column">
        {grid}
        <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
          {GROUPS.map(g => {
            const count = all.filter(i => i.group === g.name && matches(i)).length

            return (
              <Button
                key={`tab:${g.name}`}
                hotkey={g.hotkey}
                variant={v.tab === g.name ? 'primary' : 'secondary'}
                onPress={() => {
                  void setView(s => ({ ...s, tab: g.name }))
                  toTop()
                }}
              >
                {g.short} <Text dimColor={v.tab !== g.name}>{count}</Text>
              </Button>
            )
          })}
        </Box>
        <Box flexDirection="row" columnGap={1} marginTop={1}>
          <Button key="refresh" hotkey="r" onPress={() => void refresh($)}>
            {loading ? 'Loading…' : 'Refresh'}
          </Button>
          <Button
            key="sort"
            hotkey="s"
            onPress={() => setView(s => ({ ...s, sort: s.sort === 'size' ? 'name' : 'size' }))}
          >
            Sort: {v.sort}
          </Button>
          {needle && (
            <Button key="clear" hotkey="x" onPress={() => setView(s => ({ ...s, filter: '' }))}>
              Clear filter
            </Button>
          )}
        </Box>
        <Input
          key="filter"
          placeholder="/ Filter names and text, Enter"
          value={v.filter}
          submitLabel="Filter"
          onSubmit={value => setView(s => ({ ...s, filter: value }))}
        />
        <Box flexDirection="column" borderStyle="round" borderColor={tabColor} paddingX={1}>
          <Text>
            <Text bold color={tabColor}>
              {v.tab}
            </Text>
            <Text dimColor>
              {'  '}
              {rows.length} items · ~{fmt(rows.reduce((n, i) => n + i.tokens, 0))} tok
              {needle ? ` · matching "${v.filter}"` : ''}
            </Text>
          </Text>
          {rows.length > 0 && (
            <Text dimColor>
              {cell('size', 8)} {cell('name', titleRoom)} {'tokens'.padStart(6)}
              {metaRoom ? '  ' + cell('source', metaRoom) : ''}
            </Text>
          )}
          {rows.length === 0 && (
            <Text dimColor>
              {loading
                ? 'Reading the context…'
                : all.length === 0
                  ? 'Nothing yet: press r to refresh.'
                  : v.tab === 'Skills invoked'
                    ? 'No skill has run since the mod loaded.'
                    : v.tab === 'Context blocks'
                      ? 'Captured when the first message is next sent (new session or compaction).'
                      : 'Nothing here matches.'}
            </Text>
          )}
          {rows.map(item => {
            const b = bar(item.tokens / most, 8)

            return (
              <Button
                key={`item:${item.id}`}
                plain
                onPress={() => {
                  void setView(s => ({ ...s, selected: item.id }))
                  toTop()
                }}
              >
                <Text color={tabColor}>{b.on}</Text>
                <Text dimColor>{b.off}</Text>
                {' '}
                {cell(item.title, titleRoom)}{' '}
                <Text color={tabColor}>{fmt(item.tokens).padStart(6)}</Text>
                {metaRoom ? <Text dimColor>{'  ' + cell(item.meta, metaRoom)}</Text> : ''}
              </Button>
            )
          })}
        </Box>
        <Text dimColor>
          1-6 tabs · s sort · r refresh · Enter opens · in a file: n/p next/prev, m raw, c copy, b back
        </Text>
      </Box>
    )
  })
}
