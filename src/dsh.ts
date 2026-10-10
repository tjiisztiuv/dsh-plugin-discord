/**
 * The narrow DeepSeek Harness Host surface this plugin consumes, written as
 * structural types so the plugin does not pin exact `@deepseek-ai/dsh-*`
 * versions. `compat/surface.check.ts` asserts these against the real Harness
 * source when a sibling checkout is available (`npm run typecheck:compat`).
 */

/** Session identity (`SessionId` brand in Harness). */
export type SessionId = string & { readonly __dshSessionId?: never }
/** Workspace identity (`WorkspaceId` brand in Harness). */
export type WorkspaceId = string & { readonly __dshWorkspaceId?: never }
/** Client-minted prompt identity (`SessionRequestId` brand in Harness). */
export type SessionRequestId = string & { readonly __dshSessionRequestId?: never }

/** One registered Workspace (`dsh-workspace` `Workspace`). */
export interface WorkspaceLike {
  readonly id: WorkspaceId
  readonly path: string
  readonly title: string
  readonly sessionIds: readonly SessionId[]
}

/** `ctx.workspaceRegistry` methods this plugin uses. */
export interface WorkspaceRegistryLike {
  list(): WorkspaceLike[]
  get(id: WorkspaceId): WorkspaceLike | undefined
  readonly archivedSessionIds: readonly SessionId[]
}

/** One `sessionController.list` row. */
export interface SessionSummaryLike {
  readonly sessionId: SessionId
  readonly updatedAt: number
  readonly running: boolean
  readonly blank: boolean
  readonly origin?: 'subagent'
  readonly cwd?: string
  readonly projections?: { readonly values: { readonly title?: string | null } }
}

/** Prompt part accepted by `sessionController.prompt`; this plugin sends text and images. */
export type PromptPart =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image'; readonly mediaType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'; readonly data: string; readonly name?: string }
  | { readonly type: 'file'; readonly receiptId: string }

/** `ctx.sessionController`: the same Host business API the Web/Desktop client calls. */
export interface SessionControllerLike {
  list(request: { readonly cursor?: string }, signal: AbortSignal): Promise<{ readonly items: readonly SessionSummaryLike[] }>
  create(request: { readonly workspaceId?: WorkspaceId }): Promise<{ readonly sessionId: SessionId }>
  prompt(request: {
    readonly requestId: SessionRequestId
    readonly sessionId: SessionId
    readonly mode: 'queue' | 'steer'
    readonly content: readonly PromptPart[]
    readonly clientTimeZone?: string
  }, signal: AbortSignal): Promise<{ readonly accepted: true }>
  cancel(request: { readonly sessionId: SessionId }): { readonly accepted: true }
}

/** Content block subset this plugin renders. */
export type ContentBlockLike =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'reasoning'; readonly text: string }
  | { readonly type: string }

/** Message source subset this plugin reads. */
export interface MessageSourceLike {
  readonly kind: string
  readonly rpcId?: string
}

/** Durable Session event subset this plugin renders. */
export type SessionEventLike =
  | { readonly type: 'turn/start'; readonly data: { readonly turn: number } }
  | { readonly type: 'turn/end'; readonly data: { readonly turn: number; readonly reason: TurnEndReasonLike } }
  | { readonly type: 'user/message'; readonly data: { readonly content: readonly ContentBlockLike[]; readonly source: MessageSourceLike } }
  | { readonly type: 'assistant/message'; readonly data: { readonly message: { readonly content: readonly ContentBlockLike[] }; readonly interrupted?: true } }
  | { readonly type: 'tool/call'; readonly data: { readonly callId: string; readonly name: string; readonly arguments: string } }
  | { readonly type: 'tool/result'; readonly data: { readonly message: { readonly toolCallId: string; readonly isError?: boolean } } }
  | { readonly type: 'session/title'; readonly data: { readonly title: string } }

/** `turn/end` reasons this plugin words; others fall through to a generic line. */
export type TurnEndReasonLike =
  | { readonly kind: 'completed' }
  | { readonly kind: 'aborted' }
  | { readonly kind: 'error'; readonly error: { readonly message: string } }
  | { readonly kind: 'max-tokens' }
  | { readonly kind: string }

/** Closed approval outcomes (`dsh-user-approval`). */
export type ApprovalOutcomeLike = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'

/** The approval waterfall request fields this plugin reads. */
export interface ApprovalRequestLike {
  readonly agent: { readonly id: SessionId }
  readonly toolName: string
  readonly callId?: string
  readonly reason?: string
  readonly signal?: AbortSignal
}

/** `ctx.credentials` resolution. */
export interface CredentialsLike {
  resolve(ref: string): Promise<{ readonly value: string } | undefined>
}

/** Read the machine-routing code of a Harness `RemoteError`, when present. */
export function remoteErrorCode(error: unknown): string | undefined {
  if (error === null || typeof error !== 'object') return undefined
  const code: unknown = Reflect.get(error, 'code')
  return typeof code === 'string' ? code : undefined
}
