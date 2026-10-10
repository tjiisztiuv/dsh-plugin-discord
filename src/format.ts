/** Pure text helpers that turn Session content into Discord-sized messages. */

import type { ContentBlockLike, TurnEndReasonLike } from './dsh.ts'

/** Discord's hard per-message content limit. */
export const DISCORD_MESSAGE_LIMIT = 2000

/**
 * Join the text blocks of one message; reasoning is included only when asked.
 * @param content - message content blocks.
 * @param showReasoning - whether reasoning blocks are rendered (as a quote).
 * @returns trimmed text, possibly empty.
 */
export function extractText(content: readonly ContentBlockLike[], showReasoning: boolean): string {
  const parts: string[] = []
  for (const block of content) {
    if (block.type === 'text' && 'text' in block) parts.push(block.text)
    else if (block.type === 'reasoning' && 'text' in block && showReasoning && block.text.trim() !== '') {
      parts.push(block.text.trim().split('\n').map(line => `> ${line}`).join('\n'))
    }
  }
  return parts.filter(part => part.trim() !== '').join('\n\n').trim()
}

/**
 * Split text into Discord-sized chunks, preferring line breaks and keeping
 * fenced code blocks balanced across chunk boundaries.
 * @param text - complete text.
 * @param size - maximum chunk length, at most {@link DISCORD_MESSAGE_LIMIT}.
 * @returns non-empty chunks in order.
 */
export function chunkText(text: string, size: number): string[] {
  const limit = Math.min(size, DISCORD_MESSAGE_LIMIT)
  const chunks: string[] = []
  let remaining = text
  let openFence: string | undefined
  while (remaining.length > 0) {
    const prefix = openFence === undefined ? '' : `${openFence}\n`
    // Reserve room for the prefix reopening a fence and a closing fence.
    const budget = limit - prefix.length - 4
    if (remaining.length <= budget) {
      chunks.push(prefix + remaining)
      break
    }
    let cut = remaining.lastIndexOf('\n', budget)
    if (cut < budget / 2) cut = budget
    let piece = remaining.slice(0, cut)
    remaining = remaining.slice(cut).replace(/^\n/, '')
    const fence = trailingOpenFence(prefix + piece)
    if (fence !== undefined) piece += '\n```'
    chunks.push(prefix + piece)
    openFence = fence
  }
  return chunks.filter(chunk => chunk.trim() !== '')
}

/** Return the opening line of a fence left unclosed at the end of `text`. */
function trailingOpenFence(text: string): string | undefined {
  let open: string | undefined
  for (const line of text.split('\n')) {
    const match = /^\s*(```+)(.*)$/.exec(line)
    if (match === null) continue
    open = open === undefined ? `${match[1] ?? '```'}${(match[2] ?? '').trim()}` : undefined
  }
  return open
}

/**
 * Shorten text to `max` characters with an ellipsis.
 * @param text - input.
 * @param max - maximum length including the ellipsis.
 * @returns the possibly shortened text.
 */
export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`
}

/** Argument keys whose value best summarizes a tool call, in preference order. */
const SUMMARY_KEYS = ['command', 'cmd', 'path', 'file_path', 'filePath', 'pattern', 'query', 'url', 'description', 'prompt', 'title']

/**
 * One-line summary of a tool call for the progress message.
 * @param name - tool name.
 * @param args - raw JSON arguments as the model produced them.
 * @returns a single line such as "bash · ls -la".
 */
export function summarizeToolCall(name: string, args: string): string {
  let detail = ''
  try {
    const parsed: unknown = JSON.parse(args)
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>
      const key = SUMMARY_KEYS.find(candidate => typeof record[candidate] === 'string')
      detail = key === undefined ? '' : String(record[key])
    }
  } catch {
    // Model arguments are not guaranteed to be valid JSON; show the raw prefix instead.
    detail = args
  }
  detail = detail.replace(/\s+/g, ' ').trim()
  return detail === '' ? name : `${name} · ${truncate(detail, 80)}`
}

/**
 * Pretty-print tool arguments for an approval card.
 * @param args - raw JSON arguments.
 * @param max - maximum characters before truncation.
 * @returns the formatted arguments.
 */
export function formatToolArguments(args: string, max: number): string {
  let pretty = args
  try {
    pretty = JSON.stringify(JSON.parse(args), null, 2)
  } catch {
    // Keep the raw string when it is not JSON.
  }
  return truncate(pretty, max)
}

/**
 * Describe a non-successful turn end; completed turns need no notice.
 * @param reason - the durable turn-end reason.
 * @returns a status line, or undefined for a completed turn.
 */
export function describeTurnEnd(reason: TurnEndReasonLike): string | undefined {
  switch (reason.kind) {
    case 'completed':
      return undefined
    case 'aborted':
      return '⏹ 已停止'
    case 'max-tokens':
      return '⚠️ 本轮达到了输出 token 上限'
    case 'error': {
      const message = 'error' in reason ? reason.error.message : ''
      return `❌ 本轮出错：${truncate(message, 500)}`
    }
    default:
      return `ℹ️ 本轮结束：${reason.kind}`
  }
}

/**
 * Format a relative age for list rows.
 * @param then - epoch milliseconds.
 * @param now - epoch milliseconds.
 * @returns a short Chinese relative time.
 */
export function relativeTime(then: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - then) / 1000))
  if (seconds < 60) return '刚刚'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `${hours} 小时前`
  return `${Math.round(hours / 24)} 天前`
}
