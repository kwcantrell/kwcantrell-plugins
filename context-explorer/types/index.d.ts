export type ContextItem = {
  /** Unique within the snapshot: `<group>:<name>`. */
  id: string
  group: string
  title: string
  /** One dim line beside the title: tier or source. */
  meta: string
  /** Estimated tokens this item costs in context. */
  tokens: number
  /** The full text as loaded; empty when only the listing is known. */
  text: string
}

export type ExplorerView = {
  /** The tab shown in the list. */
  tab: string
  /** The id of the item opened, or null for the list. */
  selected: string | null
  filter: string
  sort: 'size' | 'name'
  /** Detail view: raw text with line numbers instead of rendered Markdown. */
  isRaw: boolean
}

export type UsageSlice = { name: string; tokens: number; color: string; kind: string }

export type Usage = { total: number; max: number; slices: UsageSlice[] }

declare module 'claude-code' {
  interface PluginState {
    'context-explorer': {
      snapshot: Shaped<ContextItem[]>
      captured: Shaped<ContextItem[]>
      skillBodies: Shaped<ContextItem[]>
      view: Shaped<ExplorerView>
      usage: Shaped<Usage>
      isLoading: boolean
    }
  }
}
