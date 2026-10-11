/**
 * DeepSeek Harness plugin that bridges Discord to Workspace Sessions.
 *
 * It runs inside the Harness Host (Desktop or `dsh web`), so Sessions created or
 * continued from Discord are ordinary Sessions: they appear live in the Desktop
 * sidebar, use the current default model and agent preset, and follow the same
 * approval policy. Discord threads and DMs bind to Sessions; Session events are
 * rendered back into the bound channel, and tool approvals and model questions
 * can be answered from either side.
 */

import type { Context } from '@deepseek-ai/cordis'
import { Bridge, type AgentsLike } from './bridge.ts'
import { Config } from './config.ts'
import { DiscordRuntime } from './discord.ts'
import type {
  ApprovalOutcomeLike,
  ApprovalRequestLike,
  CredentialsLike,
  QuestionAnswerLike,
  QuestionRequestLike,
  SessionControllerLike,
  SessionEventLike,
  SessionId,
  WorkspaceRegistryLike,
} from './dsh.ts'
import { BindingStore } from './state.ts'

export { Config }
export type { Config as DiscordConfig } from './config.ts'

/** Cordis plugin name. */
export const name = 'dsh-plugin-discord'

/** Host services required before the bridge starts. */
export const inject = ['sessionController', 'workspaceRegistry', 'agents', 'credentials']

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * Mirror of `dsh-session`'s durable event broadcast (subset this plugin reads).
     * @mode emit
     */
    'session/event'(session: { readonly id: SessionId }, event: SessionEventLike): void
    /**
     * Mirror of `dsh-user-approval`'s answerer waterfall (subset this plugin reads).
     * @mode waterfall
     */
    'approval/request'(request: ApprovalRequestLike, next: () => Promise<ApprovalOutcomeLike>): Promise<ApprovalOutcomeLike>
    /**
     * Mirror of `dsh-user-questions`' answerer waterfall (subset this plugin reads).
     * @mode waterfall
     */
    'user-questions/request'(request: QuestionRequestLike, next: () => Promise<QuestionAnswerLike>): Promise<QuestionAnswerLike>
  }
}

/**
 * Start the bridge.
 * @param ctx - plugin context with the injected Host services.
 * @param config - validated configuration.
 */
export function apply(ctx: Context, config: Config): void {
  const logger = ctx.logger
  const credentials = ctx.get('credentials') as CredentialsLike
  const store = new BindingStore(config.stateFile, (error) => {
    logger.warn(`discord: saving ${config.stateFile} failed: ${String(error)}`)
  })
  let runtime: DiscordRuntime | undefined
  const bridge = new Bridge({
    config,
    sessions: ctx.get('sessionController') as SessionControllerLike,
    workspaces: ctx.get('workspaceRegistry') as WorkspaceRegistryLike,
    agents: ctx.get('agents') as AgentsLike,
    store,
    transport: () => runtime,
    logger,
  })

  ctx.on('session/event', (session, event) => {
    bridge.handleSessionEvent(session.id, event)
  })
  ctx.on('approval/request', (request, next) => bridge.handleApproval(request, next), { prepend: true })
  ctx.on('user-questions/request', (request, next) => bridge.handleQuestion(request, next), { prepend: true })

  ctx.effect(() => {
    const lifecycle = new AbortController()
    const started = (async () => {
      if (config.allowedUserIds.length === 0) {
        logger.warn('discord: allowedUserIds is empty; the bot stays offline. Add your Discord user id to the `discord` row config.')
        return
      }
      await store.load()
      const token = await credentials.resolve(config.tokenEnv)
      if (token === undefined) {
        logger.warn(`discord: credential ${config.tokenEnv} is not set; the bot stays offline. Put it in ~/.dsh/.env or the credentials store, then reload the plugin.`)
        return
      }
      if (lifecycle.signal.aborted) return
      const created = new DiscordRuntime(bridge, config, logger)
      runtime = created
      await created.start(token.value)
    })().catch((error: unknown) => {
      logger.error(`discord: start failed: ${error instanceof Error ? error.message : String(error)}`)
    })
    return async () => {
      lifecycle.abort()
      await started
      await bridge.close()
      await runtime?.stop()
      runtime = undefined
      await store.flush()
    }
  }, 'discord: gateway')
}
