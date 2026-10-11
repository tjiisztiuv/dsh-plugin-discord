/**
 * Pure helpers for `ask_user_question` cards: one card per question, with
 * option buttons (single choice), a select menu (multiple choice), a text
 * answer through a modal, and skip. Component ids are
 * `dshq:<token>:<question index>:<action>`.
 */

import type { QuestionAnswerItemLike, QuestionItemLike } from './dsh.ts'
import { truncate } from './format.ts'
import type { OutgoingButton, OutgoingMessage } from './transport.ts'

/** Component id prefix of question cards. */
export const QUESTION_PREFIX = 'dshq'

/** Single-choice questions with at most this many options get one button per option. */
const MAX_OPTION_BUTTONS = 20
/** Discord's select-menu option limit. */
const MAX_SELECT_OPTIONS = 25
/** Longer details are posted as their own messages before the card. */
const INLINE_DETAIL_CHARS = 1000

/** Text answer requested through a Discord modal. */
export interface QuestionModal {
  /** Modal `custom_id`; its submission carries the typed text. */
  readonly id: string
  /** At most 45 characters. */
  readonly title: string
  /** At most 45 characters. */
  readonly label: string
  /** At most 100 characters. */
  readonly placeholder: string
}

/** Input carried by a question component interaction. */
export interface QuestionInput {
  /** Select-menu values (option indexes). */
  readonly values?: readonly string[]
  /** Modal text. */
  readonly text?: string
}

/** One rendered question card. */
export interface QuestionCard {
  /** Long detail to post as plain text before the card. */
  readonly detail?: string
  readonly message: OutgoingMessage
}

/** @returns the component id of one action on one question card. */
export function questionComponentId(token: string, index: number, action: string): string {
  return `${QUESTION_PREFIX}:${token}:${index}:${action}`
}

/** Parse a component id. @returns undefined for ids that are not question components. */
export function parseQuestionComponentId(customId: string): { token: string; index: number; action: string } | undefined {
  const [prefix, token, index, action] = customId.split(':')
  if (prefix !== QUESTION_PREFIX || token === undefined || action === undefined || !/^\d+$/.test(index ?? '')) return undefined
  return { token, index: Number(index), action }
}

/** First line of a card: header and position in the batch. */
function heading(question: QuestionItemLike, index: number, total: number): string {
  const title = question.intent?.kind === 'plan-review' ? '📋 计划待审阅' : `❓ ${question.header?.trim() || '需要你的回答'}`
  return `**${truncate(title, 100)}**${total > 1 ? `（${index + 1}/${total}）` : ''}`
}

/** Option list with descriptions; plain labels are already on the buttons. */
function optionLines(question: QuestionItemLike, buttons: boolean): string[] {
  const options = question.options ?? []
  if (options.length === 0) return []
  if (buttons && options.every(option => option.description === undefined || option.description.trim() === '')) return []
  return options.map((option, n) => {
    const description = option.description?.trim()
    return `${n + 1}. **${truncate(option.label, 100)}**${description ? ` — ${truncate(description, 200)}` : ''}`
  })
}

/**
 * Render the card for question `index` of a batch.
 * @param token - the batch token used in component ids.
 */
export function questionCard(token: string, questions: readonly QuestionItemLike[], index: number): QuestionCard {
  const question = questions[index]
  if (question === undefined) throw new RangeError(`no question at ${index}`)
  const options = question.options ?? []
  const id = (action: string): string => questionComponentId(token, index, action)
  const single = question.multiSelect !== true
  const useButtons = single && options.length > 0 && options.length <= MAX_OPTION_BUTTONS
  const useSelect = !single && options.length > 0 && options.length <= MAX_SELECT_OPTIONS

  const detail = question.detail?.trim() ?? ''
  const longDetail = detail.length > INLINE_DETAIL_CHARS
  const lines = [heading(question, index, questions.length), question.question.trim()]
  if (detail !== '') lines.push(longDetail ? '_（详情见上方）_' : detail.split('\n').map(line => `> ${line}`).join('\n'))
  const listed = optionLines(question, useButtons)
  if (listed.length > 0) lines.push('', ...listed)
  lines.push('', options.length > 0
    ? `-# 也可以直接发消息回答：回复选项序号${single ? '' : '（多个用逗号分隔）'}或文字`
    : '-# 也可以直接发消息回答')

  const buttons: OutgoingButton[] = []
  if (useButtons) {
    options.forEach((option, n) => {
      buttons.push({
        id: id(`o${n}`),
        label: truncate(option.label.trim() || `选项 ${n + 1}`, 80),
        style: question.intent?.approve === option.label ? 'success' : 'primary',
      })
    })
  }
  buttons.push({ id: id('txt'), label: options.length > 0 ? '✏️ 其他…' : '✏️ 回答…', style: 'secondary' })
  buttons.push({ id: id('skip'), label: '跳过', style: 'secondary' })

  const message: OutgoingMessage = {
    content: truncate(lines.join('\n'), 2000),
    buttons,
    ...useSelect
      ? {
          select: {
            id: id('sel'),
            placeholder: '选择一项或多项',
            options: options.map((option, n) => ({
              label: truncate(option.label.trim() || `选项 ${n + 1}`, 100),
              value: String(n),
              ...option.description?.trim() ? { description: truncate(option.description.trim(), 100) } : {},
            })),
            minValues: 1,
            maxValues: options.length,
          },
        }
      : {},
  }
  return longDetail ? { detail: `${heading(question, index, questions.length)}\n${detail}`, message } : { message }
}

/** @returns the modal asking for a text answer to `question`. */
export function questionModal(id: string, question: QuestionItemLike): QuestionModal {
  const hasOptions = (question.options ?? []).length > 0
  return {
    id,
    title: truncate(question.header?.trim() || '回答问题', 45),
    label: truncate(question.question.trim() || '你的回答', 45),
    placeholder: hasOptions ? '不在选项里的回答写在这里' : '写下你的回答',
  }
}

/**
 * Answer from a card component.
 * @param action - `o<n>` option button, `sel` select menu, `modal` text, or `skip`.
 * @returns undefined when the input names no valid answer.
 */
export function componentAnswer(question: QuestionItemLike, action: string, input: QuestionInput): QuestionAnswerItemLike | undefined {
  const options = question.options ?? []
  if (action === 'skip') return { id: question.id, selected: [] }
  if (action === 'modal') {
    const text = input.text?.trim() ?? ''
    return text === '' ? undefined : { id: question.id, selected: [], custom: text }
  }
  if (action === 'sel') {
    const picked = (input.values ?? []).map(value => options[Number(value)]).filter(option => option !== undefined)
    return picked.length === 0 ? undefined : { id: question.id, selected: picked.map(option => option.label) }
  }
  const match = /^o(\d+)$/.exec(action)
  const option = match?.[1] === undefined ? undefined : options[Number(match[1])]
  return option === undefined ? undefined : { id: question.id, selected: [option.label] }
}

/**
 * Answer typed as a chat message: an exact option label, option numbers
 * (`2`, or `1,3` for multiple choice), otherwise free text.
 */
export function typedAnswer(question: QuestionItemLike, text: string): QuestionAnswerItemLike {
  const options = question.options ?? []
  const trimmed = text.trim()
  const byLabel = options.find(option => option.label.trim().toLowerCase() === trimmed.toLowerCase())
  if (byLabel !== undefined) return { id: question.id, selected: [byLabel.label] }
  if (options.length > 0 && /^\d+(?:\s*[,，、\s]\s*\d+)*$/.test(trimmed)) {
    const numbers = [...new Set(trimmed.split(/[\s,，、]+/).map(Number))]
    const picked = numbers.map(n => options[n - 1])
    if (picked.every(option => option !== undefined) && (question.multiSelect === true || picked.length === 1)) {
      return { id: question.id, selected: picked.map(option => option.label) }
    }
  }
  return { id: question.id, selected: [], custom: trimmed }
}

/** @returns a one-line description of an answer. */
export function describeAnswer(item: QuestionAnswerItemLike): string {
  const parts = [...item.selected]
  if (item.custom !== undefined) parts.push(`“${item.custom}”`)
  return parts.length === 0 ? '⏭️ 已跳过' : `✅ ${truncate(parts.join('、'), 1500)}`
}

/** @returns a finished card: heading, question, and a closing line. */
export function closedQuestionCard(questions: readonly QuestionItemLike[], index: number, verdict: string): OutgoingMessage {
  const question = questions[index]
  const head = question === undefined ? '' : `${heading(question, index, questions.length)}\n${truncate(question.question.trim(), 300)}\n\n`
  return { content: truncate(`${head}**${verdict}**`, 2000), buttons: [] }
}
