/** discord.js gateway client: access control, message routing, interactions, and the ChatTransport. */

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  ModalBuilder,
  Partials,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  type AutocompleteInteraction,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Interaction,
  type Message,
  type MessageActionRowComponentBuilder,
  type ModalSubmitInteraction,
  type SendableChannels,
  type StringSelectMenuInteraction,
  type TextBasedChannel,
} from 'discord.js'
import { BridgeError, type Bridge, type LoggerLike, type QuestionInteractionResult } from './bridge.ts'
import { CommandRouter, slashCommands, threadName, type CommandPlace } from './commands.ts'
import type { Config } from './config.ts'
import type { PromptPart } from './dsh.ts'
import { truncate } from './format.ts'
import type { QuestionModal } from './questions.ts'
import type { ChatTransport, OutgoingButton, OutgoingMessage } from './transport.ts'

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
type ImageType = Extract<PromptPart, { type: 'image' }>['mediaType']

/** Gateway runtime implementing {@link ChatTransport}. */
export class DiscordRuntime implements ChatTransport {
  private readonly client: Client
  private readonly router: CommandRouter
  private stopped = false

  constructor(
    private readonly bridge: Bridge,
    private readonly config: Config,
    private readonly logger: LoggerLike,
  ) {
    this.router = new CommandRouter(bridge, config.commandPrefix)
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
      ],
      partials: [Partials.Channel, Partials.Message],
      allowedMentions: { parse: [] },
    })
    this.client.once(Events.ClientReady, client => { void this.onReady(client.user.tag) })
    this.client.on(Events.MessageCreate, message => { void this.onMessage(message) })
    this.client.on(Events.InteractionCreate, interaction => { void this.onInteraction(interaction) })
    this.client.on(Events.Error, error => { this.logger.warn(`discord: client error: ${error.message}`) })
  }

  /** Whether the gateway session is ready. */
  get ready(): boolean {
    return !this.stopped && this.client.isReady()
  }

  /** Log in; resolves once the login request is accepted. */
  async start(token: string): Promise<void> {
    await this.client.login(token)
  }

  /** Close the gateway connection. */
  async stop(): Promise<void> {
    this.stopped = true
    await this.client.destroy()
  }

  private async onReady(tag: string): Promise<void> {
    this.logger.info(`discord: logged in as ${tag}`)
    if (!this.config.registerCommands) return
    try {
      await this.client.application?.commands.set(slashCommands())
      this.logger.info('discord: slash commands registered')
    } catch (error: unknown) {
      this.logger.warn(`discord: slash command registration failed: ${describe(error)}`)
    }
  }

  // ------------------------------------------------------------ access control

  private allowed(userId: string, guildId: string | null, channelId: string, parentId: string | null): boolean {
    if (!this.config.allowedUserIds.includes(userId)) return false
    if (guildId === null) return true
    if (this.config.allowedGuildIds.length > 0 && !this.config.allowedGuildIds.includes(guildId)) return false
    if (this.config.allowedChannelIds.length > 0
      && !this.config.allowedChannelIds.includes(channelId)
      && (parentId === null || !this.config.allowedChannelIds.includes(parentId))) return false
    return true
  }

  private place(channel: TextBasedChannel, starter?: Message): CommandPlace | undefined {
    if (channel.isDMBased()) return { channelId: channel.id, kind: 'dm' }
    if (channel.isThread()) {
      return channel.parentId === null
        ? { channelId: channel.id, kind: 'thread' }
        : { channelId: channel.id, parentId: channel.parentId, kind: 'thread' }
    }
    if (channel.type !== ChannelType.GuildText) return undefined
    return {
      channelId: channel.id,
      kind: 'text',
      openThread: async (name) => {
        const thread = starter === undefined
          ? await channel.threads.create({ name, autoArchiveDuration: 1440 })
          : await starter.startThread({ name, autoArchiveDuration: 1440 })
        return thread.id
      },
    }
  }

  // ------------------------------------------------------------------ messages

  private async onMessage(message: Message): Promise<void> {
    if (message.author.bot || this.stopped) return
    if (message.partial) {
      try {
        await message.fetch()
      } catch (error: unknown) {
        this.logger.debug(`discord: partial message fetch failed: ${describe(error)}`)
        return
      }
    }
    const channel = message.channel
    const parentId = channel.isThread() ? channel.parentId : null
    if (!this.allowed(message.author.id, message.guildId, channel.id, parentId)) return
    const place = this.place(channel, message)
    if (place === undefined) return
    try {
      const text = message.content.trim()
      if (text.startsWith(this.config.commandPrefix)) {
        const handled = await this.textCommand(place, text.slice(this.config.commandPrefix.length), message)
        if (handled) return
      }
      // While the model waits on a question here, a plain message answers it.
      if (this.bridge.answerQuestionText(place.channelId, text)) {
        await message.react('✅').catch(() => undefined)
        return
      }
      const parts = await this.promptParts(message)
      if (parts.length === 0) return
      if (this.bridge.boundSession(place.channelId) !== undefined) {
        await this.bridge.prompt(place.channelId, parts)
        await message.react('👀').catch(() => undefined)
        return
      }
      const result = await this.router.newSession(place, parts)
      if (result.movedTo === undefined) await message.react('👀').catch(() => undefined)
      else this.bridge.post(result.channelId, { content: result.reply })
    } catch (error: unknown) {
      await this.replyError(message, error)
    }
  }

  /** @returns whether the text was a known command. */
  private async textCommand(place: CommandPlace, body: string, message: Message): Promise<boolean> {
    const [rawName = '', ...rest] = body.split(/\s+/)
    const arg = rest.join(' ').trim()
    const name = rawName.toLowerCase()
    let reply: string
    switch (name) {
      case 'help':
        reply = this.router.help()
        break
      case 'ws':
        reply = this.router.listWorkspaces(place)
        break
      case 'use':
        reply = this.router.useWorkspace(place, arg)
        break
      case 'sessions':
        reply = await this.router.listSessions(place, arg === '' ? undefined : arg)
        break
      case 'new': {
        const result = await this.router.newSession(place, arg === '' ? [] : [{ type: 'text', text: arg }])
        reply = result.reply
        if (result.movedTo !== undefined) this.bridge.post(result.movedTo, { content: result.reply })
        break
      }
      case 'attach':
        reply = (await this.router.attach(place, arg)).reply
        break
      case 'detach':
        reply = this.router.detach(place)
        break
      case 'stop':
        reply = this.router.stop(place)
        break
      case 'steer':
        reply = await this.router.steer(place, arg)
        break
      case 'status':
        reply = await this.router.status(place)
        break
      default:
        return false
    }
    await this.replyText(message, reply)
    return true
  }

  private async promptParts(message: Message): Promise<PromptPart[]> {
    const parts: PromptPart[] = []
    const notes: string[] = []
    for (const attachment of message.attachments.values()) {
      const type = attachment.contentType?.split(';')[0]?.trim() ?? ''
      if (IMAGE_TYPES.has(type) && attachment.size <= this.config.maxImageBytes) {
        try {
          const response = await fetch(attachment.url)
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          const data = Buffer.from(await response.arrayBuffer()).toString('base64')
          parts.push({ type: 'image', mediaType: type as ImageType, data, name: attachment.name })
          continue
        } catch (error: unknown) {
          this.logger.warn(`discord: image download failed: ${describe(error)}`)
        }
      }
      notes.push(`[附件] ${attachment.name} (${type || 'unknown'}, ${attachment.size} bytes): ${attachment.url}`)
    }
    const text = [message.content.trim(), ...notes].filter(item => item !== '').join('\n')
    if (text !== '') parts.unshift({ type: 'text', text })
    return parts
  }

  private async replyText(message: Message, text: string): Promise<void> {
    await message.reply({ content: truncate(text, 2000), allowedMentions: { parse: [], repliedUser: false } })
  }

  private async replyError(message: Message, error: unknown): Promise<void> {
    if (!(error instanceof BridgeError)) this.logger.warn(`discord: message handling failed: ${describe(error)}`)
    await this.replyText(message, `⚠️ ${describe(error)}`).catch(() => undefined)
  }

  // -------------------------------------------------------------- interactions

  private async onInteraction(interaction: Interaction): Promise<void> {
    if (this.stopped) return
    const channel = interaction.channel
    const parentId = channel?.isThread() === true ? channel.parentId : null
    const permitted = channel !== null && this.allowed(interaction.user.id, interaction.guildId, channel.id, parentId)
    try {
      if (interaction.isAutocomplete()) {
        await (permitted && channel !== null ? this.autocomplete(interaction, channel) : interaction.respond([]))
      } else if (interaction.isButton() || interaction.isStringSelectMenu() || interaction.isModalSubmit()) {
        await (permitted ? this.component(interaction) : interaction.reply({ content: '无权操作。', ephemeral: true }))
      } else if (interaction.isChatInputCommand()) {
        if (!permitted || channel === null) {
          await interaction.reply({ content: '无权使用这个机器人（请把你的用户 ID 加入 allowedUserIds）。', ephemeral: true })
          return
        }
        await this.slash(interaction, channel)
      }
    } catch (error: unknown) {
      this.logger.warn(`discord: interaction failed: ${describe(error)}`)
    }
  }

  private async autocomplete(interaction: AutocompleteInteraction, channel: TextBasedChannel): Promise<void> {
    const focused = interaction.options.getFocused(true)
    const place = this.place(channel)
    if (focused.name === 'workspace') {
      await interaction.respond(this.router.workspaceChoices(focused.value))
    } else if (focused.name === 'session' && place !== undefined) {
      await interaction.respond(await this.router.sessionChoices(place, focused.value))
    } else {
      await interaction.respond([])
    }
  }

  private async component(interaction: ButtonInteraction | StringSelectMenuInteraction | ModalSubmitInteraction): Promise<void> {
    if (interaction.isButton()) {
      const approval = this.bridge.answerApproval(interaction.customId)
      if (approval === 'stale') {
        await interaction.reply({ content: '这个审批已经处理过或已失效。', ephemeral: true })
        return
      }
      if (approval === 'handled') {
        // The bridge edits the card with the verdict; acknowledge without a new message.
        await interaction.deferUpdate()
        return
      }
    }
    let result: QuestionInteractionResult
    if (interaction.isStringSelectMenu()) result = this.bridge.answerQuestion(interaction.customId, { values: interaction.values })
    else if (interaction.isModalSubmit()) result = this.bridge.answerQuestion(interaction.customId, { text: interaction.fields.getTextInputValue('answer') })
    else result = this.bridge.answerQuestion(interaction.customId)
    if (result === 'foreign') return
    if (result === 'stale') {
      await interaction.reply({ content: '这个问题已经回答过或已失效。', ephemeral: true })
    } else if (result !== 'handled') {
      if (!interaction.isModalSubmit()) await interaction.showModal(modal(result.modal))
    } else if (interaction.isModalSubmit() && !interaction.isFromMessage()) {
      await interaction.reply({ content: '✅ 已记录回答。', ephemeral: true })
    } else {
      await interaction.deferUpdate()
    }
  }

  private async slash(interaction: ChatInputCommandInteraction, channel: TextBasedChannel): Promise<void> {
    const place = this.place(channel)
    if (place === undefined) {
      await interaction.reply({ content: '请在私信、文字频道或线程里使用。', ephemeral: true })
      return
    }
    await interaction.deferReply()
    try {
      const reply = await this.runSlash(interaction, place)
      await interaction.editReply({ content: truncate(reply, 2000), allowedMentions: { parse: [] } })
    } catch (error: unknown) {
      if (!(error instanceof BridgeError)) this.logger.warn(`discord: /${interaction.commandName} failed: ${describe(error)}`)
      await interaction.editReply({ content: truncate(`⚠️ ${describe(error)}`, 2000) })
    }
  }

  private async runSlash(interaction: ChatInputCommandInteraction, place: CommandPlace): Promise<string> {
    const options = interaction.options
    switch (interaction.commandName) {
      case 'ws':
        return this.router.listWorkspaces(place)
      case 'use':
        return this.router.useWorkspace(place, options.getString('workspace', true))
      case 'sessions':
        return this.router.listSessions(place, options.getString('workspace') ?? undefined)
      case 'new': {
        const prompt = options.getString('prompt')
        const slashPlace: CommandPlace = place.kind !== 'text' || interaction.channel?.type !== ChannelType.GuildText
          ? place
          : { ...place, openThread: async (name) => (await this.threadFromReply(interaction, name)) }
        const result = await this.router.newSession(slashPlace, prompt === null ? [] : [{ type: 'text', text: prompt }], options.getString('workspace') ?? undefined)
        if (result.movedTo !== undefined && prompt !== null) this.bridge.post(result.movedTo, { content: `> ${truncate(prompt, 1800)}` })
        return result.reply
      }
      case 'attach':
        return (await this.router.attach(place, options.getString('session', true))).reply
      case 'detach':
        return this.router.detach(place)
      case 'stop':
        return this.router.stop(place)
      case 'steer':
        return this.router.steer(place, options.getString('text', true))
      case 'status':
        return this.router.status(place)
      default:
        return this.router.help()
    }
  }

  /** Open a thread on the deferred slash reply so the conversation hangs off the command. */
  private async threadFromReply(interaction: ChatInputCommandInteraction, name: string): Promise<string> {
    const reply = await interaction.fetchReply()
    const thread = await reply.startThread({ name: threadName(name), autoArchiveDuration: 1440 })
    return thread.id
  }

  // ----------------------------------------------------------------- transport

  private async sendable(channelId: string): Promise<SendableChannels> {
    const channel = this.client.channels.cache.get(channelId) ?? await this.client.channels.fetch(channelId)
    if (channel === null || !channel.isSendable()) {
      throw new Error(`channel ${channelId} is not a sendable text channel`)
    }
    return channel
  }

  /** @inheritdoc */
  async send(channelId: string, message: OutgoingMessage): Promise<string> {
    const channel = await this.sendable(channelId)
    const sent = await channel.send({ ...render(message), allowedMentions: { parse: [] } })
    return sent.id
  }

  /** @inheritdoc */
  async edit(channelId: string, messageId: string, message: OutgoingMessage): Promise<void> {
    const channel = await this.sendable(channelId)
    const existing = await channel.messages.fetch(messageId)
    await existing.edit(render(message))
  }

  /** @inheritdoc */
  async typing(channelId: string): Promise<void> {
    const channel = await this.sendable(channelId)
    await channel.sendTyping()
  }

  /** @inheritdoc */
  async renameThread(channelId: string, name: string): Promise<void> {
    const channel = this.client.channels.cache.get(channelId) ?? await this.client.channels.fetch(channelId)
    if (channel?.isThread() !== true || channel.name === name) return
    await channel.setName(threadName(name))
  }
}

const BUTTON_STYLES: Record<OutgoingButton['style'], ButtonStyle> = {
  primary: ButtonStyle.Primary,
  success: ButtonStyle.Success,
  danger: ButtonStyle.Danger,
  secondary: ButtonStyle.Secondary,
}

/** @returns discord.js message options for one outgoing message: the select menu, then buttons five per row. */
export function render(message: OutgoingMessage): { content: string; components: ActionRowBuilder<MessageActionRowComponentBuilder>[] } {
  const components: ActionRowBuilder<MessageActionRowComponentBuilder>[] = []
  const select = message.select
  if (select !== undefined) {
    components.push(new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(new StringSelectMenuBuilder()
      .setCustomId(select.id)
      .setPlaceholder(select.placeholder)
      .setMinValues(select.minValues)
      .setMaxValues(select.maxValues)
      .addOptions(select.options.map(option => ({ ...option })))))
  }
  const buttons = message.buttons ?? []
  for (let start = 0; start < buttons.length; start += 5) {
    components.push(new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(buttons.slice(start, start + 5).map(button => new ButtonBuilder()
      .setCustomId(button.id)
      .setLabel(button.label)
      .setStyle(BUTTON_STYLES[button.style]))))
  }
  return { content: message.content, components }
}

/** @returns the text-answer modal; its input id is `answer`. */
export function modal(spec: QuestionModal): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(spec.id)
    .setTitle(spec.title)
    .addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder()
      .setCustomId('answer')
      .setLabel(spec.label)
      .setPlaceholder(spec.placeholder)
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(true)
      .setMaxLength(4000)))
}

/** @returns a printable error message. */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
