import { expect, test } from 'claude-code/testing'

const PANE = {
  plugin: 'context-explorer',
  component: 'Pane',
  requestId: 'context-explorer',
  props: {
    title: 'Context explorer',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

test('lists a CLAUDE.md and opens it', async ($, on) => {
  on('command.register', () => ({ value: { command: 'context-explorer' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.scroll', () => ({}))
  on('session.usage', () => ({
    value: ({
      context: {
        breakdown: {
          totalTokens: 40000,
          rawMaxTokens: 200000,
          categories: [{ name: 'System prompt', tokens: 8000, color: 'promptBorder', isDeferred: false, kind: 'used' }, { name: 'Free space', tokens: 160000, color: 'inactive', isDeferred: false, kind: 'free' }],
          memoryFiles: [{ path: '/home/u/.claude/CLAUDE.md', type: 'User', tokens: 900 }],
          skills: { totalSkills: 1, includedSkills: 1, tokens: 20, skillFrontmatter: [{ name: 'loop', source: 'built-in', tokens: 20 }] },
        },
      },
    }) as never,
  }))
  on('fs.read', () => ({ value: '# Hosts\nspark is the controller' }))
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'You are Claude', scope: 'shared' }] }))
  on('command.list', () => ({ value: [{ name: 'loop', description: 'Run on an interval', source: 'builtin' }] }))
  on('tool.list', () => ({ value: [{ name: 'Bash', description: 'Runs bash', mcp: false }] }))

  await $.command.run({ command: 'context-explorer' } as never)
  for (let i = 0; i < 20; i++) await Promise.resolve()

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const row = await ui.find({ type: 'Button', text: /CLAUDE\.md/ })
  expect(row).toBeTruthy()
  expect(await ui.find({ type: 'Button', text: /Prompt/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /Context/ })).toBeTruthy()
  const grid = await ui.find({ type: 'Raster' })
  expect(grid).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /one square/ })).toBeTruthy()
  await ui.press({ key: row!.key! })
  expect(await ui.find({ type: 'Markdown' })).toBeTruthy()
  await ui.press({ key: 'raw' })
  expect((await ui.find({ type: 'Text', text: /spark is the controller/ }))?.text).toContain('spark')
  await ui.unmount()
})
