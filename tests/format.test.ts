import { describe, expect, it } from 'vitest'
import { chunkText, describeTurnEnd, extractText, summarizeToolCall } from '../src/format.ts'

describe('chunkText', () => {
  it('keeps short text whole', () => {
    expect(chunkText('hello', 1900)).toEqual(['hello'])
  })

  it('splits long text on line breaks within the limit', () => {
    const text = Array.from({ length: 300 }, (_, i) => `line ${i} ${'x'.repeat(20)}`).join('\n')
    const chunks = chunkText(text, 500)
    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(500)
    expect(chunks.join('\n')).toBe(text)
  })

  it('closes and reopens a code fence across chunks', () => {
    const code = Array.from({ length: 80 }, (_, i) => `const v${i} = ${i}`).join('\n')
    const chunks = chunkText(`intro\n\`\`\`ts\n${code}\n\`\`\`\noutro`, 400)
    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(400)
      expect((chunk.match(/```/g) ?? []).length % 2).toBe(0)
    }
    expect(chunks[1]?.startsWith('```ts\n')).toBe(true)
  })
})

describe('extractText', () => {
  const content = [
    { type: 'reasoning', text: 'think' },
    { type: 'text', text: 'answer' },
    { type: 'tool-call' },
  ]
  it('drops reasoning by default', () => {
    expect(extractText(content, false)).toBe('answer')
  })
  it('quotes reasoning when enabled', () => {
    expect(extractText(content, true)).toBe('> think\n\nanswer')
  })
})

describe('summarizeToolCall', () => {
  it('prefers the command argument', () => {
    expect(summarizeToolCall('bash', JSON.stringify({ command: 'ls   -la', timeout: 3 }))).toBe('bash · ls -la')
  })
  it('tolerates invalid JSON', () => {
    expect(summarizeToolCall('x', '{oops')).toBe('x · {oops')
  })
})

describe('describeTurnEnd', () => {
  it('is silent for completed turns', () => {
    expect(describeTurnEnd({ kind: 'completed' })).toBeUndefined()
  })
  it('words errors', () => {
    expect(describeTurnEnd({ kind: 'error', error: { message: 'boom' } })).toContain('boom')
  })
})
