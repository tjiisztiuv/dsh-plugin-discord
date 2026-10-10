/** Durable Discord-channel ↔ Session bindings, stored as one JSON file. */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { SessionId, WorkspaceId } from './dsh.ts'

/** One Discord channel (DM, thread, or text channel) driving one Session. */
export interface Binding {
  readonly sessionId: SessionId
  readonly workspaceId: WorkspaceId
  /** Whether this plugin created the thread and may rename it after the Session title. */
  readonly ownsThread: boolean
}

/** File content, versioned for future migrations. */
interface StateFile {
  readonly version: 1
  readonly bindings: Record<string, Binding>
  /** Default Workspace per Discord text channel or DM channel. */
  readonly channelWorkspaces: Record<string, WorkspaceId>
}

/** In-memory view with serialized write-through persistence. */
export class BindingStore {
  private bindings = new Map<string, Binding>()
  private channelWorkspaces = new Map<string, WorkspaceId>()
  private writes: Promise<void> = Promise.resolve()

  /**
   * @param file - absolute JSON path; parent directories are created on save.
   * @param onWriteError - receives a failed write; later writes still run.
   */
  constructor(private readonly file: string, private readonly onWriteError: (error: unknown) => void) {}

  /**
   * Load the file; a missing file yields an empty store.
   * @throws when the file exists but is not a valid state document.
   */
  async load(): Promise<void> {
    let raw: string
    try {
      raw = await readFile(this.file, 'utf8')
    } catch (error: unknown) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return
      throw error
    }
    const parsed = JSON.parse(raw) as Partial<StateFile>
    if (parsed.version !== 1) throw new Error(`discord: unsupported state file version in ${this.file}`)
    this.bindings = new Map(Object.entries(parsed.bindings ?? {}))
    this.channelWorkspaces = new Map(Object.entries(parsed.channelWorkspaces ?? {}))
  }

  /** @returns the binding of one Discord channel. */
  binding(channelId: string): Binding | undefined {
    return this.bindings.get(channelId)
  }

  /** @returns every Discord channel bound to `sessionId`. */
  channelsOf(sessionId: SessionId): string[] {
    const channels: string[] = []
    for (const [channelId, binding] of this.bindings) if (binding.sessionId === sessionId) channels.push(channelId)
    return channels
  }

  /** @returns whether any channel is bound to `sessionId`. */
  isBound(sessionId: SessionId): boolean {
    return this.channelsOf(sessionId).length > 0
  }

  /**
   * Bind a channel, replacing its previous Session; other channels bound to the
   * same Session are released so each Session has one Discord home.
   * @returns channels that lost the Session.
   */
  bind(channelId: string, binding: Binding): string[] {
    const released = this.channelsOf(binding.sessionId).filter(id => id !== channelId)
    for (const id of released) this.bindings.delete(id)
    this.bindings.set(channelId, binding)
    this.save()
    return released
  }

  /** @returns the removed binding, if any. */
  unbind(channelId: string): Binding | undefined {
    const previous = this.bindings.get(channelId)
    if (previous !== undefined) {
      this.bindings.delete(channelId)
      this.save()
    }
    return previous
  }

  /** @returns the default Workspace chosen for a channel. */
  channelWorkspace(channelId: string): WorkspaceId | undefined {
    return this.channelWorkspaces.get(channelId)
  }

  /** Choose the default Workspace for a channel. */
  setChannelWorkspace(channelId: string, workspaceId: WorkspaceId): void {
    this.channelWorkspaces.set(channelId, workspaceId)
    this.save()
  }

  /** @returns a promise settling after every queued write. */
  flush(): Promise<void> {
    return this.writes
  }

  private save(): void {
    const snapshot: StateFile = {
      version: 1,
      bindings: Object.fromEntries(this.bindings),
      channelWorkspaces: Object.fromEntries(this.channelWorkspaces),
    }
    const body = `${JSON.stringify(snapshot, null, 2)}\n`
    this.writes = this.writes.then(async () => {
      await mkdir(dirname(this.file), { recursive: true })
      const temp = `${this.file}.${process.pid}.tmp`
      await writeFile(temp, body, { mode: 0o600 })
      await rename(temp, this.file)
    }).catch(this.onWriteError)
  }
}
