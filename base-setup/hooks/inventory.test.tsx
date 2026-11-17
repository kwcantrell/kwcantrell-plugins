import { expect, test } from 'claude-code/testing'

const HOME = '/home/u'
const CWD = '/home/u/app'

// A fake filesystem: path -> file text, and dir -> entries.
const FILES: Record<string, string> = {
  [`${HOME}/.claude/settings.json`]: JSON.stringify({
    enabledPlugins: { 'factory@kwcantrell-plugins': true, 'off@x': false },
  }),
  [`${HOME}/.claude.json`]: JSON.stringify({
    mcpServers: { github: { command: 'gh-mcp' } },
    projects: { [CWD]: { mcpServers: { db: { url: 'http://localhost:9000' } } } },
  }),
  [`${CWD}/.claude/settings.json`]: JSON.stringify({ enabledPlugins: { 'web@kwcantrell-plugins': true } }),
  [`${CWD}/.mcp.json`]: JSON.stringify({ mcpServers: { linear: { url: 'https://mcp.linear.app' } } }),
  [`${HOME}/.claude/skills/find-skills/SKILL.md`]: '---\nname: find-skills\n---',
  [`${CWD}/.claude/skills/deploy/SKILL.md`]: '---\nname: deploy\n---',
}
const DIRS: Record<string, string[]> = {
  [`${HOME}/.claude/skills`]: ['find-skills'],
  [`${CWD}/.claude/skills`]: ['deploy'],
}

const PANE = {
  plugin: 'base-setup',
  component: 'Pane',
  requestId: 'inventory',
  props: {
    title: 'Skills, plugins & MCP',
    isFocused: false,
    bodyColumns: 80,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 60 },
    view: {},
  },
} as const

test('groups skills, plugins and MCP servers by user and project scope', async ($, on) => {
  on('env.get', (_, e) => ({ value: e.name === 'HOME' ? HOME : undefined }))
  on('session.cwd', () => ({ value: CWD }))
  on('clock.now', () => ({ value: 1 }))
  on('clock.every', () => ({ value: undefined }))
  on('command.register', () => ({ value: { command: 'inventory' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('fs.read', (_, e) => {
    const text = FILES[e.path]
    if (text === undefined) throw new Error('ENOENT')
    return { value: text }
  })
  on('fs.exists', (_, e) => ({ value: e.path in FILES }))
  on('fs.list', (_, e) => {
    const names = DIRS[e.path]
    if (!names) throw new Error('ENOENT')
    return { value: names.map(name => ({ name, kind: 'dir' as const, size: 0, mtimeMs: 0 })) }
  })
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      rateLimits: [],
      context: {
        window: 200000,
        breakdown: {
          skills: {
            totalSkills: 4,
            includedSkills: 4,
            tokens: 0,
            skillFrontmatter: [
              { name: 'factory:run', source: 'plugin', pluginName: 'factory', tokens: 1 },
              { name: 'agent-browser', source: 'userSettings', tokens: 1 },
              { name: 'init', source: 'built-in', tokens: 1 },
              { name: 'dev:thing', source: 'plugin', pluginName: 'dev', tokens: 1 },
            ],
          },
          mcpTools: [
            { name: 'mcp__github__x', serverName: 'github', tokens: 1, isLoaded: true },
            { name: 'mcp__plugin_web_shadcn__x', serverName: 'plugin:web:shadcn', tokens: 1, isLoaded: true },
            { name: 'mcp__claude_ai_Gmail__x', serverName: 'claude.ai Gmail', tokens: 1, isLoaded: false },
          ],
        },
      },
    },
  }))

  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'inventory', args: '' })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    const has = async (re: RegExp) => (await ui.find({ type: 'Text', text: re }))?.text

    expect(await has(/^User/)).toContain('~/.claude')
    expect(await has(/^Project/)).toContain('~/app')
    expect(await has(/find-skills/)).toBeDefined()
    expect(await has(/agent-browser/)).toBeDefined()
    expect(await has(/deploy/)).toBeDefined()
    expect(await has(/factory@kwcantrell-plugins/)).toContain('1 skill')
    expect(await has(/web@kwcantrell-plugins/)).toContain('1 MCP')
    expect(await has(/off@x/)).toBeUndefined()
    expect(await has(/github/)).toBeDefined()
    expect(await has(/claude\.ai Gmail/)).toContain('connector')
    expect(await has(/linear/)).toContain('not connected')
    expect(await has(/^\s*db/)).toContain('local')
    expect(await has(/^Session only/)).toBeDefined()
    expect(await has(/^\s*dev/)).toContain('1 skill')
    expect(await has(/built-in skills/)).toContain('1')
    await ui.unmount()
  }
})
