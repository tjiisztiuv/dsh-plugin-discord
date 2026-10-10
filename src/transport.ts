/** The chat surface the bridge writes to; `discord.ts` implements it with discord.js. */

/** One button on an outgoing message. */
export interface OutgoingButton {
  /** Discord `custom_id`, at most 100 characters. */
  readonly id: string
  readonly label: string
  readonly style: 'success' | 'danger' | 'secondary'
}

/** One outgoing message body. */
export interface OutgoingMessage {
  /** At most 2000 characters. */
  readonly content: string
  /** Buttons rendered in one row; an empty list removes existing buttons on edit. */
  readonly buttons?: readonly OutgoingButton[]
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
