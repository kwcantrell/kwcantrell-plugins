import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Inventory, InventoryGroup, InventoryItem } from '../types'

// `/inventory` opens a pane listing every skill, plugin and MCP server, grouped by
// the scope that configures it: User (~/.claude, ~/.claude.json) and Project (the
// session's directory). What is loaded but configured at neither scope (a
// --plugin-dir plugin, its skills and servers) goes under "Session only".
//
// Scope comes from the config files; the session's own skill and MCP listing
// ($.session.usage breakdown) adds what plugins contribute and what is live.

const PANE = 'inventory'
const TITLE = 'Skills, plugins & MCP'
const RESCAN_MS = 60_000

// Bump the tag whenever Inventory's fields change.
const inventory = atom({ plugin: 'base-setup', key: 'inventory' } as const, null, {
  shape: 'inventory-1',
})

type Json = Record<string, unknown>

async function readJson($: EngineInterface, path: string): Promise<Json> {
  try {
    const parsed: unknown = JSON.parse(await $.fs.read(path))
    return parsed && typeof parsed === 'object' ? (parsed as Json) : {}
  } catch {
    return {}
  }
}

const obj = (v: unknown): Json => (v && typeof v === 'object' ? (v as Json) : {})

async function skillDirs($: EngineInterface, dir: string): Promise<string[]> {
  try {
    const entries = await $.fs.list(dir)
    const names: string[] = []
    for (const one of entries) {
      if (one.kind === 'file') continue
      if (await $.fs.exists(`${dir}/${one.name}/SKILL.md`)) names.push(one.name)
    }
    return names
  } catch {
    return []
  }
}

/** enabledPlugins keys set to true, in the order the file lists them. */
const enabled = (settings: Json): string[] =>
  Object.entries(obj(settings.enabledPlugins))
    .filter(([, on]) => on === true)
    .map(([key]) => key)

function serverItems(servers: Json, note?: string): InventoryItem[] {
  return Object.entries(servers).map(([name, cfg]) => {
    const c = obj(cfg)
    const target =
      typeof c.url === 'string' ? c.url : [c.command, ...((c.args as unknown[]) ?? [])].filter(Boolean).join(' ')
    return { name, note: [note, target].filter(Boolean).join(' · ') || undefined }
  })
}

const byName = (a: InventoryItem, b: InventoryItem) => a.name.localeCompare(b.name)

function addUnique(list: InventoryItem[], item: InventoryItem) {
  if (!list.some(one => one.name === item.name)) list.push(item)
}

async function scan($: EngineInterface): Promise<Inventory> {
  const home = (await $.env.get('HOME')) ?? ''
  const claudeDir = (await $.env.get('CLAUDE_CONFIG_DIR')) || `${home}/.claude`
  const claudeJsonPath = (await $.env.get('CLAUDE_CONFIG_DIR')) ? `${claudeDir}/.claude.json` : `${home}/.claude.json`
  const cwd = await $.session.cwd()
  const tilde = (p: string) => (home && p.startsWith(home) ? `~${p.slice(home.length)}` : p)

  const [userSettings, projSettings, localSettings, claudeJson, projectMcp] = await Promise.all([
    readJson($, `${claudeDir}/settings.json`),
    readJson($, `${cwd}/.claude/settings.json`),
    readJson($, `${cwd}/.claude/settings.local.json`),
    readJson($, claudeJsonPath),
    readJson($, `${cwd}/.mcp.json`),
  ])

  const user: InventoryGroup = { title: 'User', where: tilde(claudeDir), skills: [], plugins: [], mcp: [] }
  const project: InventoryGroup = { title: 'Project', where: tilde(cwd), skills: [], plugins: [], mcp: [] }
  const session: InventoryGroup = {
    title: 'Session only',
    where: 'loaded, but not configured at either scope (--plugin-dir, CLAUDE_CODE_PLUGIN_DIRS)',
    skills: [],
    plugins: [],
    mcp: [],
  }

  // Skills on disk.
  for (const name of await skillDirs($, `${claudeDir}/skills`)) user.skills.push({ name })
  if (cwd !== home) for (const name of await skillDirs($, `${cwd}/.claude/skills`)) project.skills.push({ name })

  // Plugins, keyed by bare name for matching the live listing.
  const pluginGroup = new Map<string, { group: InventoryGroup; key: string; skills: number; mcp: number }>()
  const addPlugin = (group: InventoryGroup, key: string, note?: string) => {
    const bare = key.split('@')[0] ?? key
    if (pluginGroup.has(bare)) return
    pluginGroup.set(bare, { group, key, skills: 0, mcp: 0 })
    group.plugins.push({ name: key, note })
  }
  for (const key of enabled(userSettings)) addPlugin(user, key)
  for (const key of enabled(projSettings)) addPlugin(project, key)
  for (const key of enabled(localSettings)) addPlugin(project, key, 'local')

  // MCP servers from config.
  user.mcp.push(...serverItems(obj(claudeJson.mcpServers)))
  project.mcp.push(...serverItems(obj(projectMcp.mcpServers), '.mcp.json'))
  project.mcp.push(...serverItems(obj(obj(obj(claudeJson.projects)[cwd]).mcpServers), 'local'))

  // What the session has loaded: plugin skills and servers, connectors, extras.
  let builtInSkills = 0
  try {
    const usage = await $.session.usage({ breakdown: 'summary' })
    const breakdown = usage.context.breakdown
    for (const skill of breakdown?.skills?.skillFrontmatter ?? []) {
      if (skill.source === 'built-in') {
        builtInSkills++
      } else if (skill.source === 'plugin' && skill.pluginName) {
        const owner = pluginGroup.get(skill.pluginName)
        if (owner) owner.skills++
        else {
          addPlugin(session, skill.pluginName)
          pluginGroup.get(skill.pluginName)!.skills++
        }
      } else if (skill.source === 'projectSettings') {
        addUnique(project.skills, { name: skill.name })
      } else if (skill.source === 'userSettings' || skill.source === 'syncedSkills') {
        addUnique(user.skills, { name: skill.name.replace(/^.*:/, ''), note: skill.source === 'syncedSkills' ? 'synced' : undefined })
      } else if (skill.source !== 'mcp') {
        addUnique(session.skills, { name: skill.name, note: String(skill.source) })
      }
    }

    const live = new Set((breakdown?.mcpTools ?? []).map(tool => tool.serverName))
    const configured = new Set([...user.mcp, ...project.mcp].map(one => one.name))
    for (const server of live) {
      if (configured.has(server)) continue
      const fromPlugin = /^plugin:([^:]+):/.exec(server)
      if (fromPlugin) {
        const bare = fromPlugin[1]!
        if (!pluginGroup.has(bare)) addPlugin(session, bare)
        pluginGroup.get(bare)!.mcp++
      } else if (server.startsWith('claude.ai ')) {
        addUnique(user.mcp, { name: server, note: 'claude.ai connector' })
      } else {
        addUnique(session.mcp, { name: server })
      }
    }
    for (const group of [user.mcp, project.mcp])
      for (const item of group) if (!live.has(item.name)) item.note = [item.note, 'not connected'].filter(Boolean).join(' · ')
  } catch {
    // No session bound yet: the config files alone.
  }

  for (const { group, key, skills, mcp } of pluginGroup.values()) {
    const parts = [skills && `${skills} skill${skills === 1 ? '' : 's'}`, mcp && `${mcp} MCP`].filter(Boolean)
    const item = group.plugins.find(one => one.name === key)
    if (item && parts.length) item.note = [item.note, ...parts].filter(Boolean).join(' · ')
  }

  const groups = [user, project, session].filter(
    g => g !== session || g.skills.length + g.plugins.length + g.mcp.length > 0,
  )
  for (const g of groups) for (const list of [g.skills, g.plugins, g.mcp]) list.sort(byName)

  return { scannedAt: await $.clock.now(), groups, builtInSkills }
}

async function rescan($: EngineInterface) {
  const next = await scan($)
  await update($, inventory, () => next)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({
      name: 'inventory',
      description: 'Show every skill, plugin and MCP server, grouped by user and project scope',
    })
    void rescan($).catch(() => undefined)
    $.clock.every(RESCAN_MS, () => void rescan($).catch(() => undefined))

    return started
  })

  on('command.run', { command: 'inventory' }, async $ => {
    await rescan($)
    await $.ui.open({ id: PANE, title: TITLE })

    return { text: 'Inventory pane opened (rescans every minute; run /inventory to rescan now).' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const inv = await read($, inventory)
    if (!inv) return <Text dimColor>Scanning…</Text>

    const section = (label: string, items: InventoryItem[]) => (
      <Box flexDirection="column" marginLeft={2}>
        <Text bold>
          {label} <Text dimColor>({items.length})</Text>
        </Text>
        {items.length === 0 && <Text dimColor>  none</Text>}
        {items.map(item => (
          <Text wrap="truncate-end">
            {'  '}
            {item.name}
            {item.note ? <Text dimColor> · {item.note}</Text> : null}
          </Text>
        ))}
      </Box>
    )

    return (
      <Box flexDirection="column" gap={1}>
        {inv.groups.map(group => (
          <Box flexDirection="column">
            <Text bold color="cyan">
              {group.title} <Text dimColor>{group.where}</Text>
            </Text>
            {section('Skills', group.skills)}
            {section('Plugins', group.plugins)}
            {section('MCP servers', group.mcp)}
          </Box>
        ))}
        {inv.builtInSkills > 0 && <Text dimColor>+ {inv.builtInSkills} built-in skills</Text>}
      </Box>
    )
  })
}
