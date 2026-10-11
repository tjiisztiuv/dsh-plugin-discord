/** The chat surface the bridge writes to; `discord.ts` implements it with discord.js. */

/** One button on an outgoing message. */
export interface OutgoingButton {
  /** Discord `custom_id`, at most 100 characters. */
  readonly id: string
  /** At most 80 characters. */
  readonly label: string
  readonly style: 'primary' | 'success' | 'danger' | 'secondary'
}

/** One option of a select menu. */
export interface OutgoingSelectOption {
  /** At most 100 characters. */
  readonly label: string
  readonly value: string
  /** At most 100 characters. */
  readonly description?: string
}

/** A string select menu rendered above the buttons. */
export interface OutgoingSelect {
  /** Discord `custom_id`, at most 100 characters. */
  readonly id: string
  /** At most 150 characters. */
  readonly placeholder: string
  /** At most 25 options. */
  readonly options: readonly OutgoingSelectOption[]
  readonly minValues: number
  readonly maxValues: number
}

/** One outgoing message body. */
export interface OutgoingMessage {
  /** At most 2000 characters. */
  readonly content: string
  /**
   * Buttons laid out five per row, at most 25, or 20 with a select menu.
   * An edit without buttons or a select menu removes existing components.
   */
  readonly buttons?: readonly OutgoingButton[]
  readonly select?: OutgoingSelect
}

/** Channel operations addressed by Discord channel id (DMs and threads included). */
export interface ChatTransport {
  /** Whether the gateway connection is ready. */
  readonly ready: boolean
  /** @returns the new message id. */
  send(channelId: string, message: OutgoingMessage): Promise<string>
  edit(channelId: string, messageId: string, message: OutgoingMessage): Promise<void>
  typing(channelId: string): Promise<void>
  /** Rename a thread; a non-thread channel is ignored. */
  renameThread(channelId: string, name: string): Promise<void>
}
