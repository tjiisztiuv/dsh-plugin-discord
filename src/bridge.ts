/**
 * Transport-neutral core: maps Discord channels to Harness Sessions, admits
 * prompts through `ctx.sessionController`, renders Session events, and offers
 * tool approvals and model questions. Every Discord write for one channel runs on that channel's
 * serial queue so messages keep Session order.
 */

import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import type { Config } from './config.ts'
import {
  remoteErrorCode,
  type ApprovalOutcomeLike,
  type ApprovalRequestLike,
  type PromptPart,
  type QuestionAnswerItemLike,
  type QuestionAnswerLike,
  type QuestionItemLike,
  type QuestionRequestLike,
  type SessionControllerLike,
  type SessionEventLike,
  type SessionId,
  type SessionRequestId,
  type SessionSummaryLike,
  type WorkspaceLike,
  type WorkspaceRegistryLike,
} from './dsh.ts'
import {
  chunkText,
  describeTurnEnd,
  extractText,
  formatToolArguments,
  summarizeToolCall,
  truncate,
} from './format.ts'
import {
  closedQuestionCard,
  componentAnswer,
  describeAnswer,
  parseQuestionComponentId,
  questionCard,
  questionComponentId,
  questionModal,
  typedAnswer,
  type QuestionInput,
  type QuestionModal,
} from './questions.ts'
import type { BindingStore } from './state.ts'
import type { ChatTransport, OutgoingMessage } from './transport.ts'

/** Minimal logger (`ctx.logger`). */
export interface LoggerLike {
  info(message: string): void
  warn(message: string): void
  debug(message: string): void
}

/** Live-agent lookup (`ctx.agents`). */
export interface AgentsLike {
  get(id: SessionId): { readonly status: 'idle' | 'running' } | undefined
}

/** Services the bridge consumes. */
export interface BridgeDeps {
  readonly config: Config
  readonly sessions: SessionControllerLike
  readonly workspaces: WorkspaceRegistryLike
  readonly agents: AgentsLike
  readonly store: BindingStore
  readonly transport: () => ChatTransport | undefined
  readonly logger: LoggerLike
  readonly now?: () => number
}

/** One row of a Session listing. */
export interface SessionRow {
  readonly sessionId: SessionId
  readonly title: string
  readonly running: boolean
  readonly updatedAt: number
  readonly workspace: WorkspaceLike | undefined
}

/** User-facing failure; its message is shown verbatim in Discord. */
export class BridgeError extends Error {}

/** Per-channel rendering state of the current turn. */
interface ChannelTurn {
  progressId?: string | undefined
  progressLines: { callId: string; text: string; mark: string }[]
  progressTotal: number
  progressDirty: boolean
  progressTimer?: ReturnType<typeof setTimeout> | undefined
  lastProgressEdit: number
  typingTimer?: ReturnType<typeof setInterval> | undefined
}

/** One approval card waiting for a Discord button. */
interface PendingApproval {
  readonly channelId: string
  readonly resolve: (outcome: ApprovalOutcomeLike) => void
}

/** One question batch answered card by card in Discord. */
interface PendingQuestions {
  readonly channelId: string
  readonly questions: readonly QuestionItemLike[]
  /** Answers so far; the card being answered is `answers.length`. */
  readonly answers: QuestionAnswerItemLike[]
  /** Posted card ids by question index, filled on the channel queue. */
  readonly cardIds: (string | undefined)[]
  /** Discord completed the batch. */
  readonly complete: () => void
  /** Discord can no longer answer (card not posted, bridge closing). */
  readonly abandon: () => void
}

/** What the Discord runtime does after a question component fires. */
export type QuestionInteractionResult = 'handled' | 'stale' | 'foreign' | { readonly modal: QuestionModal }

const APPROVAL_PREFIX = 'dshap'
const OWN_REQUEST_LIMIT = 500
const TOOL_CALL_CACHE_LIMIT = 200

/** Discord-facing Harness bridge. */
export class Bridge {
  private readonly queues = new Map<string, Promise<void>>()
  private readonly turns = new Map<string, ChannelTurn>()
  private readonly ownRequests = new Set<string>()
  private readonly toolCalls = new Map<string, { name: string; arguments: string }>()
  private readonly approvals = new Map<string, PendingApproval>()
  private readonly questions = new Map<string, PendingQuestions>()
  private closed = false

  constructor(private readonly deps: BridgeDeps) {}

  // ---------------------------------------------------------------- workspaces

  /** @returns registered Workspaces in sidebar order. */
  workspaces(): WorkspaceLike[] {
    return this.deps.workspaces.list()
  }

  /**
   * Resolve a user-typed Workspace reference: id, 1-based list index, exact
   * title or folder name, absolute path, then a unique substring match.
   * @throws BridgeError when nothing or several Workspaces match.
   */
  resolveWorkspace(query: string): WorkspaceLike {
    const list = this.workspaces()
    const text = query.trim()
    const lower = text.toLowerCase()
    const byId = list.find(ws => ws.id === text)
    if (byId !== undefined) return byId
    if (/^\d+$/.test(text)) {
      const indexed = list[Number(text) - 1]
      if (indexed !== undefined) return indexed
    }
    const exact = list.filter(ws => ws.title.toLowerCase() === lower || basename(ws.path).toLowerCase() === lower || ws.path === text)
    if (exact.length === 1 && exact[0] !== undefined) return exact[0]
    const partial = list.filter(ws => ws.title.toLowerCase().includes(lower) || ws.path.toLowerCase().includes(lower))
    if (partial.length === 1 && partial[0] !== undefined) return partial[0]
    if (exact.length + partial.length === 0) throw new BridgeError(`找不到工作区「${text}」，用 /ws 查看列表`)
    throw new BridgeError(`「${text}」匹配到多个工作区：${partial.map(ws => ws.title).join('、')}，请写得更具体`)
  }

  /**
   * Choose the Workspace for new Sessions started from a channel.
   * @param channelIds - the channel, then its parent channel for threads.
   * @returns the Workspace, or undefined when the user must pick one.
   */
  workspaceFor(channelIds: readonly string[]): WorkspaceLike | undefined {
    for (const channelId of channelIds) {
      const id = this.deps.store.channelWorkspace(channelId)
      const ws = id === undefined ? undefined : this.deps.workspaces.get(id)
      if (ws !== undefined) return ws
    }
    if (this.deps.config.defaultWorkspace !== undefined) {
      try {
        return this.resolveWorkspace(this.deps.config.defaultWorkspace)
      } catch (error: unknown) {
        this.deps.logger.warn(`discord: defaultWorkspace: ${String(error)}`)
      }
    }
    const list = this.workspaces()
    return list.length === 1 ? list[0] : undefined
  }

  /** Remember a channel's Workspace for later new Sessions. */
  useWorkspace(channelId: string, workspace: WorkspaceLike): void {
    this.deps.store.setChannelWorkspace(channelId, workspace.id)
  }

  /** @returns the Workspace whose account contains `sessionId`. */
  workspaceOfSession(sessionId: SessionId): WorkspaceLike | undefined {
    return this.workspaces().find(ws => ws.sessionIds.includes(sessionId))
  }

  // ------------------------------------------------------------------ sessions

  /**
   * List recent visible Sessions, newest first.
   * @param workspace - restrict to one Workspace; undefined lists every Workspace.
   * @param limit - maximum rows; defaults to `sessionListLimit`.
   */
  async sessionRows(workspace?: WorkspaceLike, limit = this.deps.config.sessionListLimit): Promise<SessionRow[]> {
    const { items } = await this.deps.sessions.list({}, AbortSignal.timeout(this.deps.config.requestTimeoutMs))
    const archived = new Set(this.deps.workspaces.archivedSessionIds)
    const owners = new Map<SessionId, WorkspaceLike>()
    for (const ws of this.workspaces()) for (const id of ws.sessionIds) owners.set(id, ws)
    const rows = items
      .filter(item => item.origin !== 'subagent' && !archived.has(item.sessionId))
      .filter(item => !item.blank || this.deps.store.isBound(item.sessionId))
      .filter(item => workspace === undefined || owners.get(item.sessionId)?.id === workspace.id)
      .map(item => this.row(item, owners.get(item.sessionId)))
    rows.sort((a, b) => b.updatedAt - a.updatedAt)
    return rows.slice(0, limit)
  }

  /** @returns one Session's row, or undefined when it is not listed. */
  async sessionRow(sessionId: SessionId): Promise<SessionRow | undefined> {
    const { items } = await this.deps.sessions.list({}, AbortSignal.timeout(this.deps.config.requestTimeoutMs))
    const item = items.find(candidate => candidate.sessionId === sessionId)
    return item === undefined ? undefined : this.row(item, this.workspaceOfSession(sessionId))
  }

  private row(item: SessionSummaryLike, workspace: WorkspaceLike | undefined): SessionRow {
    const title = item.projections?.values.title ?? undefined
    const running = this.deps.agents.get(item.sessionId)?.status === 'running' || item.running
    return {
      sessionId: item.sessionId,
      title: title === undefined || title === null || title.trim() === '' ? '（未命名会话）' : title,
      running,
      updatedAt: item.updatedAt,
      workspace,
    }
  }

  /**
   * Create an ordinary Workspace Session exactly as Desktop's "new session" does.
   * @returns the new Session id.
   */
  async createSession(workspace: WorkspaceLike): Promise<SessionId> {
    try {
      const created = await this.deps.sessions.create({ workspaceId: workspace.id })
      return created.sessionId
    } catch (error: unknown) {
      throw this.userError('创建会话失败', error)
    }
  }

  /**
   * Bind a channel to a Session and tell any channel that loses it.
   * @param ownsThread - the plugin created the thread and may rename it.
   */
  bind(channelId: string, sessionId: SessionId, workspace: WorkspaceLike, ownsThread: boolean): void {
    const released = this.deps.store.bind(channelId, { sessionId, workspaceId: workspace.id, ownsThread })
    for (const other of released) {
      this.post(other, { content: `↪️ 这个会话已转到 <#${channelId}> 继续，这里不再同步。` })
      this.stopTyping(other)
    }
  }

  /** @returns the Session bound to a channel. */
  boundSession(channelId: string): SessionId | undefined {
    return this.deps.store.binding(channelId)?.sessionId
  }

  /**
   * @returns the Workspace of the Session bound to a channel; a binding whose
   * Workspace was removed yields a placeholder carrying the stored id.
   */
  boundWorkspace(channelId: string): Pick<WorkspaceLike, 'id' | 'title'> | undefined {
    const binding = this.deps.store.binding(channelId)
    if (binding === undefined) return undefined
    return this.deps.workspaces.get(binding.workspaceId) ?? { id: binding.workspaceId, title: '（已移除的工作区）' }
  }

  /** @returns whether the plugin created this thread for its current binding. */
  ownsThread(channelId: string): boolean {
    return this.deps.store.binding(channelId)?.ownsThread === true
  }

  /** Unbind a channel. @returns whether a binding existed. */
  detach(channelId: string): boolean {
    this.stopTyping(channelId)
    return this.deps.store.unbind(channelId) !== undefined
  }

  /**
   * Admit one prompt to the channel's Session.
   * @param mode - `queue` runs after the current turn; `steer` joins the running turn.
   */
  async prompt(channelId: string, content: readonly PromptPart[], mode: 'queue' | 'steer' = 'queue'): Promise<void> {
    const sessionId = this.boundSession(channelId)
    if (sessionId === undefined) throw new BridgeError('这里还没有绑定会话')
    const requestId = randomUUID() as SessionRequestId
    this.rememberOwnRequest(requestId)
    try {
      await this.deps.sessions.prompt({
        requestId,
        sessionId,
        mode,
        content,
        clientTimeZone: this.deps.config.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
      }, AbortSignal.timeout(this.deps.config.requestTimeoutMs))
    } catch (error: unknown) {
      this.ownRequests.delete(requestId)
      throw this.userError('发送失败', error)
    }
  }

  /** Cancel the running turn, keeping queued prompts. @returns whether a live turn existed. */
  stop(channelId: string): boolean {
    const sessionId = this.boundSession(channelId)
    if (sessionId === undefined) throw new BridgeError('这里还没有绑定会话')
    if (this.deps.agents.get(sessionId)?.status !== 'running') return false
    try {
      this.deps.sessions.cancel({ sessionId })
      return true
    } catch (error: unknown) {
      if (remoteErrorCode(error) === 'session/not-found') return false
      throw this.userError('停止失败', error)
    }
  }

  private rememberOwnRequest(requestId: string): void {
    this.ownRequests.add(requestId)
    if (this.ownRequests.size > OWN_REQUEST_LIMIT) {
      const oldest = this.ownRequests.values().next().value
      if (oldest !== undefined) this.ownRequests.delete(oldest)
    }
  }

  private userError(prefix: string, error: unknown): BridgeError {
    if (error instanceof BridgeError) return error
    const code = remoteErrorCode(error)
    const hint = code === 'session/model-unavailable' || code === 'session/provider-credentials-unavailable'
      ? '当前模型不可用，请先在桌面端选择一个可用模型'
      : code === 'session/not-found'
        ? '会话不存在，可能已被删除或归档'
        : error instanceof Error ? error.message : String(error)
    return new BridgeError(`${prefix}：${hint}`)
  }

  // -------------------------------------------------------------- rendering

  /**
   * Render one durable Session event into every bound channel.
   * @param sessionId - the Session that appended the event.
   * @param event - the appended event; unknown types are ignored.
   */
  handleSessionEvent(sessionId: SessionId, event: SessionEventLike): void {
    if (this.closed) return
    const channels = this.deps.store.channelsOf(sessionId)
    if (event.type === 'tool/call') this.cacheToolCall(event.data.callId, event.data.name, event.data.arguments)
    for (const channelId of channels) this.renderEvent(channelId, event)
  }

  private renderEvent(channelId: string, event: SessionEventLike): void {
    const { config } = this.deps
    switch (event.type) {
      case 'turn/start':
        this.resetProgress(channelId)
        this.startTyping(channelId)
        return
      case 'turn/end': {
        this.stopTyping(channelId)
        this.flushProgress(channelId)
        const notice = describeTurnEnd(event.data.reason)
        if (notice !== undefined) this.post(channelId, { content: notice })
        return
      }
      case 'user/message': {
        const { source } = event.data
        if (source.kind !== 'user' || !config.mirrorDesktopInput) return
        if (source.rpcId !== undefined && this.ownRequests.delete(source.rpcId)) return
        const text = extractText(event.data.content, false)
        if (text !== '') this.postText(channelId, `🖥️ **桌面端输入**\n${text}`)
        return
      }
      case 'assistant/message': {
        let text = extractText(event.data.message.content, config.showReasoning)
        if (event.data.interrupted === true && text !== '') text += '\n\n_（已中断）_'
        if (text === '') return
        this.flushProgress(channelId)
        this.resetProgress(channelId)
        this.postText(channelId, text)
        return
      }
      case 'tool/call':
        if (config.toolCalls === 'compact') this.addProgress(channelId, event.data.callId, summarizeToolCall(event.data.name, event.data.arguments))
        return
      case 'tool/result':
        if (config.toolCalls === 'compact') this.markProgress(channelId, event.data.message.toolCallId, event.data.message.isError === true ? '❌' : '✅')
        return
      case 'session/title':
        if (this.deps.store.binding(channelId)?.ownsThread === true) {
          this.enqueue(channelId, transport => transport.renameThread(channelId, truncate(event.data.title, 100)))
        }
        return
      default:
        return
    }
  }

  private cacheToolCall(callId: string, name: string, args: string): void {
    this.toolCalls.set(callId, { name, arguments: args })
    if (this.toolCalls.size > TOOL_CALL_CACHE_LIMIT) {
      const oldest = this.toolCalls.keys().next().value
      if (oldest !== undefined) this.toolCalls.delete(oldest)
    }
  }

  private turn(channelId: string): ChannelTurn {
    let state = this.turns.get(channelId)
    if (state === undefined) {
      state = { progressLines: [], progressTotal: 0, progressDirty: false, lastProgressEdit: 0 }
      this.turns.set(channelId, state)
    }
    return state
  }

  private resetProgress(channelId: string): void {
    const state = this.turn(channelId)
    if (state.progressTimer !== undefined) clearTimeout(state.progressTimer)
    state.progressTimer = undefined
    state.progressId = undefined
    state.progressLines = []
    state.progressTotal = 0
    state.progressDirty = false
  }

  private addProgress(channelId: string, callId: string, text: string): void {
    const state = this.turn(channelId)
    state.progressLines.push({ callId, text, mark: '⏳' })
    state.progressTotal += 1
    const overflow = state.progressLines.length - this.deps.config.progressMaxLines
    if (overflow > 0) state.progressLines.splice(0, overflow)
    this.scheduleProgress(channelId)
  }

  private markProgress(channelId: string, callId: string, mark: string): void {
    const line = this.turns.get(channelId)?.progressLines.find(item => item.callId === callId)
    if (line === undefined) return
    line.mark = mark
    this.scheduleProgress(channelId)
  }

  private progressContent(state: ChannelTurn): string {
    const hidden = state.progressTotal - state.progressLines.length
    const header = `🔧 工具调用 ${state.progressTotal} 次${hidden > 0 ? `（仅显示最近 ${state.progressLines.length} 次）` : ''}`
    const body = state.progressLines.map(line => `${line.mark} ${line.text.replace(/`/g, 'ˋ')}`).join('\n')
    return truncate(`${header}\n${body}`, 1990)
  }

  private scheduleProgress(channelId: string): void {
    const state = this.turn(channelId)
    state.progressDirty = true
    if (state.progressTimer !== undefined) return
    const now = this.deps.now?.() ?? Date.now()
    const wait = state.progressId === undefined ? 0 : Math.max(0, state.lastProgressEdit + this.deps.config.progressEditIntervalMs - now)
    state.progressTimer = setTimeout(() => {
      state.progressTimer = undefined
      this.flushProgress(channelId)
    }, wait)
  }

  private flushProgress(channelId: string): void {
    const state = this.turns.get(channelId)
    if (state === undefined || !state.progressDirty || state.progressLines.length === 0) return
    if (state.progressTimer !== undefined) clearTimeout(state.progressTimer)
    state.progressTimer = undefined
    state.progressDirty = false
    state.lastProgressEdit = this.deps.now?.() ?? Date.now()
    const content = this.progressContent(state)
    this.enqueue(channelId, async (transport) => {
      if (state.progressId === undefined) state.progressId = await transport.send(channelId, { content })
      else await transport.edit(channelId, state.progressId, { content })
    })
  }

  private startTyping(channelId: string): void {
    const state = this.turn(channelId)
    if (state.typingTimer !== undefined) return
    const tick = (): void => {
      const transport = this.deps.transport()
      if (transport?.ready === true) void transport.typing(channelId).catch(() => undefined)
    }
    tick()
    state.typingTimer = setInterval(tick, this.deps.config.typingIntervalMs)
  }

  private stopTyping(channelId: string): void {
    const state = this.turns.get(channelId)
    if (state?.typingTimer === undefined) return
    clearInterval(state.typingTimer)
    state.typingTimer = undefined
  }

  /** Post possibly long text as ordered chunks. */
  postText(channelId: string, text: string): void {
    for (const chunk of chunkText(text, this.deps.config.messageChunkSize)) this.post(channelId, { content: chunk })
  }

  /** Post one message on the channel's serial queue. */
  post(channelId: string, message: OutgoingMessage): void {
    this.enqueue(channelId, async (transport) => { await transport.send(channelId, message) })
  }

  private enqueue(channelId: string, task: (transport: ChatTransport) => Promise<void>): Promise<void> {
    const previous = this.queues.get(channelId) ?? Promise.resolve()
    const next = previous.then(async () => {
      const transport = this.deps.transport()
      if (this.closed || transport?.ready !== true) return
      await task(transport)
    }).catch((error: unknown) => {
      this.deps.logger.warn(`discord: write to channel ${channelId} failed: ${error instanceof Error ? error.message : String(error)}`)
    })
    this.queues.set(channelId, next)
    void next.finally(() => {
      if (this.queues.get(channelId) === next) this.queues.delete(channelId)
    })
    return next
  }

  // --------------------------------------------------------------- approvals

  /**
   * `approval/request` waterfall listener. For a Discord-bound Session it posts
   * Allow/Reject buttons and races them against Desktop (`next()`); the first
   * answer wins. When Discord answers first, the request's signal seen by the
   * Desktop delivery is aborted so its panel closes.
   */
  async handleApproval(request: ApprovalRequestLike, next: () => Promise<ApprovalOutcomeLike>): Promise<ApprovalOutcomeLike> {
    const channelId = this.deps.store.channelsOf(request.agent.id)[0]
    const transport = this.deps.transport()
    if (this.closed || this.deps.config.approvals !== 'race' || channelId === undefined || transport?.ready !== true) return next()

    const original = request.signal
    if (original?.aborted === true) return 'cancelled'
    const discordAnswered = new AbortController()
    if (!Object.isFrozen(request)) {
      // Cooperative request mutation (Cordis waterfall convention): downstream
      // forwarders read `signal` to withdraw their own prompt.
      Object.assign(request, { signal: original === undefined ? discordAnswered.signal : AbortSignal.any([original, discordAnswered.signal]) })
    }

    const token = randomUUID().replace(/-/g, '').slice(0, 16)
    const decided = new Promise<ApprovalOutcomeLike>((resolve) => {
      this.approvals.set(token, { channelId, resolve })
    })
    let cardId: string | undefined
    try {
      cardId = await transport.send(channelId, {
        content: this.approvalCard(request),
        buttons: [
          { id: `${APPROVAL_PREFIX}:${token}:allow`, label: '允许一次', style: 'success' },
          { id: `${APPROVAL_PREFIX}:${token}:reject`, label: '拒绝', style: 'danger' },
        ],
      })
    } catch (error: unknown) {
      this.approvals.delete(token)
      this.deps.logger.warn(`discord: approval card failed: ${String(error)}`)
      return next()
    }

    type Settled = { readonly by: 'discord' | 'desktop' | 'withdrawn'; readonly outcome: ApprovalOutcomeLike }
    const fromDiscord = decided.then((outcome): Settled => ({ by: 'discord', outcome }))
    const fromDesktop = next().then(
      (outcome): Settled => ({ by: 'desktop', outcome }),
      // A Desktop delivery that fails or is withdrawn leaves Discord to answer.
      () => fromDiscord,
    )
    const withdrawn = new Promise<Settled>((resolve) => {
      original?.addEventListener('abort', () => { resolve({ by: 'withdrawn', outcome: 'cancelled' }) }, { once: true })
    })
    const settled = await Promise.race([fromDiscord, fromDesktop, withdrawn])
    this.approvals.delete(token)
    if (settled.by !== 'desktop') discordAnswered.abort(new Error('approval answered in Discord'))
    const verdict = settled.by === 'withdrawn'
      ? '⚪ 请求已撤回'
      : `${settled.outcome === 'allowed-once' ? '✅ 已允许' : settled.outcome === 'rejected' ? '❌ 已拒绝' : `⚪ ${settled.outcome}`}（${settled.by === 'discord' ? 'Discord' : '桌面端'}）`
    const finalCard = cardId
    this.enqueue(channelId, transport => transport.edit(channelId, finalCard, {
      content: truncate(`${this.approvalCard(request)}\n\n**${verdict}**`, 2000),
      buttons: [],
    }))
    return settled.outcome
  }

  private approvalCard(request: ApprovalRequestLike): string {
    const lines = [`🔐 **需要审批**：\`${request.toolName}\``]
    if (request.reason !== undefined && request.reason.trim() !== '') lines.push(truncate(request.reason.trim(), 400))
    const call = request.callId === undefined ? undefined : this.toolCalls.get(request.callId)
    if (call !== undefined && this.deps.config.approvalArgumentChars > 0) {
      lines.push(`\`\`\`json\n${formatToolArguments(call.arguments, this.deps.config.approvalArgumentChars).replace(/```/g, 'ˋˋˋ')}\n\`\`\``)
    }
    return truncate(lines.join('\n'), 1900)
  }

  /**
   * Answer an approval card button.
   * @param customId - the button's custom id.
   * @returns `handled` when the id belonged to a live card, `stale` for an
   * expired card, `foreign` for a non-approval button.
   */
  answerApproval(customId: string): 'handled' | 'stale' | 'foreign' {
    const [prefix, token, action] = customId.split(':')
    if (prefix !== APPROVAL_PREFIX || token === undefined) return 'foreign'
    const pending = this.approvals.get(token)
    if (pending === undefined) return 'stale'
    this.approvals.delete(token)
    pending.resolve(action === 'allow' ? 'allowed-once' : 'rejected')
    return 'handled'
  }

  // --------------------------------------------------------------- questions

  /**
   * `user-questions/request` waterfall listener (`ask_user_question`). For a
   * Discord-bound Session it posts one card per question and races the batch
   * against Desktop (`next()`); the first complete answer wins and the other
   * side's prompt is withdrawn. An absent Desktop leaves Discord to answer; a
   * timed question's expiry, from Desktop's countdown or the Host's, ends the
   * wait for both so the model continues.
   */
  async handleQuestion(request: QuestionRequestLike, next: () => Promise<QuestionAnswerLike>): Promise<QuestionAnswerLike> {
    const sessionId = request.agent?.id
    const channelId = sessionId === undefined ? undefined : this.deps.store.channelsOf(sessionId)[0]
    const original = request.signal
    if (this.closed || this.deps.config.questions !== 'race' || channelId === undefined || request.questions.length === 0
      || this.deps.transport()?.ready !== true || original?.aborted === true) return next()

    const discordAnswered = new AbortController()
    if (!Object.isFrozen(request)) {
      // Cooperative request mutation, as for approvals: Desktop reads `signal` to withdraw its card.
      Object.assign(request, { signal: original === undefined ? discordAnswered.signal : AbortSignal.any([original, discordAnswered.signal]) })
    }

    type Settled =
      | { readonly by: 'discord' | 'desktop'; readonly answer: QuestionAnswerLike }
      | { readonly by: 'failed' | 'withdrawn'; readonly error: unknown }
    let settle!: (settled: Settled) => void
    const settledPromise = new Promise<Settled>((resolve) => { settle = resolve })
    let desktopFailure: { readonly error: unknown } | undefined
    let discordGone = false
    const token = randomUUID().replace(/-/g, '').slice(0, 16)
    const pending: PendingQuestions = {
      channelId,
      questions: request.questions,
      answers: [],
      cardIds: [],
      complete: () => { settle({ by: 'discord', answer: { answers: [...pending.answers] } }) },
      abandon: () => {
        discordGone = true
        if (desktopFailure !== undefined) settle({ by: 'failed', error: desktopFailure.error })
      },
    }
    next().then(
      answer => { settle({ by: 'desktop', answer }) },
      (error: unknown) => {
        // Without a connected Desktop answerer Discord keeps the question; a
        // countdown that ran out ends it everywhere.
        desktopFailure = { error }
        if (discordGone || remoteErrorCode(error) === 'ASK_TIMED_OUT') settle({ by: 'failed', error })
      },
    )
    const onAbort = (): void => { settle({ by: 'withdrawn', error: original?.reason }) }
    original?.addEventListener('abort', onAbort, { once: true })
    this.questions.set(token, pending)
    this.postQuestion(token, pending)

    const settled = await settledPromise
    original?.removeEventListener('abort', onAbort)
    this.questions.delete(token)
    if (settled.by !== 'desktop') discordAnswered.abort(new Error('question answered in Discord'))
    if ('answer' in settled) {
      // Discord already closed each card as it was answered.
      if (settled.by === 'desktop') this.editQuestionCard(pending, pending.answers.length, '🖥️ 已在桌面端回答')
      return settled.answer
    }
    const { error } = settled
    const verdict = remoteErrorCode(error) === 'ASK_TIMED_OUT'
      ? '⏱️ 等待超时，模型先继续了；之后仍可在桌面端回答'
      : settled.by === 'withdrawn'
        ? '⚪ 问题已撤回'
        : `⚠️ 无法在 Discord 回答：${error instanceof Error ? error.message : String(error)}`
    this.editQuestionCard(pending, pending.answers.length, verdict)
    throw error
  }

  /** Post the card of the question being answered, after any long detail. */
  private postQuestion(token: string, pending: PendingQuestions): void {
    const index = pending.answers.length
    const { channelId } = pending
    const card = questionCard(token, pending.questions, index)
    if (card.detail !== undefined) this.postText(channelId, card.detail)
    void this.enqueue(channelId, async (transport) => {
      pending.cardIds[index] = await transport.send(channelId, card.message)
    }).then(() => {
      if (pending.cardIds[index] === undefined && this.questions.get(token) === pending) pending.abandon()
    })
  }

  /** Replace a card's buttons with a closing line. */
  private editQuestionCard(pending: PendingQuestions, index: number, verdict: string): void {
    const { channelId } = pending
    this.enqueue(channelId, async (transport) => {
      const cardId = pending.cardIds[index]
      if (cardId !== undefined) await transport.edit(channelId, cardId, closedQuestionCard(pending.questions, index, verdict))
    })
  }

  /** Record one answer, then post the next card or complete the batch. */
  private recordAnswer(token: string, pending: PendingQuestions, item: QuestionAnswerItemLike): void {
    const index = pending.answers.length
    pending.answers.push(item)
    this.editQuestionCard(pending, index, `${describeAnswer(item)}（Discord）`)
    if (pending.answers.length < pending.questions.length) this.postQuestion(token, pending)
    else pending.complete()
  }

  /**
   * Answer a question card component.
   * @param customId - the button, select menu, or modal custom id.
   * @param input - select values or modal text.
   * @returns `handled` when recorded, a modal to show for a text answer,
   * `stale` for an answered or expired card, `foreign` for other components.
   */
  answerQuestion(customId: string, input: QuestionInput = {}): QuestionInteractionResult {
    const parsed = parseQuestionComponentId(customId)
    if (parsed === undefined) return 'foreign'
    const pending = this.questions.get(parsed.token)
    const question = pending?.questions[parsed.index]
    if (pending === undefined || question === undefined || parsed.index !== pending.answers.length) return 'stale'
    if (parsed.action === 'txt') return { modal: questionModal(questionComponentId(parsed.token, parsed.index, 'modal'), question) }
    const item = componentAnswer(question, parsed.action, input)
    if (item === undefined) return 'stale'
    this.recordAnswer(parsed.token, pending, item)
    return 'handled'
  }

  /**
   * Treat a chat message as the answer to the channel's open question.
   * @returns whether a question was open and took the text.
   */
  answerQuestionText(channelId: string, text: string): boolean {
    if (text.trim() === '') return false
    for (const [token, pending] of this.questions) {
      const question = pending.questions[pending.answers.length]
      if (pending.channelId !== channelId || question === undefined) continue
      this.recordAnswer(token, pending, typedAnswer(question, text))
      return true
    }
    return false
  }

  // ----------------------------------------------------------------- lifecycle

  /** Stop timers, drop pending cards (Desktop keeps answering them), and drain queued writes. */
  async close(): Promise<void> {
    this.closed = true
    for (const state of this.turns.values()) {
      if (state.typingTimer !== undefined) clearInterval(state.typingTimer)
      if (state.progressTimer !== undefined) clearTimeout(state.progressTimer)
    }
    this.turns.clear()
    this.approvals.clear()
    for (const pending of this.questions.values()) pending.abandon()
    await Promise.allSettled([...this.queues.values()])
  }
}
