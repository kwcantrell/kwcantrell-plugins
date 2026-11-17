/** One row of the inventory pane: a skill, plugin or MCP server, with an optional note. */
export type InventoryItem = { name: string; note?: string }

/** Everything configured at one scope. */
export type InventoryGroup = {
  /** `User`, `Project` or `Session only`. */
  title: string
  /** Where that scope's config lives (`~/.claude`, the project dir), or a hint. */
  where: string
  skills: InventoryItem[]
  plugins: InventoryItem[]
  mcp: InventoryItem[]
}

export type Inventory = {
  /** Epoch ms of the scan. */
  scannedAt: number
  groups: InventoryGroup[]
  /** Built-in skills, counted rather than listed. */
  builtInSkills: number
}

declare module 'claude-code' {
  interface PluginState {
    'base-setup': { inventory: Shaped<Inventory | null> }
  }
}
