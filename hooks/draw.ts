// Everything Agent Crew draws, and the pure state changes behind it.
// No engine calls in this file: it is plain functions over plain data.
import type { Crew, CrewAgent, CrewLead, CrewTool, Family, Glyph } from '../types'

export const EMPTY: Crew = {
  lead: { model: 'Claude', family: 'other', busy: false },
  agents: [],
  tools: [],
  log: [],
}

const LOG_MAX = 40
const DONE_MAX = 24
const TOOLS_MAX = 12
const FRESH = 6000

const BG = '#141413'
const INK = '#faf9f5'
const MUTED = '#b0aea5'
const MID = '#8a8880'
const FAINT = '#5e5d59'
const LINE = '#3a3935'
const DOT = '#2c2b27'
const PANEL = '#1d1c19'
const RED = '#e5484d'

export const COLOR: Record<Family, string> = {
  fable: '#e8b04b',
  opus: '#d97757',
  sonnet: '#6a9bcc',
  haiku: '#8fa86a',
  gpt: '#c48dbb',
  other: '#b0aea5',
}

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

const FAMILIES = ['fable', 'opus', 'sonnet', 'haiku'] as const

export function familyOf(model: string): Family {
  const m = model.toLowerCase()
  for (const f of FAMILIES) if (m.includes(f)) return f
  if (/gpt|openai|chatgpt|dall|\bo\d\b/.test(m)) return 'gpt'
  return 'other'
}

export function prettyModel(model: string): string {
  const m = model.toLowerCase().replace(/\[[^\]]*\]/g, '')
  const parts = m.split(/[-_.:/@]/).filter(Boolean)
  const fam = parts.find(p => (FAMILIES as readonly string[]).includes(p))
  if (!fam) return (model || 'Model').slice(0, 14)
  const at = parts.indexOf(fam)
  const nums = [...parts.slice(at + 1), ...parts.slice(0, at)].filter(p => /^\d{1,2}$/.test(p)).slice(0, 2)
  return fam.charAt(0).toUpperCase() + fam.slice(1) + (nums.length ? ' ' + nums.join('.') : '')
}

// ---------------------------------------------------------------------------
// Tools: built-ins are grouped, every MCP server is its own node
// ---------------------------------------------------------------------------

type ToolGroup = { id: string; label: string; glyph: Glyph }

const HANDOFF = new Set(['agent', 'task'])
const SHELL = new Set(['bash', 'powershell', 'bashoutput', 'killshell'])
const FILES = new Set(['read', 'edit', 'write', 'multiedit', 'grep', 'glob', 'notebookedit'])

function guessConnector(name: string): string {
  if (/thread|draft|label|message|mail/.test(name)) return 'mail'
  if (/spreadsheet|values|sheet|formula/.test(name)) return 'sheets'
  if (/presentation|slide/.test(name)) return 'slides'
  if (/doc/.test(name)) return 'docs'
  if (/file|drive/.test(name)) return 'drive'
  return 'connector'
}

function glyphFor(s: string): Glyph {
  if (/blender|3d|mesh|scene|unity|unreal|godot/.test(s)) return 'cube'
  if (/image|img|art|draw|paint|dall|sprite|photo|picture|figma|canva/.test(s)) return 'image'
  if (/mail|inbox|slack|discord|telegram|teams/.test(s)) return 'mail'
  if (/sheet|chart|data|sql|analytics|postgres|bigquery/.test(s)) return 'chart'
  if (/browser|chrome|web|fetch|search/.test(s)) return 'web'
  if (/terminal|shell|bash/.test(s)) return 'terminal'
  if (/doc|file|drive|slide|notion/.test(s)) return 'files'
  return 'plug'
}

export function groupOf(tool: string | undefined): ToolGroup | undefined {
  if (!tool) return undefined
  const low = tool.toLowerCase()
  if (SHELL.has(low) || low.startsWith('mcp__terminal__')) return { id: 'terminal', label: 'terminal', glyph: 'terminal' }
  if (low === 'webfetch' || low === 'websearch') return { id: 'web', label: 'web', glyph: 'web' }
  if (FILES.has(low)) return { id: 'files', label: 'files', glyph: 'files' }
  if (low.startsWith('mcp__') && !low.startsWith('mcp__ccd_')) {
    const parts = tool.split('__')
    const server = parts[1] ?? 'mcp'
    const name = parts.slice(2).join('__').toLowerCase()
    let label = server.replace(/^plugin_/i, '').replace(/^claude[_-]?/i, '').replace(/^in[_-]/i, '')
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(server)) label = guessConnector(name)
    label = cut((label || server).toLowerCase(), 12)
    return { id: 'mcp:' + server, label, glyph: glyphFor(label + ' ' + name) }
  }
  return undefined
}

export const isHandoff = (tool: string | undefined) => !!tool && HANDOFF.has(tool.toLowerCase())

/** Whether a tool call changes anything the crew draws. */
export const isShown = (tool: string) => isHandoff(tool) || groupOf(tool) !== undefined

export function toolLabel(tool: string): string {
  if (tool.startsWith('mcp__')) {
    const parts = tool.split('__')
    return parts[parts.length - 1] || tool
  }
  return tool
}

// ---------------------------------------------------------------------------
// State changes. Each returns the SAME object when nothing changed, so the
// caller can skip the write (and the redraw).
// ---------------------------------------------------------------------------

export function addLog(c: Crew, text: string, family: Family, at: number): Crew {
  return { ...c, log: [...c.log, { at, text, family }].slice(-LOG_MAX) }
}

function touchTool(c: Crew, g: ToolGroup, at: number): Crew {
  if (c.tools.some(t => t.id === g.id)) {
    return { ...c, tools: c.tools.map(t => (t.id === g.id ? { ...t, lastAt: at } : t)) }
  }
  let tools: CrewTool[] = [...c.tools, { ...g, firstAt: at, lastAt: at }]
  if (tools.length > TOOLS_MAX) {
    const inUse = new Set([c.lead.tool, ...c.agents.map(a => a.tool)].map(t => groupOf(t)?.id))
    const oldestIdle = [...tools].filter(t => t.id !== g.id && !inUse.has(t.id)).sort((a, b) => a.lastAt - b.lastAt)[0]
    if (oldestIdle) tools = tools.filter(t => t !== oldestIdle)
  }
  return { ...c, tools }
}

function withTool<T extends { tool?: string }>(x: T, tool: string | undefined): T {
  const rest = { ...x }
  delete rest.tool
  return tool === undefined ? rest : { ...rest, tool }
}

/** What a tool call looks like on the crew: built-ins by their group, an MCP tool by its own name. */
function shownAs(tool: string | undefined): string | undefined {
  if (tool === undefined) return undefined
  if (isHandoff(tool)) return 'handoff'
  const g = groupOf(tool)
  if (!g) return 'quiet:' + tool
  return g.id.startsWith('mcp:') ? tool : g.id
}

/** The short words for a tool in use: `files`, `terminal`, or an MCP tool's own name. */
export function toolWords(tool: string): string {
  const g = groupOf(tool)
  return g && !g.id.startsWith('mcp:') ? g.label : toolLabel(tool)
}

/** Shows (or, with `undefined`, clears) the tool the lead or one helper is using. */
export function showTool(c: Crew, agentId: string | undefined, tool: string | undefined, at: number): Crew {
  let name: string
  let family: Family
  let next: Crew
  if (agentId === undefined) {
    const busy = tool !== undefined || c.lead.busy
    if (shownAs(c.lead.tool) === shownAs(tool) && busy === c.lead.busy) return c
    name = c.lead.model
    family = c.lead.family
    next = { ...c, lead: { ...withTool(c.lead, tool), busy } }
  } else {
    const who = c.agents.find(a => a.id === agentId)
    if (!who || who.status !== 'working' || shownAs(who.tool) === shownAs(tool)) return c
    name = who.model
    family = who.family
    const now = withTool(who, tool)
    if (tool !== undefined) delete now.resting
    next = { ...c, agents: c.agents.map(a => (a.id === agentId ? now : a)) }
  }
  const g = groupOf(tool)
  if (!g || tool === undefined) return next
  const noted = touchTool(next, g, at)
  const text = `${name} → ${g.label}${g.id.startsWith('mcp:') ? ` (${toolLabel(tool)})` : ''}`
  return noted.log.slice(-3).some(l => l.text === text) ? noted : addLog(noted, text, family, at)
}

/** A new helper, or one that was resumed. */
export function addAgent(c: Crew, agent: CrewAgent, boss: string | undefined): Crew {
  const old = c.agents.find(a => a.id === agent.id)
  if (old) {
    if (old.status === 'working') return c
    const back: CrewAgent = { ...old, status: 'working', task: agent.task || old.task, startedAt: agent.startedAt }
    delete back.endedAt
    delete back.tool
    delete back.resting
    return addLog({ ...c, agents: c.agents.map(a => (a.id === agent.id ? back : a)) }, `${old.model} resumed: ${back.task}`, old.family, agent.startedAt)
  }
  const working = c.agents.filter(a => a.status === 'working')
  const done = c.agents.filter(a => a.status !== 'working').slice(-DONE_MAX)
  const agents = [...working, ...done, agent].sort((a, b) => a.startedAt - b.startedAt)
  return addLog({ ...c, agents }, `${boss ?? c.lead.model} → ${agent.model}: ${agent.task}`, agent.family, agent.startedAt)
}

export function finish(c: Crew, id: string, ok: boolean, at: number, calls?: number): Crew {
  const agent = c.agents.find(a => a.id === id)
  if (!agent || agent.status !== 'working') return c
  const ended: CrewAgent = { ...agent, status: ok ? 'done' : 'failed', endedAt: at, ...(calls ? { calls } : {}) }
  delete ended.tool
  delete ended.resting
  return addLog({ ...c, agents: c.agents.map(a => (a.id === id ? ended : a)) }, `${agent.model} ${ok ? 'finished' : 'stopped'}: ${agent.task}`, agent.family, at)
}

export function setResting(c: Crew, id: string, resting: boolean): Crew {
  const agent = c.agents.find(a => a.id === id)
  if (!agent || agent.status !== 'working' || !!agent.resting === resting) return c
  const next: CrewAgent = { ...agent }
  if (resting) next.resting = true
  else delete next.resting
  return { ...c, agents: c.agents.map(a => (a.id === id ? next : a)) }
}

export function setTokens(c: Crew, id: string, tokens: number): Crew {
  const agent = c.agents.find(a => a.id === id)
  if (!agent || tokens <= 0 || agent.tokens === tokens) return c
  return { ...c, agents: c.agents.map(a => (a.id === id ? { ...a, tokens } : a)) }
}

export function fmtTokens(n: number): string {
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : `${Math.round(n / 1000)}k`
}

export function setLead(c: Crew, busy: boolean, model?: string): Crew {
  const name = model ? prettyModel(model) : c.lead.model
  const family = model ? familyOf(model) : c.lead.family
  const keepTool = busy ? c.lead.tool : undefined
  if (c.lead.busy === busy && c.lead.model === name && c.lead.family === family && c.lead.tool === keepTool) return c
  const lead: CrewLead = { model: name, family, busy }
  if (keepTool !== undefined) lead.tool = keepTool
  return { ...c, lead }
}

/** Forgets every tool in use: for a fresh start, when nobody is left to say a call ended. */
export function dropTools(c: Crew): Crew {
  if (c.lead.tool === undefined && c.agents.every(a => a.tool === undefined)) return c
  return {
    ...c,
    lead: withTool(c.lead, undefined),
    agents: c.agents.map(a => (a.tool === undefined ? a : withTool(a, undefined))),
  }
}

/** A new conversation: the helpers still at work stay, the history goes. */
export function startOver(c: Crew): Crew {
  return {
    lead: { model: c.lead.model, family: c.lead.family, busy: false },
    agents: c.agents.filter(a => a.status === 'working'),
    tools: [],
    log: [],
  }
}

export function clearFinished(c: Crew): Crew {
  const agents = c.agents.filter(a => a.status === 'working')
  return agents.length === c.agents.length ? c : { ...c, agents }
}

// ---------------------------------------------------------------------------
// Small text helpers
// ---------------------------------------------------------------------------

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

export function cut(s: string, n: number): string {
  return s.length > n ? s.slice(0, Math.max(1, n - 1)) + '…' : s
}

function wrap(text: string, width: number, lines: number): string[] {
  const words = text.split(/\s+/).filter(Boolean)
  const out: string[] = []
  let line = ''
  let used = 0
  for (const word of words) {
    if (!line) line = word
    else if ((line + ' ' + word).length <= width) line += ' ' + word
    else {
      out.push(line)
      line = word
      if (out.length === lines) break
    }
    used++
  }
  if (out.length < lines && line) out.push(line)
  if (used < words.length && out.length) out[out.length - 1] = cut(out[out.length - 1] + ' …', width)
  return out.map(l => cut(l, width))
}

export function fmtDur(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`
}

export function ago(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000))
  if (s < 45) return 'now'
  const m = Math.round(s / 60)
  return m < 60 ? `${m}m` : `${Math.round(m / 60)}h`
}

function shade(hex: string, k: number): string {
  const n = parseInt(hex.slice(1), 16)
  const ch = (v: number) => Math.max(0, Math.min(255, Math.round(v * k)))
  return '#' + ((1 << 24) | (ch((n >> 16) & 255) << 16) | (ch((n >> 8) & 255) << 8) | ch(n & 255)).toString(16).slice(1)
}

// ---------------------------------------------------------------------------
// Pixel art. Each model family is its own creature on a 13-cell-wide grid:
// X body, o eyes, * spark.
// ---------------------------------------------------------------------------

type Shape = { body: string[]; legsA: string[]; legsB: string[] }

const FOUR_A = ['...X.X.X.X...', '...X.X.X.X...']
const FOUR_B = ['...X.X.X.X...', '..X..X.X..X..']
const ROBOT: Shape = {
  body: ['......X......', '.....XXX.....', '..XXXXXXXXX..', '..XoooooooX..', '..XXXXXXXXX..', 'XXXXXXXXXXXXX', '..XXXXXXXXX..'],
  legsA: ['...X.....X...', '...X.....X...'],
  legsB: ['...X.....X...', '..X.......X..'],
}

const SHAPES: Record<Family, Shape> = {
  opus: {
    body: ['..XXXXXXXXX..', '..XXoXXXoXX..', 'XXXXoXXXoXXXX', '..XXXXXXXXX..', '..XXXXXXXXX..'],
    legsA: FOUR_A,
    legsB: FOUR_B,
  },
  sonnet: {
    body: ['...X.....X...', '...X.....X...', '..XXXXXXXXX..', '.XXXoXXXoXXX.', 'XXXXoXXXoXXXX', '.XXXXXXXXXXX.', '..XXXXXXXXX..'],
    legsA: ['...XX...XX...', '...XX...XX...'],
    legsB: ['...XX...XX...', '..XX.....XX..'],
  },
  haiku: {
    body: ['...XXXXXXX...', '...XoXXXoX...', '..XXoXXXoXX..', '...XXXXXXX...'],
    legsA: ['...X.X.X.X...'],
    legsB: ['....X.X.X....'],
  },
  fable: {
    body: ['......*......', '.....***.....', '......*......', '..XXXXXXXXX..', '..XXoXXXoXX..', 'XXXXoXXXoXXXX', '..XXXXXXXXX..', '..XXXXXXXXX..'],
    legsA: FOUR_A,
    legsB: FOUR_B,
  },
  gpt: ROBOT,
  other: ROBOT,
}

const CELLS = 13

function cells(rows: string[], ch: string, x0: number, y0: number, px: number, fill: string, h = px): string {
  const out: string[] = []
  rows.forEach((row, r) => {
    let start = -1
    for (let i = 0; i <= row.length; i++) {
      const on = row[i] === ch
      if (on && start < 0) start = i
      if (!on && start >= 0) {
        out.push(`<rect x="${x0 + start * px}" y="${y0 + r * px}" width="${(i - start) * px}" height="${h}" fill="${fill}"/>`)
        start = -1
      }
    }
  })
  return out.join('')
}

type Mode = 'working' | 'idle' | 'dim'

/** One creature standing on `baseY`, centered on `cx`. */
function creature(family: Family, cx: number, baseY: number, px: number, mode: Mode, seed: number): string {
  const s = SHAPES[family]
  const color = COLOR[family]
  const x0 = cx - (CELLS * px) / 2
  const y0 = baseY - (s.body.length + s.legsA.length) * px
  const legY = y0 + s.body.length * px
  const working = mode === 'working'
  const dark = shade(color, 0.68)
  // a lighter strip along every open top edge of the body
  const top = s.body.map((row, r) =>
    row
      .split('')
      .map((c, i) => (c === 'X' && (r === 0 || s.body[r - 1]?.[i] !== 'X') ? 'T' : '.'))
      .join(''),
  )
  const blink = (3.2 + (seed % 4) * 0.7).toFixed(1)
  const parts = [
    cells(s.body, 'X', x0, y0, px, color),
    cells(top, 'T', x0, y0, px, shade(color, 1.2), Math.max(1, Math.round(px / 3))),
    cells(s.body, 'o', x0, y0, px, BG),
    `<g opacity="0">${cells(s.body, 'o', x0, y0, px, color)}<animate attributeName="opacity" values="0;0;1;0" keyTimes="0;0.92;0.96;1" dur="${blink}s" repeatCount="indefinite"/></g>`,
  ]
  if (s.body.some(r => r.includes('*'))) {
    const pulse = working ? `<animate attributeName="opacity" values="1;0.35;1" dur="1.6s" repeatCount="indefinite"/>` : ''
    parts.push(`<g>${cells(s.body, '*', x0, y0, px, INK)}${pulse}</g>`)
  }
  const legs = working
    ? `<g>${cells(s.legsA, 'X', x0, legY, px, dark)}<animate attributeName="opacity" values="1;0" dur="0.5s" calcMode="discrete" repeatCount="indefinite"/></g>` +
      `<g opacity="0">${cells(s.legsB, 'X', x0, legY, px, dark)}<animate attributeName="opacity" values="0;1" dur="0.5s" calcMode="discrete" repeatCount="indefinite"/></g>`
    : cells(s.legsA, 'X', x0, legY, px, dark)
  const bob = working
    ? `<animateTransform attributeName="transform" type="translate" values="0 0;0 ${-Math.max(1, Math.round(px / 2))};0 0" dur="0.5s" repeatCount="indefinite"/>`
    : ''
  return `<g opacity="${mode === 'dim' ? 0.5 : 1}"><g>${bob}${parts.join('')}${legs}</g></g>`
}

const creatureHeight = (family: Family, px: number) => (SHAPES[family].body.length + SHAPES[family].legsA.length) * px

const pixelRows = (rows: string[], x0: number, y0: number, px: number, fill: string) => cells(rows, 'X', x0, y0, px, fill)

const GLYPHS: Record<Glyph, string[]> = {
  terminal: ['.......', 'X......', '.X.....', '..X....', '.X.....', 'X..XXX.', '.......'],
  web: ['..XXX..', '.X.X.X.', 'XXXXXXX', 'X..X..X', 'XXXXXXX', '.X.X.X.', '..XXX..'],
  files: ['.XXXX..', '.X..XX.', '.X...X.', '.X.XXX.', '.X...X.', '.X.XXX.', '.XXXXX.'],
  cube: ['..XXX..', '.X...X.', 'XXXXXXX', 'X..X..X', 'X..X..X', '.X.X.X.', '..XXX..'],
  image: ['XXXXXXX', 'X.....X', 'X.X...X', 'X...X.X', 'X..XXXX', 'X.XXXXX', 'XXXXXXX'],
  mail: ['.......', 'XXXXXXX', 'XX...XX', 'X.X.X.X', 'X..X..X', 'XXXXXXX', '.......'],
  chart: ['X......', 'X....X.', 'X.X..X.', 'X.X.XX.', 'XXX.XX.', 'XXXXXXX', '.......'],
  plug: ['.X.X...', '.X.X...', 'XXXXX..', 'XXXXX..', '.XXX...', '..X....', '..XXXXX'],
}

const CHEV_L = ['..X', '.X.', 'X..', '.X.', '..X']
const CHEV_R = ['X..', '.X.', '..X', '.X.', 'X..']
const SPARK = ['.X.', 'XXX', '.X.']
const CROSS = ['X.X', '.X.', 'X.X']

function corners(x: number, y: number, w: number, h: number, color: string, len = 7): string {
  const p = (d: string) => `<path d="${d}" fill="none" stroke="${color}" stroke-width="1.5"/>`
  return (
    p(`M ${x} ${y + len} V ${y} H ${x + len}`) +
    p(`M ${x + w - len} ${y} H ${x + w} V ${y + len}`) +
    p(`M ${x} ${y + h - len} V ${y + h} H ${x + len}`) +
    p(`M ${x + w - len} ${y + h} H ${x + w} V ${y + h - len}`)
  )
}

/** A dotted trace; a live one flows toward its end. */
function flow(d: string, color: string, live: boolean): string {
  if (!live) return `<path d="${d}" fill="none" stroke="${LINE}" stroke-width="1" stroke-dasharray="1 5"/>`
  return `<path d="${d}" fill="none" stroke="${color}" stroke-width="1.6" stroke-dasharray="2 5" stroke-linecap="square"><animate attributeName="stroke-dashoffset" values="14;0" dur="0.7s" repeatCount="indefinite"/></path>`
}

/** A small arrowhead pointing down at (x, y). */
const arrow = (x: number, y: number, color: string) => `<path d="M ${x - 3.5} ${y - 5} H ${x + 3.5} L ${x} ${y} Z" fill="${color}"/>`

/** A packet that runs a trace once: work handed down, or a report coming back. */
function packet(d: string, color: string, back: boolean): string {
  const way = back ? ` keyPoints="1;0" keyTimes="0;1" calcMode="linear"` : ''
  return `<rect x="-3" y="-3" width="6" height="6" fill="${INK}" stroke="${color}" stroke-width="1.5"><animateMotion path="${d}" dur="1.2s"${way} fill="freeze"/><animate attributeName="opacity" values="1;1;0" keyTimes="0;0.9;1" dur="1.3s" fill="freeze"/></rect>`
}

// ---------------------------------------------------------------------------
// Layout: sized from the pane's own width, so text is drawn 1:1
// ---------------------------------------------------------------------------

export type Layout = {
  W: number
  H: number
  cx: number
  cy: number
  r: number
  px: number
  labelY: number
  statusY: number
  busY: number
  panelTop: number
  helperBottom: number
  toolBusY: number
  toolTop: number
  maxHelpers: number
  maxTools: number
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))

export function layoutFor(columns: number): Layout {
  const W = Math.round(clamp(columns * 8, 340, 880))
  const big = W >= 460
  const r = big ? 54 : 46
  const cy = 40 + r
  const labelY = cy + r + 22
  const statusY = labelY + 14
  const busY = statusY + 18
  const panelTop = busY + 36
  const helperBottom = panelTop + 100
  const toolBusY = helperBottom + 10
  const toolTop = toolBusY + 19
  return {
    W,
    H: toolTop + 34 + 30,
    cx: W / 2,
    cy,
    r,
    px: big ? 5 : 4,
    labelY,
    statusY,
    busY,
    panelTop,
    helperBottom,
    toolBusY,
    toolTop,
    maxHelpers: clamp(Math.floor((W - 32) / 88), 2, 8),
    maxTools: clamp(Math.floor((W - 52) / 70), 3, 8),
  }
}

const spread = (n: number, cx: number, slot: number) => Array.from({ length: n }, (_, i) => cx + (i - (n - 1) / 2) * slot)

/** The helpers that get a spot: everyone working first, then the latest finished. */
export function visibleHelpers(c: Crew, max: number): CrewAgent[] {
  const working = c.agents.filter(a => a.status === 'working').slice(-max)
  const done = c.agents
    .filter(a => a.status !== 'working')
    .sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))
    .slice(0, Math.max(0, max - working.length))
  return [...working, ...done].sort((a, b) => a.startedAt - b.startedAt)
}

function visibleTools(c: Crew, max: number): CrewTool[] {
  return [...c.tools]
    .sort((a, b) => b.lastAt - a.lastAt)
    .slice(0, max)
    .sort((a, b) => a.firstAt - b.firstAt)
}

// ---------------------------------------------------------------------------
// The crew, as one SVG
// ---------------------------------------------------------------------------

export function crewSvg(c: Crew, L: Layout, now: number): string {
  const { W, H, cx, cy, r } = L
  const helpers = visibleHelpers(c, L.maxHelpers)
  const hSlot = Math.min(112, (W - 32) / Math.max(1, helpers.length))
  const hx = spread(helpers.length, cx, hSlot)
  const tools = visibleTools(c, L.maxTools)
  const tx = spread(tools.length, cx, Math.min(84, (W - 52) / Math.max(1, tools.length)))
  const lead = c.lead
  const leadColor = COLOR[lead.family]
  const working = c.agents.filter(a => a.status === 'working')
  const unseen = working.filter(a => !helpers.includes(a)).length
  const idle: string[] = []
  const live: string[] = []
  const front: string[] = []

  // work handed down: lead → helper, or helper → its own helper
  const dropEnd = L.panelTop - 20
  helpers.forEach((a, i) => {
    const x = hx[i] ?? cx
    const color = COLOR[a.family]
    const pi = a.parentId ? helpers.findIndex(h => h.id === a.parentId) : -1
    const d =
      pi >= 0
        ? `M ${(hx[pi] ?? cx) + 12} ${dropEnd} V ${L.busY + 8} H ${x} V ${dropEnd}`
        : `M ${cx} ${L.statusY + 7} V ${L.busY} H ${x} V ${dropEnd}`
    const isWorking = a.status === 'working' && !a.resting
    if (isWorking) live.push(flow(d, color, true), arrow(x, dropEnd + 2, color))
    else idle.push(flow(d, color, false))
    if (a.status === 'working' && now - a.startedAt < FRESH) live.push(packet(d, color, false))
    if (a.status !== 'working' && a.endedAt !== undefined && now - a.endedAt < FRESH) live.push(packet(d, color, true))
  })

  // whoever is using a tool → that tool's node
  const toolAt = new Map(tools.map((t, i) => [t.id, i]))
  const users = new Map<string, Family[]>()
  const use = (tool: string | undefined, family: Family, path: (x: number) => string) => {
    const g = groupOf(tool)
    const i = g ? toolAt.get(g.id) : undefined
    if (!g || i === undefined) return
    const x = tx[i] ?? cx
    live.push(flow(path(x), COLOR[family], true), arrow(x, L.toolTop - 1, COLOR[family]))
    users.set(g.id, [...(users.get(g.id) ?? []), family])
  }
  if (lead.busy) use(lead.tool, lead.family, x => `M ${cx + r + 40} ${cy} H ${W - 9} V ${L.toolBusY + 5} H ${x} V ${L.toolTop - 5}`)
  helpers.forEach((a, i) => {
    if (a.status === 'working') use(a.tool, a.family, x => `M ${hx[i] ?? cx} ${L.helperBottom} V ${L.toolBusY} H ${x} V ${L.toolTop - 5}`)
  })

  // the lead
  const busy = lead.busy
  const spin = busy
    ? `<animateTransform attributeName="transform" type="rotate" values="0 ${cx} ${cy};360 ${cx} ${cy}" dur="30s" repeatCount="indefinite"/>`
    : ''
  const chev = (rows: string[], x: number, dx: number) =>
    `<g>${pixelRows(rows, x, cy - 7.5, 3, busy ? leadColor : FAINT)}${busy ? `<animateTransform attributeName="transform" type="translate" values="0 0;${dx} 0;0 0" dur="1.4s" repeatCount="indefinite"/>` : ''}</g>`
  const sparks = (
    [
      [-r - 10, -r + 4],
      [r + 6, -r + 8],
      [-r - 6, r - 6],
      [r + 8, r - 10],
    ] as const
  )
    .map(
      ([dx, dy], i) =>
        `<g>${pixelRows(SPARK, cx + dx, cy + dy, 2, busy ? leadColor : FAINT)}<animate attributeName="opacity" values="1;0.2;1" dur="${(1.8 + i * 0.4).toFixed(1)}s" repeatCount="indefinite"/></g>`,
    )
    .join('')
  const status = !busy
    ? 'waiting for you'
    : isHandoff(lead.tool)
      ? 'handing out work…'
      : lead.tool && groupOf(lead.tool)
        ? `⚙ ${cut(toolWords(lead.tool), 30)}`
        : 'thinking…'
  front.push(
    `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${BG}" stroke="${leadColor}" stroke-opacity="0.75" stroke-width="1.6" stroke-dasharray="1.6 6">${spin}</circle>`,
    `<circle cx="${cx}" cy="${cy}" r="${r + 10}" fill="none" stroke="${FAINT}" stroke-opacity="0.6" stroke-width="1" stroke-dasharray="1 10"/>`,
    chev(CHEV_L, cx - r - 32, -4),
    chev(CHEV_R, cx + r + 23, 4),
    sparks,
    creature(lead.family, cx, cy + creatureHeight(lead.family, L.px) / 2, L.px, busy ? 'working' : 'idle', 1),
    `<text x="${cx}" y="${L.labelY}" text-anchor="middle" font-size="11.5" font-weight="700" fill="${leadColor}">${esc(lead.model.toUpperCase())}<tspan fill="${MUTED}" font-weight="400"> · lead</tspan></text>`,
    `<text x="${cx}" y="${L.statusY}" text-anchor="middle" font-size="10" fill="${busy ? INK : MUTED}">${esc(status)}</text>`,
  )

  // the helpers
  if (!helpers.length) {
    const w = Math.min(300, W - 40)
    front.push(
      `<rect x="${cx - w / 2}" y="${L.panelTop + 6}" width="${w}" height="46" fill="none" stroke="${LINE}" stroke-dasharray="2 4"/>`,
      `<text x="${cx}" y="${L.panelTop + 26}" text-anchor="middle" font-size="10" fill="${MUTED}">no helpers yet</text>`,
      `<text x="${cx}" y="${L.panelTop + 40}" text-anchor="middle" font-size="9" fill="${MID}">when the lead hands off work, its crew shows up here</text>`,
    )
  }
  const chars = Math.max(10, Math.floor((hSlot - 6) / 5.8))
  helpers.forEach((a, i) => {
    const x = hx[i] ?? cx
    const color = COLOR[a.family]
    const isWorking = a.status === 'working'
    const awake = isWorking && !a.resting
    const top = L.panelTop
    const dur = a.endedAt !== undefined ? fmtDur(a.endedAt - a.startedAt) : ''
    const calls = a.calls ? ` · ${a.calls} call${a.calls === 1 ? '' : 's'}` : ''
    const meta = !isWorking
      ? a.status === 'failed'
        ? `stopped · ${dur}`
        : `${dur}${calls}`
      : a.resting
        ? 'waiting'
        : a.tool && groupOf(a.tool)
          ? `⚙ ${toolWords(a.tool)}`
          : 'thinking…'
    const mark =
      a.status === 'failed'
        ? `<text x="${x + 25}" y="${top + 11}" font-size="10" fill="${RED}">✗</text>`
        : a.status === 'done'
          ? `<text x="${x + 24}" y="${top + 11}" font-size="10" fill="${MUTED}">✓</text>`
          : ''
    front.push(
      `<rect x="${x - 34}" y="${top}" width="68" height="54" fill="${PANEL}"/>`,
      corners(x - 34, top, 68, 54, awake ? color : LINE),
      `<text x="${x}" y="${top - 7}" text-anchor="middle" font-size="9.5" font-weight="700" fill="${isWorking ? color : MID}">${esc(cut(a.model.toUpperCase(), chars))}</text>`,
      mark,
      creature(a.family, x, top + 47, 3, awake ? 'working' : isWorking ? 'idle' : 'dim', i + 2),
      wrap(a.task, chars, 2)
        .map((l, j) => `<text x="${x}" y="${top + 68 + j * 12}" text-anchor="middle" font-size="9.5" fill="${isWorking ? INK : MUTED}">${esc(l)}</text>`)
        .join(''),
      `<text x="${x}" y="${top + 94}" text-anchor="middle" font-size="8.5" fill="${awake && a.tool && groupOf(a.tool) ? color : MID}">${esc(cut(meta, chars + 2))}</text>`,
    )
  })

  // tools and MCP servers
  if (!tools.length) {
    front.push(
      `<text x="${cx}" y="${L.toolTop + 20}" text-anchor="middle" font-size="9" fill="${MID}">${W < 400 ? 'tools and MCP servers show up here' : 'tools and MCP servers light up here as the crew uses them'}</text>`,
    )
  }
  tools.forEach((t, i) => {
    const x = tx[i] ?? cx
    const who = users.get(t.id) ?? []
    const first = who[0]
    const color = first ? COLOR[first] : LINE
    const glow = first ? `<animate attributeName="stroke-opacity" values="1;0.35;1" dur="1s" repeatCount="indefinite"/>` : ''
    front.push(
      `<rect x="${x - 22}" y="${L.toolTop}" width="44" height="34" rx="3" fill="${PANEL}" stroke="${color}" stroke-width="${first ? 1.6 : 1}">${glow}</rect>`,
      pixelRows(GLYPHS[t.glyph], x - 10.5, L.toolTop + 6.5, 3, first ? color : FAINT),
      who
        .slice(0, 3)
        .map((f, k) => `<rect x="${x + 15 - k * 6}" y="${L.toolTop + 27}" width="4" height="4" fill="${COLOR[f]}"/>`)
        .join(''),
      `<text x="${x}" y="${L.toolTop + 48}" text-anchor="middle" font-size="9.5" fill="${first ? INK : MUTED}">${esc(t.label)}</text>`,
    )
  })

  const done = c.agents.length - working.length
  const tally = `${working.length} working · ${done} done`
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="100%" font-family="ui-monospace, 'Cascadia Mono', Consolas, Menlo, monospace" shape-rendering="crispEdges">
<defs><pattern id="crew-dots" width="16" height="16" patternUnits="userSpaceOnUse"><rect x="7" y="7" width="1.5" height="1.5" fill="${DOT}"/></pattern></defs>
<rect width="${W}" height="${H}" fill="${BG}"/>
<rect width="${W}" height="${H}" fill="url(#crew-dots)"/>
<text x="16" y="22" font-size="12" font-weight="700" fill="${INK}">✻ agent crew</text>
<text x="${W - 16}" y="22" text-anchor="end" font-size="10" fill="${MUTED}">${tally}</text>
${unseen ? `<text x="${W - 16}" y="35" text-anchor="end" font-size="9" fill="${MID}">+${unseen} more working, listed below</text>` : ''}
${pixelRows(CROSS, 16, H - 22, 2, FAINT)}${pixelRows(CROSS, W - 22, H - 22, 2, FAINT)}
${idle.join('\n')}
${live.join('\n')}
${front.join('\n')}
</svg>`
}

/** The lead and whoever is working, side by side: the band's icon and the widget. */
export function paradeSvg(c: Crew, px: number, max: number): { source: string; width: number; height: number } {
  const working = c.agents.filter(a => a.status === 'working').slice(-max)
  const cw = CELLS * px
  const gap = 3 * px
  const height = 10 * px + 2
  const width = cw + (working.length ? gap + working.length * (cw + gap) : 0)
  const parts = [creature(c.lead.family, cw / 2, height, px, c.lead.busy ? 'working' : 'idle', 0)]
  if (working.length) parts.push(`<rect x="${cw + gap - px / 2}" y="${height - 4 * px}" width="${px}" height="${px}" fill="${FAINT}"/>`)
  working.forEach((a, i) => {
    parts.push(creature(a.family, cw + gap * 2 + i * (cw + gap) + cw / 2 - gap / 2, height, px, a.resting ? 'idle' : 'working', i + 1))
  })
  return {
    source: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" shape-rendering="crispEdges">${parts.join('')}</svg>`,
    width,
    height,
  }
}
