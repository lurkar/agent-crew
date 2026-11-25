import { expect, mock, test } from 'claude-code/testing'
import type { AgentInfo, On } from 'claude-code'

const PANE = {
  plugin: 'agent-crew',
  component: 'Pane',
  requestId: 'agent-crew',
  props: {
    title: 'Agent Crew',
    isFocused: false,
    bodyColumns: 80,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const BAND = {
  plugin: 'agent-crew',
  component: 'AbovePrompt',
  requestId: 'band',
  props: {
    hasSurvey: false,
    isCollapsed: false,
    isWorking: false,
    maxRows: 4,
    bodyColumns: 80,
    scroll: { offset: 0, bodyRows: 4 },
    view: {},
  },
} as const

const START = { cwd: '/', surface: 'desktop', isInteractive: true } as const

const ENGINE = { plugin: 'engine', tier: 'core' } as const

/** An Agent call as the engine raises it. */
function spawn(description: string) {
  return {
    tool_use_id: 'tu-' + description,
    prompt: 'p',
    description,
    subagentType: 'general-purpose',
    provider: ENGINE,
    parentModel: 'claude-fable-5-2',
    background: true,
    fork: false,
  }
}

function report(agentId: string, status: 'completed' | 'failed' | 'stopped' = 'completed') {
  return { agentId, subagentType: 'general-purpose', provider: ENGINE, status, text: 'done' }
}

function listed(id: string, status: AgentInfo['status']): AgentInfo {
  return {
    id,
    description: 'x',
    type: 'general-purpose',
    status,
    kind: 'local_agent',
    taskStatus: 'running',
    label: 'x',
    startTime: 1000,
    cwd: '/',
    tokenCount: 18_400,
    tokenSamples: [],
    hasRow: true,
  }
}

// Nothing sits beneath the plugin in a test: these hooks stand for the engine.
function engine(on: On, model = 'claude-fable-5-2') {
  const clock = mock.clock(on, { now: 1000 })
  mock.store(on)
  const seen: string[] = []
  const panes: string[] = []
  const agents: AgentInfo[] = []
  on('command.register', () => ({ value: { command: 'crew' } }))
  on('ui.open', (_, e) => {
    if (!panes.includes(e.id)) panes.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('ui.close', (_, e) => {
    if (panes.includes(e.id)) panes.splice(panes.indexOf(e.id), 1)
    return { value: undefined }
  })
  on('ui.panes', () => ({
    value: panes.map(id => ({ id, title: 'Agent Crew', isShown: true, isFocused: false, isPlaced: true })),
  }))
  on('ui.invalidate', () => ({ value: undefined }))
  on('session.model', () => ({ value: model }))
  on('agent.list', () => ({ value: [...agents] }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('agent.report', (_, e) => ({ text: e.text }))
  on('tool.call', (_, e) => {
    seen.push(String(e.tool))
    return { result: {} }
  })
  return { clock, seen, panes, agents }
}

test('a helper shows with its model and task, then finishes', async ($, on) => {
  const { clock } = engine(on)
  on('agent.spawn', () => ({ model: 'claude-sonnet-5-5', agentId: 'a1' }))

  await $.session.start(START)
  await $.agent.spawn(spawn('Write the save system'))
  await clock.settle()

  const term = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await term.find({ type: 'Text', text: /leading/ }))?.text).toContain('Fable 5.2')
  expect((await term.find({ type: 'Text', text: /Sonnet 5\.5: / }))?.text).toContain('● Sonnet 5.5: Write the save system')
  await term.unmount()

  for (const surface of ['desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    const svg = await ui.find({ type: 'Svg' })
    expect(String(svg?.props.source)).toContain('SONNET 5.5')
    expect(String(svg?.props.alt)).toContain('Sonnet 5.5: Write the save system')
    expect((await ui.find({ type: 'Text', text: /working/ }))?.text).toContain('Sonnet 5.5 · working')
    await ui.unmount()
  }

  await clock.advance(61_000)
  await $.agent.report(report('a1'))
  await clock.settle()

  const after = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await after.find({ type: 'Text', text: /Sonnet 5\.5: / }))?.text).toContain('✓ Sonnet 5.5')
  expect((await after.find({ type: 'Text', text: /finished/ }))?.text).toContain('Sonnet 5.5 finished: Write the save system')
  await after.unmount()

  const desk = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await desk.find({ type: 'Text', text: /done in/ }))?.text).toContain('Sonnet 5.5 · done in 1m')
  expect((await desk.find({ key: 'clear' }))?.type).toBe('Button')
  await desk.press({ key: 'clear' })
  await clock.settle()
  await desk.unmount()

  const cleared = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await cleared.find({ type: 'Text', text: /No helpers yet/ }))?.text).toBe('No helpers yet.')
  await cleared.unmount()
})

test('a tool call passes through untouched, lights its node, and the light goes out after it ends', async ($, on) => {
  const { clock, seen } = engine(on)
  on('agent.spawn', () => ({ model: 'claude-opus-5-5', agentId: 'a1' }))

  await $.session.start(START)
  await $.agent.spawn(spawn('Model the gate'))
  await $.tool.call({ tool: 'mcp__blender__get_scene_info', agentId: 'a1' })
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  await $.tool.call({ tool: 'TodoWrite', todos: [] })
  await clock.settle()

  expect(seen).toEqual(['mcp__blender__get_scene_info', 'Bash', 'TodoWrite'])
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const source = String((await ui.find({ type: 'Svg' }))?.props.source)
  expect(source).toContain('>blender<')
  expect(source).toContain('>terminal<')
  expect(source).toContain('⚙ get_scene_info')
  expect(source).toContain('⚙ terminal')
  expect((await ui.find({ type: 'Text', text: /→ blender/ }))?.text).toContain('Opus 5.5 → blender (get_scene_info)')
  await ui.unmount()

  await clock.advance(3000)
  const later = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const dark = String((await later.find({ type: 'Svg' }))?.props.source)
  expect(dark).toContain('>blender<')
  expect(dark.includes('⚙')).toBe(false)
  await later.unmount()
})

test('a refused spawn adds no helper', async ($, on) => {
  const { clock } = engine(on)
  on('agent.spawn', () => ({ deny: 'no' }))

  await $.session.start(START)
  await $.agent.spawn(spawn('Nope'))
  await clock.settle()

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /No helpers yet/ }))?.text).toBe('No helpers yet.')
  await ui.unmount()
})

test('a helper that goes idle rests, and one whose report never came is let go', async ($, on) => {
  const { clock, agents } = engine(on)
  on('agent.spawn', () => ({ model: 'claude-haiku-5-5', agentId: 'a1' }))

  await $.session.start(START)
  await $.agent.spawn(spawn('Run the tests'))
  await clock.settle()

  agents.push(listed('a1', 'idle'))
  await clock.advance(5000)
  const resting = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await resting.find({ type: 'Text', text: /Haiku 5\.5: / }))?.text).toContain('○ Haiku 5.5')
  await resting.unmount()
  const desk = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await desk.find({ type: 'Text', text: /waiting/ }))?.text).toContain('Haiku 5.5 · waiting · 18k tokens')
  await desk.unmount()

  agents.length = 0
  await clock.advance(10_000)
  const gone = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await gone.find({ type: 'Text', text: /Haiku 5\.5: / }))?.text).toContain('✓ Haiku 5.5')
  await gone.unmount()
})

test('a resumed helper goes back to work', async ($, on) => {
  const { clock } = engine(on)
  on('agent.spawn', () => ({ model: 'claude-sonnet-5-5', agentId: 'a1' }))

  await $.session.start(START)
  await $.agent.spawn(spawn('Draft the story'))
  await $.agent.report(report('a1'))
  await $.agent.spawn(spawn('Draft the story'))
  await clock.settle()

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /Sonnet 5\.5: / }))?.text).toContain('● Sonnet 5.5')
  expect((await ui.find({ type: 'Text', text: /resumed/ }))?.text).toContain('Sonnet 5.5 resumed: Draft the story')
  await ui.unmount()
})

test('the band shows the lead and a switch that follows the pane on every surface', async ($, on) => {
  const { clock, panes } = engine(on, 'claude-opus-5-5')

  await $.session.start(START)
  await clock.settle()
  expect(panes).toEqual(['agent-crew'])

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect((await ui.find({ type: 'Text', text: /leading/ }))?.text).toContain('Opus 5.5 leading')
    expect((await ui.find({ key: 'toggle' }))?.props.label).toBe('Hide crew')

    await ui.press({ key: 'toggle' })
    await clock.settle()
    expect(panes).toEqual([])
    expect((await ui.find({ key: 'toggle' }))?.props.label).toBe('Show crew')

    await ui.press({ key: 'toggle' })
    await clock.settle()
    expect(panes).toEqual(['agent-crew'])
    await ui.unmount()
  }
})

test('a small widget shows the lead and who is working', async ($, on) => {
  const { clock } = engine(on)
  on('agent.spawn', () => ({ model: 'claude-opus-5-5', agentId: 'a1' }))

  await $.session.start(START)
  await $.agent.spawn(spawn('Model the gate'))
  await clock.settle()

  const ui = await $.ui.mount({ ...PANE, props: { ...PANE.props, placement: 'widget' }, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /leading/ }))?.text).toBe('Fable 5.2 leading')
  expect((await ui.find({ type: 'Text', text: /working/ }))?.text).toBe('Opus 5.5 working')
  await ui.unmount()
})
