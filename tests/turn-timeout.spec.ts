
import { describe, expect, it, vi } from 'vitest'
import { SessionDriver } from '../src/duty.ts'

/**
 * whenIdleBounded is private; exercise it through a minimal subclass facade.
 * The driver constructor only stores ctx/options, so nulls are safe here.
 */
function boundedOf(minutes: number | undefined): { wait: (agent: { whenIdle: () => Promise<void> }, phase: string) => Promise<void> } {
  const driver = new SessionDriver(null as never, { dutySessionId: 't', cwd: '.', persona: '', ...(minutes !== undefined ? { turnTimeoutMinutes: minutes } : {}) })
  const bound = (driver as unknown as { whenIdleBounded: (a: { whenIdle: () => Promise<void> }, p: string) => Promise<void> }).whenIdleBounded.bind(driver)
  return { wait: (agent, phase) => bound(agent, phase) }
}

const hangForever = { whenIdle: () => new Promise<void>(() => {}) }

describe('whenIdleBounded', () => {
  it('resolves when the agent settles before the deadline', async () => {
    vi.useFakeTimers()
    const b = boundedOf(10)
    const settled = { whenIdle: () => Promise.resolve() }
    await expect(b.wait(settled, 'test')).resolves.toBeUndefined()
    vi.useRealTimers()
  })

  it('rejects when the agent never settles, at the configured deadline', async () => {
    vi.useFakeTimers()
    const b = boundedOf(0.001) // 60ms
    const p = b.wait(hangForever, 'test')
    const expectation = expect(p).rejects.toThrow(/turn timed out after 0.001 min/)
    await vi.advanceTimersByTimeAsync(61)
    await expectation
    vi.useRealTimers()
  })

  it('waits unlimited when the timeout is 0', async () => {
    const b = boundedOf(0)
    // If it wrongly raced a timer, this would reject; instead it mirrors whenIdle.
    let settled = false
    const p = b.wait({ whenIdle: () => Promise.resolve().then(() => { settled = true }) }, 'test')
    await p
    expect(settled).toBe(true)
  })
})
