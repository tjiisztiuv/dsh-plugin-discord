/** Slash-command declarations and the shared command routing for slash and text commands. */

import {
  ApplicationIntegrationType,
  InteractionContextType,
  SlashCommandBuilder,
} from 'discord.js'
import { BridgeError, type Bridge, type SessionRow } from './bridge.ts'
import type { PromptPart, SessionId } from './dsh.ts'
import { relativeTime, truncate } from './format.ts'

/** Where a command was issued. */
export interface CommandPlace {
  /** Channel id: DM channel, thread, or guild text channel. */
  readonly channelId: string
  /** Parent text channel of a thread. */
  readonly parentId?: string
  readonly kind: 'dm' | 'thread' | 'text'
  /**
   * Open a thread in a guild text channel for a new Session.
   * @returns the thread channel id.
   */
  readonly openThread?: (name: string) => Promise<string>
}

/** Result of one command: text to show plus the channel where the Session now lives. */
export interface CommandResult {
  readonly reply: string
  /** Channel that received a fresh binding, when different from the issuing channel. */
  readonly movedTo?: string
}

/** @returns slash command JSON bodies for global registration. */
export function slashCommands(): ReturnType<SlashCommandBuilder['toJSON']>[] {
  const base = (name: string, description: string): SlashCommandBuilder => new SlashCommandBuilder()
    .setName(name)
    .setDescription(description)
    .setContexts(InteractionContextType.Guild, InteractionContextType.BotDM)
    .setIntegrationTypes(ApplicationIntegrationType.GuildInstall)
  return [
    base('ws', '列出 DeepSeek Harness 工作区'),
    base('use', '切换这里使用的工作区（会解绑别的工作区的会话）')
      .addStringOption(o => o.setName('workspace').setDescription('工作区').setRequired(true).setAutocomplete(true)),
    base('new', '新建会话（可直接带上第一条消息）')
      .addStringOption(o => o.setName('prompt').setDescription('第一条消息'))
      .addStringOption(o => o.setName('workspace').setDescription('工作区（默认用这里选定的）').setAutocomplete(true)),
    base('sessions', '列出最近的会话')
      .addStringOption(o => o.setName('workspace').setDescription('只看某个工作区').setAutocomplete(true)),
    base('attach', '接入一个已有会话（例如桌面端正在用的）')
      .addStringOption(o => o.setName('session').setDescription('会话').setRequired(true).setAutocomplete(true)),
    base('detach', '解除这里与会话的绑定（不会删除会话）'),
    base('stop', '停止当前会话正在运行的任务'),
    base('steer', '在当前任务运行中插话引导')
      .addStringOption(o => o.setName('text').setDescription('引导内容').setRequired(true)),
    base('status', '查看这里绑定的工作区与会话'),
  ].map(command => command.toJSON())
}

/** Command implementations shared by slash commands and `!` text commands. */
export class CommandRouter {
  constructor(private readonly bridge: Bridge, private readonly prefix: string) {}

  /** Usage text for `!help`. */
  help(): string {
    const p = this.prefix
    return [
      '**DeepSeek Harness · Discord**',
      '直接发消息 = 发给这里绑定的会话；没有绑定时会在默认工作区新建会话。',
      `\`/ws\` 或 \`${p}ws\` 列出工作区　\`/use\` 或 \`${p}use <名称|序号>\` 切换工作区`,
      `\`/new [prompt]\` 或 \`${p}new [内容]\` 新建会话　\`/sessions\` 或 \`${p}sessions\` 最近会话`,
      `\`/attach\` 或 \`${p}attach <序号>\` 接入已有会话　\`/detach\` 解绑`,
      `\`/stop\` 或 \`${p}stop\` 停止　\`/steer\` 或 \`${p}steer <内容>\` 运行中插话　\`/status\` 状态`,
      '模型提问时：点卡片上的按钮，或直接回复选项序号 / 文字。',
    ].join('\n')
  }

  /** `/ws` */
  listWorkspaces(place: CommandPlace): string {
    const list = this.bridge.workspaces()
    if (list.length === 0) return '还没有工作区，请先在桌面端添加一个项目目录。'
    const current = this.bridge.workspaceFor(this.chain(place))
    const rows = list.map((ws, index) => `${ws.id === current?.id ? '👉' : '　'} **${index + 1}. ${ws.title}** · \`${ws.path}\` · ${ws.sessionIds.length} 个会话`)
    return ['**工作区**', ...rows, '', '用 `/use` 选择这里默认使用的工作区。'].join('\n')
  }

  /**
   * `/use`: choose the Workspace here. A binding to another Workspace's Session
   * is released so the next message starts a Session in the chosen one.
   */
  useWorkspace(place: CommandPlace, query: string): string {
    const ws = this.bridge.resolveWorkspace(query)
    this.bridge.useWorkspace(place.kind === 'thread' && place.parentId !== undefined ? place.parentId : place.channelId, ws)
    const picked = `📁 已选择工作区 **${ws.title}**（\`${ws.path}\`）`
    const bound = this.bridge.boundWorkspace(place.channelId)
    if (bound === undefined) return `${picked}。直接发消息即可新建会话。`
    if (bound.id === ws.id) return `${picked}。这里仍接着当前会话，要另开新会话用 \`/new\`。`
    this.bridge.detach(place.channelId)
    return `${picked}。原来 **${bound.title}** 的会话已解绑（仍保留在桌面端），直接发消息即可在 **${ws.title}** 新建会话。`
  }

  /** `/sessions`; also caches the numbered list for `!attach <n>`. */
  async listSessions(place: CommandPlace, query?: string): Promise<string> {
    const ws = query === undefined || query.trim() === '' ? this.bridge.workspaceFor(this.chain(place)) : this.bridge.resolveWorkspace(query)
    const rows = await this.bridge.sessionRows(ws)
    this.lastListing.set(place.channelId, rows)
    if (rows.length === 0) return ws === undefined ? '还没有会话。' : `工作区 **${ws.title}** 还没有会话。`
    const bound = this.bridge.boundSession(place.channelId)
    const now = Date.now()
    const lines = rows.map((row, index) => {
      const marks = `${row.running ? '▶️' : ''}${row.sessionId === bound ? '📍' : ''}`
      const where = ws === undefined && row.workspace !== undefined ? ` · ${row.workspace.title}` : ''
      return `**${index + 1}.** ${marks}${truncate(row.title, 60)}${where} · ${relativeTime(row.updatedAt, now)}`
    })
    return [`**最近会话**${ws === undefined ? '' : ` · ${ws.title}`}`, ...lines, '', `用 \`/attach\` 或 \`${this.prefix}attach <序号>\` 接入。`].join('\n')
  }

  /** Numbered rows from the last `/sessions` per channel. */
  private readonly lastListing = new Map<string, SessionRow[]>()

  /**
   * `/new`: create a Session and bind it here (or in a fresh thread).
   * @returns the reply and the bound channel.
   */
  async newSession(place: CommandPlace, prompt: readonly PromptPart[], workspaceQuery?: string): Promise<CommandResult & { readonly channelId: string }> {
    const ws = workspaceQuery === undefined || workspaceQuery.trim() === ''
      ? this.bridge.workspaceFor(this.chain(place))
      : this.bridge.resolveWorkspace(workspaceQuery)
    if (ws === undefined) throw new BridgeError('还没选工作区：先用 `/use` 选择，或在 `/new` 里指定 workspace。')
    const firstText = prompt.find(part => part.type === 'text')
    const target = await this.targetChannel(place, firstText?.type === 'text' ? firstText.text : '新会话')
    const sessionId = await this.bridge.createSession(ws)
    this.bridge.bind(target.channelId, sessionId, ws, target.ownsThread)
    if (prompt.length > 0) await this.bridge.prompt(target.channelId, prompt)
    const reply = `🆕 已在 **${ws.title}** 新建会话${prompt.length > 0 ? '，正在处理…' : '，直接发消息开始。'}`
    return target.channelId === place.channelId
      ? { reply, channelId: target.channelId }
      : { reply: `${reply} → <#${target.channelId}>`, movedTo: target.channelId, channelId: target.channelId }
  }

  /** `/attach` by Session id, or by list number from the last `/sessions`. */
  async attach(place: CommandPlace, query: string): Promise<CommandResult> {
    const trimmed = query.trim()
    let row: SessionRow | undefined
    if (/^\d+$/.test(trimmed)) {
      row = this.lastListing.get(place.channelId)?.[Number(trimmed) - 1]
      if (row === undefined) throw new BridgeError('序号无效：先用 `/sessions` 列出会话。')
    } else {
      row = await this.bridge.sessionRow(trimmed as SessionId)
      if (row === undefined) throw new BridgeError('找不到这个会话。')
    }
    const ws = row.workspace ?? this.bridge.workspaceOfSession(row.sessionId)
    if (ws === undefined) throw new BridgeError('这个会话不属于任何工作区，无法接入。')
    const target = await this.targetChannel(place, row.title)
    this.bridge.bind(target.channelId, row.sessionId, ws, target.ownsThread)
    const reply = `🔗 已接入「${truncate(row.title, 80)}」（${ws.title}）${row.running ? '，正在运行中' : ''}。之后的回复会同步到这里。`
    if (target.channelId !== place.channelId) {
      this.bridge.post(target.channelId, { content: reply })
      return { reply: `${reply} → <#${target.channelId}>`, movedTo: target.channelId }
    }
    return { reply }
  }

  /** `/detach` */
  detach(place: CommandPlace): string {
    return this.bridge.detach(place.channelId) ? '🔓 已解绑，会话仍保留在桌面端。' : '这里没有绑定会话。'
  }

  /** `/stop` */
  stop(place: CommandPlace): string {
    return this.bridge.stop(place.channelId) ? '⏹ 已请求停止。' : '当前没有运行中的任务。'
  }

  /** `/steer` */
  async steer(place: CommandPlace, text: string): Promise<string> {
    await this.bridge.prompt(place.channelId, [{ type: 'text', text }], 'steer')
    return '🧭 已插话。'
  }

  /** `/status` */
  async status(place: CommandPlace): Promise<string> {
    const sessionId = this.bridge.boundSession(place.channelId)
    const ws = this.bridge.workspaceFor(this.chain(place))
    const lines = [`默认工作区：${ws === undefined ? '（未选择）' : `**${ws.title}** \`${ws.path}\``}`]
    if (sessionId === undefined) lines.push('绑定会话：无（直接发消息会新建）')
    else {
      const row = await this.bridge.sessionRow(sessionId)
      lines.push(`绑定会话：**${truncate(row?.title ?? sessionId, 80)}**${row?.workspace === undefined ? '' : `（${row.workspace.title}）`}`)
      lines.push(`状态：${row?.running === true ? '▶️ 运行中' : '空闲'}`)
    }
    return lines.join('\n')
  }

  /** Autocomplete choices for a Workspace option. */
  workspaceChoices(focused: string): { name: string; value: string }[] {
    const needle = focused.toLowerCase()
    return this.bridge.workspaces()
      .filter(ws => needle === '' || ws.title.toLowerCase().includes(needle) || ws.path.toLowerCase().includes(needle))
      .slice(0, 25)
      .map(ws => ({ name: truncate(`${ws.title} — ${ws.path}`, 100), value: ws.id }))
  }

  /** Autocomplete choices for a Session option. */
  async sessionChoices(place: CommandPlace, focused: string): Promise<{ name: string; value: string }[]> {
    const rows = await this.bridge.sessionRows(undefined, 100)
    const preferred = this.bridge.workspaceFor(this.chain(place))
    const needle = focused.toLowerCase()
    return rows
      .filter(row => needle === '' || row.title.toLowerCase().includes(needle) || (row.workspace?.title.toLowerCase().includes(needle) ?? false))
      .sort((a, b) => Number(b.workspace?.id === preferred?.id) - Number(a.workspace?.id === preferred?.id))
      .slice(0, 25)
      .map(row => ({
        name: truncate(`${row.running ? '▶ ' : ''}${row.title}${row.workspace === undefined ? '' : ` · ${row.workspace.title}`}`, 100),
        value: row.sessionId,
      }))
  }

  private chain(place: CommandPlace): string[] {
    return place.parentId === undefined ? [place.channelId] : [place.channelId, place.parentId]
  }

  private async targetChannel(place: CommandPlace, title: string): Promise<{ channelId: string; ownsThread: boolean }> {
    if (place.kind === 'text') {
      if (place.openThread === undefined) throw new BridgeError('无法在这个频道创建线程。')
      return { channelId: await place.openThread(threadName(title)), ownsThread: true }
    }
    return { channelId: place.channelId, ownsThread: place.kind === 'thread' && this.bridge.ownsThread(place.channelId) }
  }
}

/** @returns a valid Discord thread name derived from text. */
export function threadName(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return truncate(line === '' ? '新会话' : line, 90)
}
