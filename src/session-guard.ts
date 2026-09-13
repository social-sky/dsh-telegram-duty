/**
 * Duty-session lifecycle guard: pure rotation policy, event-tail slicing, and
 * usage extraction helpers — deliberately free of any dsh imports so they run
 * under plain `node --test` (Node >=22.18 type stripping, no dependencies).
 *
 * Why the thresholds exist (harness LXC evidence, 2026-09-02 archive):
 * the duty session reached 29,755 events / 41.8 MB uncompressed, its LAST
 * turn ended with `CONTEXT_WINDOW_EXCEEDED` (glm-5.3-flash) after 133 turns,
 * and its largest recorded inputTokens was 598,312 — every turn near the end
 * paid ~600K input tokens. Rotation must therefore be TOKEN-AWARE first;
 * turns/events are secondary structural axes.
 * @module @luzhengyangtx/dsh-telegram-duty/session-guard
 */

/** Rotation thresholds; a numeric limit of `0` means "unlimited / off". */
export interface RotationThresholds {
  /** Rotate after this many delivered turns into the duty session. */
  maxTurnsPerSession?: number
  /** Rotate when the duty session event log reaches this length. */
  maxSessionEvents?: number
  /**
   * Rotate when the last recorded inputTokens reaches this. The PRIMARY
   * cost guard: every turn before rotation pays ~this many input tokens.
   */
  maxContextTokens?: number
  /** Master switch; when false, never rotate. */
  autoRotate?: boolean
}

export const DEFAULT_MAX_TURNS_PER_SESSION = 200
export const DEFAULT_MAX_SESSION_EVENTS = 5000
export const DEFAULT_MAX_CONTEXT_TOKENS = 400000

export interface RotationInput {
  /** Delivered duty turns since the last rotation. */
  turns: number
  /** Current length of the duty session event log, when known. */
  eventCount?: number
  /** Latest usage.inputTokens observed in the session, when known. */
  lastInputTokens?: number
}

/**
 * Decide whether the duty session should rotate now. Pure and total: never
 * throws, and never rotates on nonsensical input.
 */
export function shouldRotate(input: RotationInput, thresholds: RotationThresholds = {}): boolean {
  if (thresholds.autoRotate === false) return false
  if (!(input.turns >= 0)) return false
  const maxTurns = thresholds.maxTurnsPerSession ?? DEFAULT_MAX_TURNS_PER_SESSION
  if (maxTurns > 0 && input.turns >= maxTurns) return true
  if (input.eventCount !== undefined && input.eventCount >= 0) {
    const maxEvents = thresholds.maxSessionEvents ?? DEFAULT_MAX_SESSION_EVENTS
    if (maxEvents > 0 && input.eventCount >= maxEvents) return true
  }
  if (input.lastInputTokens !== undefined && input.lastInputTokens >= 0) {
    const maxTokens = thresholds.maxContextTokens ?? DEFAULT_MAX_CONTEXT_TOKENS
    if (maxTokens > 0 && input.lastInputTokens >= maxTokens) return true
  }
  return false
}

/** Lower-bound binary search: index of the first event with seq >= firstSeq. */
function lowerBoundSeq(events: ReadonlyArray<{ seq: number }>, firstSeq: number): number {
  let lo = 0
  let hi = events.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    const seq = events[mid]?.seq
    if (seq === undefined || seq < firstSeq) lo = mid + 1
    else hi = mid
  }
  return lo
}

/**
 * O(log n) slice of the event tail from firstSeq onward. The driver used to
 * hand summarize() the FULL events array every turn — O(n) per turn and
 * O(n^2) across a long duty session. Slicing first turns that into
 * O(log n + delta) while summarize() itself stays unchanged.
 */
export function sliceFromSeq<T extends { seq: number }>(events: ReadonlyArray<T> | unknown, firstSeq: number): ReadonlyArray<T> {
  if (!Array.isArray(events)) return []
  return events.slice(lowerBoundSeq(events, firstSeq))
}

/**
 * Last usage.inputTokens recorded in the given events. dsh emits usage as
 * `assistant/chunk` events: `data.chunk = { type: 'usage', usage: {
 * inputTokens, outputTokens } }`. Accepts plain unknown rows so tests can
 * pass minimal fixtures and the driver can pass real SessionEvents.
 */
/**
 * Structural view of one dsh Session's event log. dsh 0.1.5-rc.1 exposes
 * `snapshotEvents()` (canonical) and no `events` property at all; rc.2-era
 * builds exposed an `events` array. These accessors work on both, so the
 * plugin no longer depends on a property that rc.1 removed.
 */
interface SessionEventsLike {
  events?: unknown
  snapshotEvents?: (fromSeq?: number, toSeqExclusive?: number) => unknown
  seq?: number
}

/** All events of one session (frozen snapshot), empty when unavailable. */
export function sessionEventsOf(session: unknown): readonly unknown[] {
  const s = session as SessionEventsLike | undefined
  if (s === undefined) return []
  const snapshot = s.snapshotEvents
  if (typeof snapshot === 'function') {
    try {
      const taken = snapshot.call(s)
      if (Array.isArray(taken)) return taken
    } catch {
      // fall through to the legacy property
    }
  }
  return Array.isArray(s.events) ? s.events : []
}

/** Event count of one session: rc.1 `seq` is the log end, else array length. */
export function sessionEventCount(session: unknown): number {
  const s = session as SessionEventsLike | undefined
  if (s !== undefined && typeof s.seq === 'number') return s.seq
  return sessionEventsOf(session).length
}

/** Events from fromSeq to the end (rc.1 range snapshot, else tail slice). */
export function sessionEventsFrom(session: unknown, fromSeq: number): readonly unknown[] {
  const s = session as SessionEventsLike | undefined
  const snapshot = s?.snapshotEvents
  if (typeof snapshot === 'function') {
    try {
      const taken = snapshot.call(s, fromSeq)
      if (Array.isArray(taken)) return taken
    } catch {
      // fall through
    }
  }
  return sliceFromSeq(sessionEventsOf(session) as ReadonlyArray<{ seq: number }>, fromSeq)
}

/** Pull usage.inputTokens from any known event shape (v2 chunk, v3 data/message). */
function usageInputTokensOf(event: unknown): number | undefined {
  const e = event as {
    data?: {
      chunk?: { usage?: { inputTokens?: number } }
      usage?: { inputTokens?: number }
      message?: { usage?: { inputTokens?: number } }
    }
  }
  const candidates = [e?.data?.chunk?.usage, e?.data?.usage, e?.data?.message?.usage]
  for (const candidate of candidates) {
    if (candidate !== undefined && typeof candidate.inputTokens === 'number') return candidate.inputTokens
  }
  return undefined
}

export function extractLastUsageInputTokens(events: unknown): number | undefined {
  if (!Array.isArray(events)) return undefined
  let last: number | undefined
  for (const event of events) {
    const value = usageInputTokensOf(event)
    if (value !== undefined) last = value
  }
  return last
}

/** Largest usage.inputTokens in the given events (cost high-water mark). */
export function extractMaxUsageInputTokens(events: unknown): number | undefined {
  if (!Array.isArray(events)) return undefined
  let max: number | undefined
  for (const event of events) {
    const value = usageInputTokensOf(event)
    if (value !== undefined && (max === undefined || value > max)) max = value
  }
  return max
}

/** Last non-empty assistant reply text in the given events (handoff source). */
export function extractLastAssistantText(events: unknown): string {
  if (!Array.isArray(events)) return ''
  for (let i = events.length - 1; i >= 0; i--) {
    const raw = events[i]
    if (raw === undefined) continue
    const e = raw as { type?: string; data?: { message?: { content?: ReadonlyArray<{ type?: string; text?: unknown }> } } }
    if (e?.type !== 'assistant/message') continue
    const content = e.data?.message?.content
    if (content === undefined) continue
    const text = content
      .filter(block => block.type === 'text')
      .map(block => String(block.text ?? ''))
      .join('')
    if (text.trim() !== '') return text
  }
  return ''
}

/**
 * Cap for the handoff summary body, so one giant last reply cannot bloat the
 * successor session system prompt.
 */
export const HANDOFF_SUMMARY_CAP = 1200

/** Build the summary handed to the successor duty session (agent-facing text). */
export function buildHandoffSummary(lastReply: string, turns: number): string {
  const trimmed = lastReply.trim()
  const body = trimmed === ''
    ? '(上一段值班沒有留下文字回覆)'
    : trimmed.length > HANDOFF_SUMMARY_CAP
      ? trimmed.slice(0, HANDOFF_SUMMARY_CAP) + '…(已截斷)'
      : trimmed
  return [
    '你是同一個 Telegram 值班助理的延續。前一個 session 已達輪替門檻並封存，',
    `本次交接前共完成 ${turns} 輪對話。為維持連續性，以下是交接摘要；`,
    '使用者提及「之前」「剛剛」等指涉時，以此摘要為準：',
    '最後一輪回覆（摘要）：',
    body,
  ].join('\n')
}