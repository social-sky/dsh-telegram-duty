/**
 * Duty-session lifecycle guard: pure rotation policy and event-slicing
 * helpers, deliberately free of any dsh imports so they run under plain
 * `node --test` (Node >=22.18 type stripping, no dependencies).
 *
 * Why the thresholds exist: the 2026-09-02 archived duty session reached
 * 29,755 events (41.8 MB uncompressed) — one long-lived session absorbing
 * every Telegram turn with no rotation — which is the context blow-up
 * failure mode this guard prevents.
 * @module @luzhengyangtx/dsh-telegram-duty/session-guard
 */

/** Rotation thresholds; a numeric limit of `0` means "unlimited". */
export interface RotationThresholds {
  /** Rotate after this many delivered turns into the duty session. */
  maxTurnsPerSession?: number
  /** Rotate when the duty session event log reaches this length. */
  maxSessionEvents?: number
  /** Master switch; when false, never rotate. */
  autoRotate?: boolean
}

export const DEFAULT_MAX_TURNS_PER_SESSION = 200
export const DEFAULT_MAX_SESSION_EVENTS = 5000

export interface RotationInput {
  /** Delivered duty turns since the last rotation. */
  turns: number
  /** Current length of the duty session event log, when known. */
  eventCount?: number
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
export function sliceFromSeq<T extends { seq: number }>(events: ReadonlyArray<T>, firstSeq: number): ReadonlyArray<T> {
  return events.slice(lowerBoundSeq(events, firstSeq))
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