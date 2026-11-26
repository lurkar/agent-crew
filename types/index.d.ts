export type Family = 'fable' | 'opus' | 'sonnet' | 'haiku' | 'gpt' | 'other'

export type Glyph = 'terminal' | 'web' | 'files' | 'cube' | 'image' | 'mail' | 'chart' | 'plug'

export type CrewAgent = {
  id: string
  model: string
  family: Family
  task: string
  type: string
  status: 'working' | 'done' | 'failed'
  /** Still alive, but waiting (an idle teammate). */
  resting?: boolean
  /** The tool it is using right now, if that tool has a node. */
  tool?: string
  calls?: number
  /** The model its replies came from, when known; differs from `model` after a fallback. */
  replied?: string
  /** The workflow run it belongs to (Ultracode works through workflows). */
  run?: string
  /** Tokens it has used, to the nearest thousand. */
  tokens?: number
  parentId?: string
  startedAt: number
  endedAt?: number
}

export type CrewLead = {
  model: string
  family: Family
  busy: boolean
  tool?: string
  /** The model its replies came from, when known. */
  replied?: string
  /** A workflow (Ultracode) is running. */
  ultra?: boolean
}

export type CrewTool = { id: string; label: string; glyph: Glyph; firstAt: number; lastAt: number }

export type CrewLog = { at: number; text: string; family: Family }

export type Crew = {
  lead: CrewLead
  agents: CrewAgent[]
  tools: CrewTool[]
  log: CrewLog[]
}

declare module 'claude-code' {
  interface PluginState {
    'agent-crew': { crew: Shaped<Crew>; isOpen: boolean }
  }
}
