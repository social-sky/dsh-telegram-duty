/**
 * Duty-session driver: keeps one stable DSH session live, delivers Telegram
 * text as follow-up turns (which wakes its agent), waits for the turn to
 * settle, and returns the final assistant text. Targeted delivery runs the
 * same flow against any other session id (`runIn`), and `ensureLive` attaches
 * the duty session without a turn (the web sidebar button entry point). The
 * resume/create + summarize pattern follows @kriskwok/dsh-feishu-gateway (MIT).
 *
 * Rotation (2026-09-13): the duty session used to grow without bound — the
 * 2026-09-02 archive reached 29,755 events (41.8 MB uncompressed) and every
 * turn rescanned the FULL event array (O(n) per turn, O(n^2) overall). The
 * driver now tracks its own "current duty session id", rotates to a fresh
 * `-rN` successor when the turn/event thresholds from session-guard are hit,
 * carries a handoff summary into the successor system prompt, and slices the
 * event tail before summarize() (O(log n + delta) per turn). Rotation state
 * is in-memory: after a dsh restart the driver returns to the base session,
 * but the event-count threshold then re-rotates on the FIRST turn, so an
 * oversized base session self-heals instead of wedging.
 * @module @luzhengyangtx/dsh-telegram-duty/duty
 */

import type { Context } from '@deepseek-ai/cordis'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import type { Agent, ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-agent-presets'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { TextBlock } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import {
  buildHandoffSummary,
  extractLastAssistantText,
  extractLastUsageInputTokens,
  sessionEventCount,
  sessionEventsFrom,
  sessionEventsOf,
  shouldRotate,
  sliceFromSeq,
} from './session-guard.ts'

/**
 * Message source marking phone-injected user messages. The duty session's own
 * injections use `telegram-duty` (the host projection unit folds on it to
 * mark the duty session for the web sidebar button); deliveries into OTHER
 * sessions use the targeted name so they never mark those sessions.
 */
export const DUTY_SOURCE_PLUGIN = 'telegram-duty'
export const TARGETED_SOURCE_PLUGIN = 'telegram-duty-targeted'

export interface TurnOutcome {
  text: string
  /** Non-empty when the turn ended abnormally ('OFFLINE' = target cannot wake). */
  error?: string
  /** True when the turn was aborted (e.g. /unblock or a web-side cancel). */
  cancelled?: boolean
  /**
   * Set on a duty turn that triggered rotation: the session id the NEXT duty
   * turn will use. Informational (the driver logs the handoff itself).
   */
  rotatedTo?: string
}

/** Error marker for a targeted session that could not be resumed. */
export const TARGET_OFFLINE_ERROR = 'OFFLINE'

export interface SessionDriverOptions {
  /** Stable duty session id base (created on first delivery when absent). Rotated successors get `-rN` suffixes. */
  dutySessionId: string
  /** Absolute workspace cwd for the duty session. */
  cwd: string
  /** Persona text registered under the deployment persona slot (duty only). */
  persona: string
  /** Rotate the duty session after this many turns (0 = unlimited turns). */
  maxTurnsPerSession?: number
  /** Rotate when the duty session event log reaches this length (0 = unlimited). */
  maxSessionEvents?: number
  /** Master switch for automatic rotation; false keeps one ever-growing session. */
  autoRotate?: boolean
  /**
   * Rotate when the last recorded usage.inputTokens reaches this (0 = off).
   * Primary cost guard: every turn before rotation pays ~this many input
   * tokens. Harness evidence: peak 598,312 inputTokens, final turn died
   * with CONTEXT_WINDOW_EXCEEDED (glm-5.3-flash).
   */
  maxContextTokens?: number
}

/**
 * Aggregate the final assistant text from session events since firstSeq:
 * the last tool-free assistant/message of the turn; a `turn/end` with a
 * non-completed reason becomes an error outcome, while an aborted turn is
 * marked `cancelled` (a deliberate interruption, not a failure).
 */
export function summarize(events: readonly SessionEvent[], firstSeq: number): TurnOutcome {
  let started = false
  let text = ''
  let error: string | undefined
  let cancelled = false
  for (const event of events) {
    if (event.seq < firstSeq) continue
    if (event.type === 'turn/start') {
      started = true
      continue
    }
    if (!started) continue
    if (event.type === 'assistant/message') {
      const joined = event.data.message.content
        .filter((block): block is TextBlock => block.type === 'text')
        .map(block => block.text)
        .join('')
      if (joined !== '') text = joined
    }
    if (event.type === 'turn/end') {
      const reason = event.data.reason
      if (reason.kind === 'error') error = `${reason.error.code}: ${reason.error.message}`
      else if (reason.kind === 'aborted') cancelled = true
      else if (reason.kind !== 'completed') error = `turn ended with reason "${reason.kind}"`
    }
  }
  if (error !== undefined) return { text, error }
  return cancelled ? { text, cancelled: true } : { text }
}

/** Serialized delivery into the duty session and, when targeted, others. */
export class SessionDriver {
  private readonly ctx: Context
  private readonly options: SessionDriverOptions
  private chain: Promise<unknown> = Promise.resolve()
  private presetPromise: Promise<string | undefined> | undefined
  /** The duty session id the NEXT duty delivery attaches to; `-rN` after rotations. */
  private currentDutyId: string
  /** Delivered duty turns since the last rotation. */
  private turnsOnDuty = 0
  /** Monotonic rotation counter backing the `-rN` successor suffixes. */
  private rotationCount = 0
  /** Summary carried into the successor session's system prompt on its first mount. */
  private pendingSummary: string | undefined
  /** Latest observed usage.inputTokens (undefined until first usage chunk). */
  private lastInputTokens: number | undefined
  /** One-time full-log usage baseline flag, per rotation cycle. */
  private usageScanned = false
  /** provider/model -> resolved contextWindow (adapter metadata; undefined = unknown). */
  private windowCache = new Map<string, number | undefined>()

  constructor(
    ctx: Context,
    options: SessionDriverOptions,
  ) {
    this.ctx = ctx
    this.options = options
    this.currentDutyId = options.dutySessionId
  }

  /** The duty session id the next duty delivery (or ensureLive) will use. */
  currentDutySessionId(): string {
    return this.currentDutyId
  }

  /**
   * Resolve the default agent preset id once. Mounting it in setup is what
   * gives the duty agent its tools — without it the model has no tool schemas
   * and "fakes" tool calls as plain text (observed in e2e).
   */
  private resolvePreset(): Promise<string | undefined> {
    this.presetPromise ??= (async () => {
      const presets = this.ctx.get('agentPresets')
      if (presets === undefined) return undefined
      return (await presets.resolve(undefined)).id
    })()
    return this.presetPromise
  }

  /** Queue one Telegram text into the duty session; resolves with the reply. */
  async run(text: string): Promise<TurnOutcome> {
    return await this.runIn(this.currentDutySessionId(), text)
  }

  /** Queue one Telegram text into an arbitrary session id. */
  async runIn(sessionId: string, text: string): Promise<TurnOutcome> {
    let outcome: TurnOutcome = { text: '' }
    const next = this.chain
      .catch(() => undefined)
      .then(async () => {
        try {
          outcome = await this.turn(sessionId, text)
        } catch (error) {
          // Surface the failure as an outcome so the gateway can reply it.
          outcome = { text: '', error: error instanceof Error ? error.message : String(error) }
        }
      })
    this.chain = next.catch(() => undefined)
    await next
    return outcome
  }

  /**
   * Attach the duty session without running a turn (resume, or create when it
   * never existed). The attached agent is deliberately NOT disposed: the
   * caller (the web sidebar button) wants the session live.
   */
  async ensureLive(): Promise<{ error?: string }> {
    let result: { error?: string } = {}
    const next = this.chain
      .catch(() => undefined)
      .then(async () => {
        try {
          await this.attach(this.currentDutySessionId(), true)
        } catch (error) {
          result = { error: error instanceof Error ? error.message : String(error) }
        }
      })
    this.chain = next.catch(() => undefined)
    await next
    return result
  }

  /**
   * Resolve one session as a live agent, reusing an already-live one. Setup
   * mounts the default preset (tools) and model selection; the persona is
   * duty-only. A targeted session that cannot be resumed reports OFFLINE
   * instead of creating a fresh blank session (only the duty session is
   * auto-created).
   */
  private async attach(
    sessionId: string,
    isDuty: boolean,
  ): Promise<{ agent: Agent; dispose: () => Promise<void> }> {
    const agents = this.ctx.agents
    const defaultModel = this.ctx.agentDefaultModel
    const selection = defaultModel.currentSelection()
    const agentOptions = { provider: selection.provider, model: selection.model }
    const presetId = await this.resolvePreset()
    const setup = async (agentCtx: Context): Promise<void> => {
      const selected: ModelSelectionRef = { current: selection, assembled: undefined }
      installModelSelection(agentCtx, selected)
      // Same name + order as the deployment persona → shadows it for this agent.
      if (isDuty) {
        agentCtx.systemPrompt.section({ name: 'deployment:persona', order: 0, text: this.options.persona })
        // Rotation handoff: the successor session opens with the summary of
        // the retired one, as a system-prompt section (not chat history), so
        // continuity survives without inheriting the old event log.
        const handoff = this.pendingSummary
        if (handoff !== undefined) {
          agentCtx.systemPrompt.section({ name: 'telegram-duty:handoff', order: 1, text: handoff })
          this.pendingSummary = undefined
        }
      }
      // Mount the default preset so the agent has the standard tools
      // (bash/pwsh/fs/subagents/...), exactly like web-created sessions.
      if (presetId !== undefined) {
        const presets = this.ctx.get('agentPresets')
        if (presets !== undefined) await presets.mount(agentCtx, presetId)
      }
    }

    const live = agents.get(SessionId(sessionId))
    if (live !== undefined) return { agent: live, dispose: async () => undefined }

    let handle
    try {
      handle = await agents.resume({ resumeSessionId: SessionId(sessionId), agentOptions, setup })
    } catch (error) {
      const resumeError = error instanceof Error ? error.message : String(error)
      if (!isDuty) throw new Error(TARGET_OFFLINE_ERROR)
      this.ctx.logger.warn('telegram-duty', `resume "${sessionId}" failed (${resumeError}), creating`)
      try {
        handle = await agents.create({
          sessionId: SessionId(sessionId),
          meta: {
            cwd: this.options.cwd,
            ...(presetId !== undefined ? { agentPreset: presetId } : {}),
          },
          agentOptions,
          setup,
        })
      } catch (createError) {
        const createMessage = createError instanceof Error ? createError.message : String(createError)
        throw new Error(`resume failed (${resumeError}); create failed (${createMessage})`)
      }
    }
    return {
      agent: handle.agent,
      dispose: () => handle.dispose().catch((error: unknown) => {
        this.ctx.logger.warn('telegram-duty', `dispose agent error: ${error instanceof Error ? error.message : String(error)}`)
      }),
    }
  }

  private async turn(sessionId: string, text: string): Promise<TurnOutcome> {
    let isDuty = sessionId === this.currentDutySessionId()
    let attached = await this.attach(sessionId, isDuty)
    if (isDuty && !this.usageScanned) {
      // One-time per-cycle baseline: read the LAST usage chunk from the whole
      // event log (CPU-only, no API cost) so an oversized INHERITED session
      // rotates BEFORE paying one oversized LLM input. dsh 0.1.5-rc.1 has no
      // `events` property at all, so the log is read through sessionEventsOf()
      // (rc.1 snapshotEvents), keeping this valid on both API generations.
      await attached.agent.whenIdle()
      this.lastInputTokens = extractLastUsageInputTokens(sessionEventsOf(attached.agent.session))
      this.usageScanned = true
      if (this.rotateNow(attached.agent, await this.resolveMaxContextTokens())) {
        const handoff = buildHandoffSummary(extractLastAssistantText(sessionEventsOf(attached.agent.session)), this.turnsOnDuty)
        this.performRotation(handoff, attached.agent)
        await attached.dispose()
        sessionId = this.currentDutySessionId()
        isDuty = true
        attached = await this.attach(sessionId, isDuty)
      }
    }
    const { agent, dispose } = attached
    try {
      await agent.whenIdle()
      const firstSeq = agent.session.seq
      agent.followup(createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: 'plugin', plugin: isDuty ? DUTY_SOURCE_PLUGIN : TARGETED_SOURCE_PLUGIN },
      }))
      await agent.whenIdle()
      // O(log n + delta): slice the tail at firstSeq instead of rescanning the
      // whole ever-growing event array every turn.
      const tail = sessionEventsFrom(agent.session, firstSeq) as readonly SessionEvent[]
      const outcome = summarize(tail, firstSeq)
      if (isDuty) {
        const used = extractLastUsageInputTokens(tail)
        if (used !== undefined) this.lastInputTokens = used
        this.maybeRotate(agent, outcome, await this.resolveMaxContextTokens())
      }
      return outcome
    } finally {
      // Release our own handle when we created one; a live foreign agent stays.
      await dispose()
    }
  }

  /**
   * Account the finished duty turn and rotate to a fresh `-rN` successor when
   * the thresholds say so. Runs on the serialized delivery chain; the next
   * duty delivery (or ensureLive) creates the successor — resume fails on the
   * fresh id, the create path runs setup, and setup consumes the handoff
   * summary into the successor system prompt.
   */
  /**
   * Effective token ceiling: the configured cap, clamped by the CURRENT
   * model's real context window (x0.75 safety) when the adapter exposes it.
   * This is what makes a mid-duty model switch safe: switching to a
   * smaller-window model re-derives the ceiling instead of overflowing.
   * Falls back to the configured cap when no llm service/metadata exists.
   */
  private async resolveMaxContextTokens(): Promise<number> {
    const cap = this.options.maxContextTokens
    if (cap === 0) return 0
    const llm = this.ctx.get('llm') as { resolveModelInfo?: (provider: string, model: string) => Promise<unknown> } | undefined
    if (llm === undefined || typeof llm.resolveModelInfo !== 'function') return cap
    const selection = this.ctx.agentDefaultModel.currentSelection()
    const key = `${selection.provider}/${selection.model}`
    let window = this.windowCache.get(key)
    if (window === undefined && !this.windowCache.has(key)) {
      try {
        const info = await llm.resolveModelInfo(selection.provider, selection.model) as { context?: { contextWindow?: number } } | undefined
        const resolved = info?.context?.contextWindow
        window = typeof resolved === 'number' && resolved > 0 ? resolved : undefined
      } catch {
        window = undefined
      }
      this.windowCache.set(key, window)
    }
    return window === undefined ? cap : Math.min(cap, Math.floor(window * 0.75))
  }

  /** Rotation decision against ALL axes (turns / events / tokens). */
  private rotateNow(agent: Agent, maxContextTokens: number): boolean {
    return shouldRotate(
      {
        turns: this.turnsOnDuty,
        eventCount: sessionEventCount(agent.session),
        lastInputTokens: this.lastInputTokens,
      },
      {
        maxTurnsPerSession: this.options.maxTurnsPerSession,
        maxSessionEvents: this.options.maxSessionEvents,
        maxContextTokens,
        autoRotate: this.options.autoRotate,
      },
    )
  }

  /** Switch to a fresh -rN successor; caller supplies the handoff summary. */
  private performRotation(summary: string, agent: Agent, outcome?: TurnOutcome): void {
    this.rotationCount += 1
    const successor = `${this.options.dutySessionId}-r${this.rotationCount}`
    this.pendingSummary = summary
    const tokenNote = this.lastInputTokens === undefined ? '' : `, inputTokens=${this.lastInputTokens}`
    this.ctx.logger.info(
      'telegram-duty',
      `duty session rotation: "${this.currentDutyId}" -> "${successor}" after ${this.turnsOnDuty} turns (events=${sessionEventCount(agent.session)}${tokenNote})`,
    )
    this.currentDutyId = successor
    this.turnsOnDuty = 0
    this.usageScanned = false
    this.lastInputTokens = undefined
    if (outcome !== undefined) outcome.rotatedTo = successor
  }

  private maybeRotate(agent: Agent, outcome: TurnOutcome, maxContextTokens: number): void {
    this.turnsOnDuty += 1
    if (!this.rotateNow(agent, maxContextTokens)) return
    this.performRotation(buildHandoffSummary(outcome.text, this.turnsOnDuty), agent, outcome)
  }
}