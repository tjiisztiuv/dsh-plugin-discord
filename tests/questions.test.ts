import { describe, expect, it } from 'vitest'
import type { QuestionItemLike } from '../src/dsh.ts'
import {
  componentAnswer,
  describeAnswer,
  parseQuestionComponentId,
  questionCard,
  questionComponentId,
  typedAnswer,
} from '../src/questions.ts'

const single: QuestionItemLike = { id: 'mode', question: 'Which mode?', options: [{ label: 'Fast' }, { label: 'Safe' }, { label: 'Off' }] }
const multi: QuestionItemLike = { ...single, id: 'langs', multiSelect: true }

describe('question cards', () => {
  it('gives single choices one button each and multiple choices a select menu', () => {
    const one = questionCard('t', [single], 0).message
    expect(one.buttons?.map(button => button.label)).toEqual(['Fast', 'Safe', 'Off', '✏️ 其他…', '跳过'])
    expect(one.select).toBeUndefined()
    const many = questionCard('t', [single, multi], 1).message
    expect(many.content).toContain('（2/2）')
    expect(many.select).toMatchObject({ id: 'dshq:t:1:sel', minValues: 1, maxValues: 3 })
    expect(many.buttons?.map(button => button.label)).toEqual(['✏️ 其他…', '跳过'])
  })

  it('posts a long plan before the card and highlights the approving option', () => {
    const plan = 'step\n'.repeat(400)
    const card = questionCard('t', [{
      id: 'plan',
      question: 'Approve this plan?',
      detail: plan,
      options: [{ label: 'Approve' }, { label: 'Revise' }],
      intent: { kind: 'plan-review', approve: 'Approve' },
    }], 0)
    expect(card.detail).toContain('step')
    expect(card.message.content).toContain('计划待审阅')
    expect(card.message.content.length).toBeLessThanOrEqual(2000)
    expect(card.message.buttons?.find(button => button.label === 'Approve')?.style).toBe('success')
    expect(card.message.buttons?.find(button => button.label === 'Revise')?.style).toBe('primary')
  })

  it('round-trips component ids', () => {
    expect(parseQuestionComponentId(questionComponentId('abc', 2, 'o1'))).toEqual({ token: 'abc', index: 2, action: 'o1' })
    expect(parseQuestionComponentId('dshap:abc:allow')).toBeUndefined()
  })
})

describe('answers', () => {
  it('maps components to answer items', () => {
    expect(componentAnswer(single, 'o1', {})).toEqual({ id: 'mode', selected: ['Safe'] })
    expect(componentAnswer(multi, 'sel', { values: ['0', '2'] })).toEqual({ id: 'langs', selected: ['Fast', 'Off'] })
    expect(componentAnswer(single, 'modal', { text: '  neither  ' })).toEqual({ id: 'mode', selected: [], custom: 'neither' })
    expect(componentAnswer(single, 'skip', {})).toEqual({ id: 'mode', selected: [] })
    expect(componentAnswer(single, 'o9', {})).toBeUndefined()
  })

  it('reads typed numbers and labels, otherwise keeps the text', () => {
    expect(typedAnswer(single, '2')).toEqual({ id: 'mode', selected: ['Safe'] })
    expect(typedAnswer(single, 'off')).toEqual({ id: 'mode', selected: ['Off'] })
    expect(typedAnswer(multi, '1, 3')).toEqual({ id: 'langs', selected: ['Fast', 'Off'] })
    expect(typedAnswer(single, '1,3')).toEqual({ id: 'mode', selected: [], custom: '1,3' })
    expect(typedAnswer(single, '7')).toEqual({ id: 'mode', selected: [], custom: '7' })
    expect(typedAnswer({ id: 'n', question: 'How many?' }, '3')).toEqual({ id: 'n', selected: [], custom: '3' })
  })

  it('describes answers and skips', () => {
    expect(describeAnswer({ id: 'a', selected: ['Fast'], custom: 'today' })).toBe('✅ Fast、“today”')
    expect(describeAnswer({ id: 'a', selected: [] })).toBe('⏭️ 已跳过')
  })
})
