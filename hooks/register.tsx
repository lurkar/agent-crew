import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Crew, CrewAgent } from '../types'
import {
  COLOR,
  EMPTY,
  addAgent,
  ago,
  clearFinished,
  crewSvg,
  cut,
  dropTools,
  familyOf,
  finish,
  fmtDur,
  fmtTokens,
  groupOf,
  isShown,
  layoutFor,
  paradeSvg,
  prettyModel,
  setLead,
  setResting,
  setTokens,
  showTool,
  startOver,
  toolWords,
  visibleHelpers,
} from './draw'

const PANE = 'agent-crew'
const TITLE = 'Agent Crew'
const HIDDEN_KEY = 'pane-hidden'

/** How often the crew checks on its helpers, while any are at work. */
const TICK = 5000
/** How long a finished tool call stays lit: quick calls get seen, a run of them does not flicker. */
const LINGER = 2500
/** Ticks a helper nobody lists may stay silent before it is drawn resting, and before it is let go. */
const QUIET_REST = 36
const QUIET_END = 360

const crew = atom({ plugin: 'agent-crew', key: 'crew' } as const, EMPTY, { shape: 'crew-1' })
const isOpen = atom({ plugin: 'agent-crew', key: 'isOpen' } as const, false)

// ---------------------------------------------------------------------------
// The module's own memory. A reload starts it over, which costs a detail or two.
// ---------------------------------------------------------------------------

type Stop = { cancel: () => void }

/** The main loop's key in the maps below; a helper's is its id. */
const LEAD = ''

let chain: Promise<void> = Promise.resolve()
let mirror: Crew | undefined
let ticker: Stop | undefined
let ticks = 0
let callSeq = 0
/** Tool calls under way, by who makes them. */
const flights = new Map<string, Map<string, string>>()
/** The timer that puts out a finished call's light. */
const fading = new Map<string, Stop>()
const calls = new Map<string, number>()
/** Helpers `$.agent.list()` has named, and how many ticks each has been missing or silent. */
const listed = new Set<string>()
const quiet = new Map<string, number>()

/**
 * Drawing work never stands in a hook's way: a hook queues it here and moves on.
 * One piece runs at a time, in order, and a failed one is dropped.
 */
function later(work: () => Promise<void>): void {
  chain = chain.then(work).catch(() => {})
}

/** Applies a change to the crew, and writes only when something really changed. */
async function apply($: EngineInterface, fn: (c: Crew, now: number) => Crew): Promise<void> {
  const cur = mirror ?? (await read($, crew))
  mirror = cur
  const next = fn(cur, await $.clock.now())
  if (next === cur) return
  await update($, crew, () => next)
  mirror = next
  if (next.agents.some(a => a.status === 'working')) watch($)
}

function change($: EngineInterface, fn: (c: Crew, now: number) => Crew): void {
  later(() => apply($, fn))
}

function forget(id: string): void {
  flights.delete(id)
  fading.get(id)?.cancel()
  fading.delete(id)
  calls.delete(id)
  listed.delete(id)
  quiet.delete(id)
}

function ended(c: Crew, id: string, ok: boolean, now: number): Crew {
  const next = finish(c, id, ok, now, calls.get(id))
  forget(id)
  return next
}

/** Checks on the helpers while any are at work, and rests when none are. */
function watch($: EngineInterface): void {
  if (ticker) return
  ticks = 0
  ticker = $.clock.every(TICK, () => later(() => tick($)))
}

async function tick($: EngineInterface): Promise<void> {
  const cur = mirror ?? (await read($, crew))
  mirror = cur
  const working = cur.agents.filter(a => a.status === 'working')
  if (!working.length) {
    ticker?.cancel()
    ticker = undefined
    return
  }
  const roster = new Map((await $.agent.list()).map(a => [a.id, a]))
  const now = await $.clock.now()
  let next = cur
  for (const a of working) {
    const info = roster.get(a.id)
    if (info === undefined) {
      const silent = (quiet.get(a.id) ?? 0) + 1
      quiet.set(a.id, silent)
      // Once listed and now gone: it ended and its report never came.
      if (listed.has(a.id) ? silent >= 2 : silent >= QUIET_END) next = ended(next, a.id, true, now)
      else if (!listed.has(a.id)) next = setResting(next, a.id, silent >= QUIET_REST)
      continue
    }
    listed.add(a.id)
    quiet.delete(a.id)
    const s = info.status
    next = setTokens(next, a.id, Math.round(info.tokenCount / 1000) * 1000)
    if (s === 'completed') next = ended(next, a.id, true, now)
    else if (s === 'failed' || s === 'killed') next = ended(next, a.id, false, now)
    else next = setResting(next, a.id, s !== 'running')
  }
  if (next !== cur) {
    await update($, crew, () => next)
    mirror = next
  } else if (++ticks % 6 === 0) {
    // nothing changed, but "2m ago" should move on
    await $.ui.invalidate('ui.render')
  }
}

function began($: EngineInterface, who: string, id: string, tool: string): void {
  let mine = flights.get(who)
  if (!mine) flights.set(who, (mine = new Map()))
  mine.set(id, tool)
  fading.get(who)?.cancel()
  fading.delete(who)
  change($, (c, now) => showTool(c, who || undefined, tool, now))
}

function landed($: EngineInterface, who: string, id: string): void {
  const mine = flights.get(who)
  mine?.delete(id)
  const still = mine ? [...mine.values()].pop() : undefined
  if (still !== undefined) {
    change($, (c, now) => showTool(c, who || undefined, still, now))
    return
  }
  fading.get(who)?.cancel()
  fading.set(
    who,
    $.clock.after(LINGER, () => {
      fading.delete(who)
      if (flights.get(who)?.size) return
      change($, (c, now) => showTool(c, who || undefined, undefined, now))
    }),
  )
}

// ---------------------------------------------------------------------------
// Showing and hiding the pane
// ---------------------------------------------------------------------------

async function isUp($: EngineInterface): Promise<boolean> {
  return (await $.ui.panes()).some(p => p.id === PANE && p.isPlaced)
}

/** Sets the switch from where the pane really stands. */
async function syncOpen($: EngineInterface): Promise<boolean> {
  const shown = await isUp($)
  await update($, isOpen, () => shown)
  return shown
}

async function toggle($: EngineInterface): Promise<boolean> {
  const show = !(await isUp($))
  if (show) await $.ui.open({ id: PANE, title: TITLE })
  else await $.ui.close({ id: PANE })
  await $.store.set(HIDDEN_KEY, !show)
  return syncOpen($)
}

function stateWords(a: CrewAgent, now: number): string {
  const used = a.tokens ? ` · ${fmtTokens(a.tokens)} tokens` : ''
  if (a.status === 'failed') return `stopped after ${fmtDur((a.endedAt ?? now) - a.startedAt)}${used}`
  if (a.status === 'done') {
    const made = a.calls ? `, ${a.calls} tool call${a.calls === 1 ? '' : 's'}` : ''
    return `done in ${fmtDur((a.endedAt ?? now) - a.startedAt)}${made}${used}`
  }
  if (a.resting) return `waiting${used}`
  return `working ${fmtDur(now - a.startedAt)}${used}${a.tool && groupOf(a.tool) ? ` · ⚙ ${toolWords(a.tool)}` : ''}`
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'crew', description: 'Show or hide the Agent Crew pane' })
    // Nobody is mid-call when a session (or a reload) starts.
    later(async () => {
      const model = await $.session.model().catch(() => undefined)
      await apply($, c => dropTools(setLead(c, false, model)))
    })
    later(async () => {
      const hidden = (await $.store.get(HIDDEN_KEY)) === true
      const up = (await $.ui.panes()).some(p => p.id === PANE)
      // Opens by itself unless the person hid it; a phone has no room for it unasked.
      // An app that attaches later starts with no surface, and seats the pane when it does.
      if (!up && !hidden && e.surface !== 'mobile') await $.ui.open({ id: PANE, title: TITLE })
      await syncOpen($)
    })
    later(async () => {
      const cur = mirror ?? (await read($, crew))
      if (cur.agents.some(a => a.status === 'working')) watch($)
    })
    return next(e)
  })

  // An app joined: the pane may have just been seated, so set the switch again.
  on('session.attach', ($, e, next) => {
    later(async () => {
      await syncOpen($)
    })
    return next(e)
  })

  on('session.end', ($, e, next) => {
    if (e.reason === 'clear') change($, c => startOver(c))
    return next(e)
  })

  on('command.run', { command: 'crew' }, async $ => {
    const shown = await toggle($)
    return { text: shown ? 'Agent Crew shown.' : 'Agent Crew hidden. Type /crew to show it again.' }
  })

  on('ui.close', async ($, e, next) => {
    const result = await next(e)
    if (e.id === PANE) {
      later(async () => {
        if (e.origin.kind === 'person') await $.store.set(HIDDEN_KEY, true)
        await syncOpen($)
      })
    }
    return result
  }).catch(($, e, next) => next(e))

  on('turn.start', ($, e, next) => {
    if (e.agentId === undefined) {
      later(async () => {
        const model = await $.session.model().catch(() => undefined)
        await apply($, c => setLead(c, true, model))
      })
    } else {
      quiet.delete(e.agentId)
    }
    return next(e)
  })

  on('turn.complete', ($, e, next) => {
    if (e.agentId === undefined) {
      flights.delete(LEAD)
      fading.get(LEAD)?.cancel()
      fading.delete(LEAD)
      change($, c => setLead(c, false))
    } else {
      quiet.delete(e.agentId)
    }
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const tool = String(e.tool)
    const who = e.agentId ?? LEAD
    if (who) {
      calls.set(who, (calls.get(who) ?? 0) + 1)
      quiet.delete(who)
    }
    if (!isShown(tool)) return next(e)
    const id = e.tool_use_id || `call-${++callSeq}`
    began($, who, id, tool)
    try {
      return await next(e)
    } finally {
      landed($, who, id)
    }
  }).catch(($, e, next) => next(e))

  on('agent.spawn', async ($, e, next) => {
    const result = await next(e)
    if (result.deny !== undefined || !result.agentId) return result
    const id = result.agentId
    const raw = result.model || e.model || e.parentModel
    quiet.delete(id)
    change($, (c, now) => {
      const agent: CrewAgent = {
        id,
        model: prettyModel(raw),
        family: familyOf(raw),
        task: e.description || e.subagentType,
        type: e.subagentType,
        status: 'working',
        ...(e.parentAgentId ? { parentId: e.parentAgentId } : {}),
        startedAt: now,
      }
      const boss = e.parentAgentId ? (c.agents.find(a => a.id === e.parentAgentId)?.model ?? 'Helper') : undefined
      return addAgent(c, agent, boss)
    })
    return result
  }).catch(($, e, next) => next(e))

  on('agent.report', async ($, e, next) => {
    const result = await next(e)
    change($, (c, now) => ended(c, e.agentId, e.status === 'completed', now))
    return result
  }).catch(($, e, next) => next(e))

  // The pane
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const c = await read($, crew)
    const now = await $.clock.now()
    const working = c.agents.filter(a => a.status === 'working')
    const recent = c.log.slice(-6).reverse()

    if (e.surface === 'terminal') {
      const { Box, Text } = $.ui.resolve(e)
      return (
        <Box flexDirection="column">
          <Text bold>
            ✻ {c.lead.model} leading · {working.length} working
          </Text>
          {c.agents.length === 0 && <Text dimColor>No helpers yet.</Text>}
          {visibleHelpers(c, 10).map(a => (
            <Text dimColor={a.status !== 'working'}>
              {a.status === 'working' ? (a.resting ? '○' : '●') : a.status === 'failed' ? '✗' : '✓'} {a.model}: {cut(a.task, 40)}
              {a.status === 'working' && a.tool && groupOf(a.tool) ? ` [${toolWords(a.tool)}]` : ''}
            </Text>
          ))}
          {c.tools.length > 0 && <Text dimColor>tools: {c.tools.map(t => t.label).join(', ')}</Text>}
          {recent.map(l => (
            <Text dimColor>
              {ago(l.at, now)} {l.text}
            </Text>
          ))}
        </Box>
      )
    }

    const { Box, Text, Svg, Button } = $.ui.resolve(e)
    const alt = `Agent crew. ${c.lead.model} leading, ${working.length} helpers working. ${working.map(a => `${a.model}: ${a.task}`).join('; ')}`

    if (e.props.placement === 'widget') {
      const parade = paradeSvg(c, 3, 4)
      return (
        <Box flexDirection="column">
          <Svg source={parade.source} alt={alt} width={parade.width} height={parade.height} />
          <Text bold>{c.lead.model} leading</Text>
          <Text dimColor>{working.length ? working.map(a => a.model).join(', ') + ' working' : 'no helpers working'}</Text>
        </Box>
      )
    }

    const L = layoutFor(e.props.bodyColumns)
    const rows = visibleHelpers(c, 12)
    return (
      <Box flexDirection="column">
        <Svg source={crewSvg(c, L, now)} alt={alt} isInteractive width={L.W} height={L.H} />
        {rows.length > 0 && <Text bold>Helpers</Text>}
        {rows.map(a => (
          <Text dimColor={a.status !== 'working'}>
            <Text color={COLOR[a.family]}>■ </Text>
            {a.model} · {stateWords(a, now)} · {cut(a.task, 90)}
          </Text>
        ))}
        <Text bold>Activity</Text>
        {recent.length === 0 && <Text dimColor>Nothing yet. Handoffs and tool use show up here.</Text>}
        {recent.map(l => (
          <Text>
            <Text color={COLOR[l.family]}>■ </Text>
            <Text dimColor>{ago(l.at, now)} </Text>
            {cut(l.text, 96)}
          </Text>
        ))}
        {c.agents.some(a => a.status !== 'working') && (
          <Button key="clear" label="Clear finished helpers" onPress={() => change($, cur => clearFinished(cur))} />
        )}
      </Box>
    )
  })

  // The band above the prompt: the crew at a glance, and the show/hide switch
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const c = await read($, crew)
    const open = await read($, isOpen)
    const working = c.agents.filter(a => a.status === 'working')
    const crewWords =
      working.length === 0
        ? ''
        : working.length <= 2
          ? ` · ${working.map(a => a.model).join(', ')} working`
          : ` · ${working.length} helpers working`
    const words = `${c.lead.model} leading${crewWords}`
    const label = open ? 'Hide crew' : 'Show crew'
    const press = async () => {
      await toggle($)
    }
    if (e.surface === 'terminal') {
      const { Box, Text, Button } = $.ui.resolve(e)
      return (
        <Box>
          <Text dimColor>✻ {words} </Text>
          <Button key="toggle" label={label} onPress={press} />
        </Box>
      )
    }
    const { Box, Text, Button, Svg } = $.ui.resolve(e)
    const parade = paradeSvg(c, 2, 5)
    return (
      <Box alignItems="center">
        <Svg source={parade.source} alt="crew" width={parade.width} height={parade.height} />
        <Text dimColor> {words} </Text>
        <Button key="toggle" label={label} onPress={press} />
      </Box>
    )
  }).catch(async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const open = await read($, isOpen)
    return (
      <Box>
        <Text dimColor>✻ Agent Crew </Text>
        <Button
          key="toggle"
          label={open ? 'Hide crew' : 'Show crew'}
          onPress={async () => {
            await toggle($)
          }}
        />
      </Box>
    )
  })
}
