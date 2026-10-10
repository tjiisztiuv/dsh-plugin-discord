/**
 * Compile-time proof that the real Harness Host services satisfy the
 * structural surface in `src/dsh.ts`. Run with `npm run typecheck:compat`
 * next to a `deepseek-harness` checkout.
 */

import type { SessionController } from '@deepseek-ai/dsh-api-session-controller'
import type { WorkspaceRegistry } from '@deepseek-ai/dsh-workspace'
import type { AgentRegistry } from '@deepseek-ai/dsh-agent'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ApprovalOutcome, ApprovalRequestEvent } from '@deepseek-ai/dsh-user-approval/types'
import type { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-session-title'
import type { AgentsLike } from '../src/bridge.ts'
import type {
  ApprovalOutcomeLike,
  ApprovalRequestLike,
  CredentialsLike,
  SessionControllerLike,
  SessionEventLike,
  WorkspaceRegistryLike,
} from '../src/dsh.ts'

type Assert<T extends true> = T
type Extends<A, B> = [A] extends [B] ? true : false

export type Checks = [
  Assert<Extends<SessionController, SessionControllerLike>>,
  Assert<Extends<WorkspaceRegistry, WorkspaceRegistryLike>>,
  Assert<Extends<AgentRegistry, AgentsLike>>,
  Assert<Extends<ApprovalOutcome, ApprovalOutcomeLike>>,
  Assert<Extends<ApprovalOutcomeLike, ApprovalOutcome>>,
  Assert<Extends<ApprovalRequestEvent, ApprovalRequestLike>>,
  Assert<Extends<CredentialProvider, CredentialsLike>>,
  // Each event this plugin renders keeps the fields it reads.
  Assert<Extends<SessionEvent<'turn/start'>, Extract<SessionEventLike, { type: 'turn/start' }>>>,
  Assert<Extends<SessionEvent<'turn/end'>, Extract<SessionEventLike, { type: 'turn/end' }>>>,
  Assert<Extends<SessionEvent<'user/message'>, Extract<SessionEventLike, { type: 'user/message' }>>>,
  Assert<Extends<SessionEvent<'assistant/message'>, Extract<SessionEventLike, { type: 'assistant/message' }>>>,
  Assert<Extends<SessionEvent<'tool/call'>, Extract<SessionEventLike, { type: 'tool/call' }>>>,
  Assert<Extends<SessionEvent<'tool/result'>, Extract<SessionEventLike, { type: 'tool/result' }>>>,
  Assert<Extends<SessionEvent<'session/title'>, Extract<SessionEventLike, { type: 'session/title' }>>>,
]

declare const controller: SessionController
export const controllerProbe: SessionControllerLike = controller
