import { describe, expect, it } from 'vitest'
import type { QuestionItemLike } from '../src/dsh.ts'
import { modal, render } from '../src/discord.ts'
import { questionCard, questionModal } from '../src/questions.ts'

const long = (n: number): string => 'x'.repeat(n)

describe('Discord components', () => {
  it('stays within Discord limits for the largest question cards', () => {
    const options = Array.from({ length: 25 }, (_, n) => ({ label: `${n}${long(200)}`, description: long(300) }))
    const buttons: QuestionItemLike = { id: 'a', header: long(200), question: long(3000), options: options.slice(0, 20) }
    const select: QuestionItemLike = { id: 'b', question: long(50), options, multiSelect: true }
    for (const [question, rows] of [[buttons, 5], [select, 2]] as const) {
      const { message } = questionCard('0123456789abcdef', [question], 0)
      const rendered = render(message)
      expect(rendered.content.length).toBeLessThanOrEqual(2000)
      expect(rendered.components).toHaveLength(rows)
      for (const row of rendered.components) expect(() => row.toJSON()).not.toThrow()
    }
    expect(() => modal(questionModal('dshq:0123456789abcdef:0:modal', buttons)).toJSON()).not.toThrow()
  })

  it('removes components when an edit carries none', () => {
    expect(render({ content: 'done' }).components).toEqual([])
  })
})
