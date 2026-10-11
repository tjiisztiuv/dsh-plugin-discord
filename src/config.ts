/** Deployment configuration, validated by Cordis when the plugin row loads. */

import Schema from '@deepseek-ai/schemastery'

/** How tool approvals reach Discord. */
export type ApprovalMode = 'race' | 'desktop'

/** How `ask_user_question` questions reach Discord. */
export type QuestionMode = 'race' | 'desktop'

/** How tool calls are reported in Discord. */
export type ToolCallMode = 'off' | 'compact'

/** Plugin configuration (`cordis.patch.yml` row `discord`). */
export interface Config {
  /** Credential reference (environment-variable name) holding the bot token. */
  tokenEnv: string
  /** Discord user ids allowed to drive the Harness. Empty keeps the bot offline. */
  allowedUserIds: string[]
  /** Optional guild allowlist; empty allows every guild the bot joined. DMs are unaffected. */
  allowedGuildIds: string[]
  /** Optional text-channel allowlist (threads match their parent). DMs are unaffected. */
  allowedChannelIds: string[]
  /** Absolute JSON file that stores channel bindings. */
  stateFile: string
  /** Workspace (title, path, or id) used when a channel has none selected. */
  defaultWorkspace?: string
  /** IANA time zone sent with prompts; defaults to the Host's zone. */
  timeZone?: string
  /** `race`: Discord and Desktop both offer approvals, first answer wins. `desktop`: leave approvals to Desktop. */
  approvals: ApprovalMode
  /** `race`: Discord and Desktop both offer model questions, first answer wins. `desktop`: leave them to Desktop. */
  questions: QuestionMode
  /** Tool-call progress rendering. */
  toolCalls: ToolCallMode
  /** Render model reasoning blocks as quotes. */
  showReasoning: boolean
  /** Echo prompts typed in Desktop into the bound Discord channel. */
  mirrorDesktopInput: boolean
  /** Register slash commands globally when the bot connects. */
  registerCommands: boolean
  /** Text prefix for message commands such as `!stop`. */
  commandPrefix: string
  /** Maximum characters per Discord message (Discord caps at 2000). */
  messageChunkSize: number
  /** Most recent Sessions listed by `/sessions` and autocomplete. */
  sessionListLimit: number
  /** Tool-call lines kept in one progress message. */
  progressMaxLines: number
  /** Minimum milliseconds between edits of a progress message. */
  progressEditIntervalMs: number
  /** Milliseconds between typing indicators while a turn runs. */
  typingIntervalMs: number
  /** Largest image attachment forwarded to the model, in bytes. */
  maxImageBytes: number
  /** Characters of tool arguments shown on an approval card. */
  approvalArgumentChars: number
  /** Milliseconds a Host request (create, prompt, list) may take. */
  requestTimeoutMs: number
}

export const Config: Schema<Config> = Schema.object({
  tokenEnv: Schema.string().role('credential-ref').default('DISCORD_BOT_TOKEN')
    .description('Bot token credential reference (environment-variable name).'),
  allowedUserIds: Schema.array(Schema.string()).default([])
    .description('Discord user ids allowed to use the bot. Required: the bot stays offline while empty.'),
  allowedGuildIds: Schema.array(Schema.string()).default([]),
  allowedChannelIds: Schema.array(Schema.string()).default([]),
  stateFile: Schema.string().required(),
  defaultWorkspace: Schema.string(),
  timeZone: Schema.string(),
  approvals: Schema.union(['race', 'desktop']).default('race'),
  questions: Schema.union(['race', 'desktop']).default('race'),
  toolCalls: Schema.union(['off', 'compact']).default('compact'),
  showReasoning: Schema.boolean().default(false),
  mirrorDesktopInput: Schema.boolean().default(true),
  registerCommands: Schema.boolean().default(true),
  commandPrefix: Schema.string().default('!'),
  messageChunkSize: Schema.natural().min(200).max(2000).default(1900),
  sessionListLimit: Schema.natural().min(1).max(25).default(10),
  progressMaxLines: Schema.natural().min(1).max(40).default(12),
  progressEditIntervalMs: Schema.natural().min(250).default(1500),
  typingIntervalMs: Schema.natural().min(1000).default(8000),
  maxImageBytes: Schema.natural().min(1).default(8 * 1024 * 1024),
  approvalArgumentChars: Schema.natural().min(0).max(1500).default(900),
  requestTimeoutMs: Schema.natural().min(1000).default(60_000),
})
