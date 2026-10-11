import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Bridge, BridgeError } from '../src/bridge.ts'
import { CommandRouter, type CommandPlace } from '../src/commands.ts'
import { Config } from '../src/config.ts'
import type { ApprovalOutcomeLike, ApprovalRequestLike, SessionControllerLike, SessionEventLike, WorkspaceLike } from '../src/dsh.ts'
import { BindingStore } from '../src/state.ts'
import type { ChatTransport, OutgoingMessage } from '../src/transport.ts'

class FakeTransport implements ChatTransport {
  ready = true
  readonly log: { op: string; channelId: string; messageId?: string; message?: OutgoingMessage; name?: string }[] = []
  private next = 0
  async send(channelId: string, message: OutgoingMessage): Promise<string> {
    const id = `m${++this.next}`
    this.log.push({ op: 'send', channelId, messageId: id, message })
    return id
  }
  async edit(channelId: string, messageId: string, message: OutgoingMessage): Promise<void> {
    this.log.push({ op: 'edit', channelId, messageId, message })
  }
  async typing(channelId: string): Promise<void> {
    this.log.push({ op: 'typing', channelId })
  }
  async renameThread(channelId: string, name: string): Promise<void> {
    this.log.push({ op: 'rename', channelId, name })
  }
  sent(channelId: string): string[] {
    return this.log.filter(entry => entry.op === 'send' && entry.channelId === channelId).map(entry => entry.message?.content ?? '')
  }
}

const workspaces: WorkspaceLike[] = [
  { id: 'w-app', title: 'app', path: '/Users/me/dev/app', sessionIds: ['s-old'] },
  { id: 'w-api', title: 'api-server', path: '/Users/me/dev/api-server', sessionIds: [] },
]

async function setup(overrides: Partial<Config> = {}) {
  const input: Partial<Config> = { stateFile: join(await mkdtemp(join(tmpdir(), 'dsh-discord-')), 'state.json'), allowedUserIds: ['u1'], ...overrides }
  const config = Config(input as Config)
  const store = new BindingStore(config.stateFile, (error) => { throw error })
  const transport = new FakeTransport()
  const prompts: Parameters<SessionControllerLike['prompt']>[0][] = []
  let created = 0
  const sessions: SessionControllerLike = {
    list: async () => ({ items: [
      { sessionId: 's-old', updatedAt: 1, running: false, blank: false, projections: { values: { title: 'Old work' } } },
    ] }),
    create: async ({ workspaceId }) => {
      const sessionId = `s-new-${++created}`
      workspaces.find(ws => ws.id === workspaceId)?.sessionIds
      return { sessionId }
    },
    prompt: async (request) => {
      prompts.push(request)
      return { accepted: true }
    },
    cancel: () => ({ accepted: true }),
  }
  const running = new Set<string>()
  const bridge = new Bridge({
    config,
    sessions,
    workspaces: { list: () => workspaces, get: id => workspaces.find(ws => ws.id === id), archivedSessionIds: [] },
    agents: { get: id => ({ status: running.has(id) ? 'running' : 'idle' }) },
    store,
    transport: () => transport,
    logger: { info: () => undefined, warn: () => undefined, debug: () => undefined },
  })
  const router = new CommandRouter(bridge, '!')
  return { bridge, router, transport, prompts, store, running }
}

const dm: CommandPlace = { channelId: 'dm1', kind: 'dm' }

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(5000)
}

describe('workspace resolution', () => {
  it('accepts list numbers, titles and unique substrings', async () => {
    const { bridge } = await setup()
    expect(bridge.resolveWorkspace('2').id).toBe('w-api')
    expect(bridge.resolveWorkspace('APP').id).toBe('w-app')
    expect(bridge.resolveWorkspace('server').id).toBe('w-api')
    expect(() => bridge.resolveWorkspace('nope')).toThrow(BridgeError)
  })
})

describe('sessions from Discord', () => {
  it('creates, binds and prompts a Session in the chosen Workspace', async () => {
    const { bridge, router, prompts } = await setup()
    expect(() => bridge.workspaceFor([dm.channelId])).not.toThrow()
    router.useWorkspace(dm, 'api')
    const result = await router.newSession(dm, [{ type: 'text', text: 'hello' }])
    expect(result.channelId).toBe('dm1')
    expect(bridge.boundSession('dm1')).toBe('s-new-1')
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toMatchObject({ sessionId: 's-new-1', mode: 'queue', content: [{ type: 'text', text: 'hello' }] })
  })

  it('opens a thread in a text channel and renames it from the Session title', async () => {
    const { bridge, router, transport } = await setup({ defaultWorkspace: 'app' })
    const place: CommandPlace = { channelId: 'text1', kind: 'text', openThread: async () => 'thread1' }
    const result = await router.newSession(place, [{ type: 'text', text: 'fix the bug' }])
    expect(result.movedTo).toBe('thread1')
    bridge.handleSessionEvent('s-new-1', { type: 'session/title', data: { title: 'Fix login bug' } })
    await settle()
    expect(transport.log).toContainEqual({ op: 'rename', channelId: 'thread1', name: 'Fix login bug' })
  })

  it('switching Workspace releases a Session from another Workspace', async () => {
    const { bridge, router, prompts } = await setup({ defaultWorkspace: 'app' })
    await router.newSession(dm, [])
    expect(bridge.boundSession('dm1')).toBe('s-new-1')
    expect(router.useWorkspace(dm, 'app')).toContain('仍接着当前会话')
    expect(bridge.boundSession('dm1')).toBe('s-new-1')
    expect(router.useWorkspace(dm, 'api')).toContain('已解绑')
    expect(bridge.boundSession('dm1')).toBeUndefined()
    await router.newSession(dm, [{ type: 'text', text: 'next' }])
    expect(bridge.boundSession('dm1')).toBe('s-new-2')
    expect(bridge.boundWorkspace('dm1')?.id).toBe('w-api')
    expect(prompts.at(-1)).toMatchObject({ sessionId: 's-new-2' })
  })

  it('attaches an existing Session by list number', async () => {
    const { bridge, router } = await setup({ defaultWorkspace: 'app' })
    await router.listSessions(dm)
    const result = await router.attach(dm, '1')
    expect(result.reply).toContain('Old work')
    expect(bridge.boundSession('dm1')).toBe('s-old')
  })
})

describe('rendering Session events', () => {
  it('shows progress, the answer, and failures in order; mirrors only Desktop input', async () => {
    const { bridge, router, transport, prompts } = await setup({ defaultWorkspace: 'app' })
    await router.newSession(dm, [{ type: 'text', text: 'go' }])
    const sessionId = 's-new-1'
    const own = prompts[0]?.requestId
    const events: SessionEventLike[] = [
      { type: 'user/message', data: { content: [{ type: 'text', text: 'go' }], source: { kind: 'user', rpcId: own } } },
      { type: 'turn/start', data: { turn: 1 } },
      { type: 'tool/call', data: { callId: 'c1', name: 'bash', arguments: '{"command":"ls"}' } },
      { type: 'tool/result', data: { message: { toolCallId: 'c1' } } },
      { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'done!' }] } } },
      { type: 'turn/end', data: { turn: 1, reason: { kind: 'error', error: { message: 'quota' } } } },
      { type: 'user/message', data: { content: [{ type: 'text', text: 'from mac' }], source: { kind: 'user', rpcId: 'other' } } },
    ]
    for (const event of events) bridge.handleSessionEvent(sessionId, event)
    await settle()
    const sent = transport.sent('dm1')
    expect(sent[0]).toContain('bash · ls')
    expect(sent[1]).toBe('done!')
    expect(sent[2]).toContain('quota')
    expect(sent[3]).toContain('from mac')
    expect(sent.some(text => text.includes('go') && text.includes('桌面端'))).toBe(false)
    expect(transport.log.some(entry => entry.op === 'typing')).toBe(true)
  })
})

describe('approvals', () => {
  function request(signal?: AbortSignal): ApprovalRequestLike {
    return { agent: { id: 's-new-1' }, toolName: 'bash', callId: 'c9', reason: 'writes outside workspace', ...(signal === undefined ? {} : { signal }) }
  }

  it('lets a Discord answer win and withdraws the Desktop prompt', async () => {
    const { bridge, router, transport } = await setup({ defaultWorkspace: 'app' })
    await router.newSession(dm, [])
    bridge.handleSessionEvent('s-new-1', { type: 'tool/call', data: { callId: 'c9', name: 'bash', arguments: '{"command":"rm -rf build"}' } })
    const req = request()
    let desktopSignal: AbortSignal | undefined
    const pending = bridge.handleApproval(req, () => {
      desktopSignal = req.signal
      return new Promise<ApprovalOutcomeLike>((_resolve, reject) => {
        req.signal?.addEventListener('abort', () => { reject(new Error('withdrawn')) })
      })
    })
    await settle()
    const card = transport.log.find(entry => entry.message?.buttons !== undefined && entry.message.buttons.length > 0)
    expect(card?.message?.content).toContain('rm -rf build')
    const allow = card?.message?.buttons?.find(button => button.label === '允许一次')
    expect(bridge.answerApproval(allow?.id ?? '')).toBe('handled')
    await expect(pending).resolves.toBe('allowed-once')
    expect(desktopSignal?.aborted).toBe(true)
    await settle()
    expect(transport.log.at(-1)).toMatchObject({ op: 'edit', message: { buttons: [] } })
    expect(transport.log.at(-1)?.message?.content).toContain('已允许（Discord）')
    expect(bridge.answerApproval(allow?.id ?? '')).toBe('stale')
  })

  it('accepts a Desktop answer and closes the Discord card', async () => {
    const { bridge, router, transport } = await setup({ defaultWorkspace: 'app' })
    await router.newSession(dm, [])
    const outcome = await bridge.handleApproval(request(), async () => 'rejected')
    expect(outcome).toBe('rejected')
    await settle()
    expect(transport.log.at(-1)?.message?.content).toContain('已拒绝（桌面端）')
  })

  it('leaves unbound Sessions to Desktop', async () => {
    const { bridge, transport } = await setup()
    await expect(bridge.handleApproval({ agent: { id: 'elsewhere' }, toolName: 'bash' }, async () => 'allowed-once')).resolves.toBe('allowed-once')
    expect(transport.log).toHaveLength(0)
  })
})
