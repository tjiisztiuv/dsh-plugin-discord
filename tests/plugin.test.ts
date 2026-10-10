import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import * as plugin from '../src/index.ts'

describe('plugin wiring under Cordis', () => {
  it('loads with Host services, stays offline without a token, and delegates approvals', async () => {
    const ctx = new Context()
    const resolved: string[] = []
    ctx.provide('sessionController', {})
    ctx.provide('workspaceRegistry', { list: () => [], get: () => undefined, archivedSessionIds: [] })
    ctx.provide('agents', { get: () => undefined })
    ctx.provide('credentials', { resolve: async (ref: string) => { resolved.push(ref); return undefined } })
    const stateFile = join(await mkdtemp(join(tmpdir(), 'dsh-discord-')), 'state.json')
    const config: Partial<plugin.DiscordConfig> = { stateFile, allowedUserIds: ['u1'] }
    const fiber = await ctx.plugin(plugin, config as plugin.DiscordConfig)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(resolved).toEqual(['DISCORD_BOT_TOKEN'])

    const outcome = await ctx.waterfall('approval/request', { agent: { id: 's1' }, toolName: 'bash' }, async () => 'unavailable' as const)
    expect(outcome).toBe('unavailable')
    ctx.emit('session/event', { id: 's1' }, { type: 'turn/start', data: { turn: 1 } })
    await fiber.dispose()
  })
})
