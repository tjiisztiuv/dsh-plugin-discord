import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BindingStore } from '../src/state.ts'

describe('BindingStore', () => {
  it('persists bindings and moves a Session to its newest channel', async () => {
    const file = join(await mkdtemp(join(tmpdir(), 'dsh-discord-')), 'nested', 'state.json')
    const store = new BindingStore(file, (error) => { throw error })
    await store.load()
    expect(store.bind('a', { sessionId: 's1', workspaceId: 'w1', ownsThread: true })).toEqual([])
    expect(store.bind('b', { sessionId: 's1', workspaceId: 'w1', ownsThread: false })).toEqual(['a'])
    store.setChannelWorkspace('dm', 'w1')
    await store.flush()

    const reloaded = new BindingStore(file, (error) => { throw error })
    await reloaded.load()
    expect(reloaded.binding('a')).toBeUndefined()
    expect(reloaded.binding('b')?.sessionId).toBe('s1')
    expect(reloaded.channelWorkspace('dm')).toBe('w1')
    expect(JSON.parse(await readFile(file, 'utf8')).version).toBe(1)
  })
})
