import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_MAX_TURNS_PER_SESSION,
  DEFAULT_MAX_SESSION_EVENTS,
  DEFAULT_MAX_CONTEXT_TOKENS,
  shouldRotate,
  sliceFromSeq,
  buildHandoffSummary,
  extractLastUsageInputTokens,
  extractMaxUsageInputTokens,
  extractLastAssistantText,
  HANDOFF_SUMMARY_CAP,
} from '../src/session-guard.ts'

// --- shouldRotate: turn threshold ---

test('shouldRotate: defaults trigger at the turn threshold, not before', () => {
  assert.equal(shouldRotate({ turns: DEFAULT_MAX_TURNS_PER_SESSION - 1 }), false)
  assert.equal(shouldRotate({ turns: DEFAULT_MAX_TURNS_PER_SESSION }), true)
})

test('shouldRotate: event-count threshold triggers independently', () => {
  assert.equal(shouldRotate({ turns: 1, eventCount: DEFAULT_MAX_SESSION_EVENTS - 1 }), false)
  assert.equal(shouldRotate({ turns: 1, eventCount: DEFAULT_MAX_SESSION_EVENTS }), true)
})

test('shouldRotate: custom thresholds override defaults on both axes', () => {
  const t = { maxTurnsPerSession: 3, maxSessionEvents: 10 }
  assert.equal(shouldRotate({ turns: 2, eventCount: 9 }, t), false)
  assert.equal(shouldRotate({ turns: 3, eventCount: 9 }, t), true)
  assert.equal(shouldRotate({ turns: 2, eventCount: 10 }, t), true)
})

test('shouldRotate: 0 means unlimited for that axis', () => {
  const t = { maxTurnsPerSession: 0, maxSessionEvents: 0 }
  assert.equal(shouldRotate({ turns: 1000000, eventCount: 1000000 }, t), false)
})

test('shouldRotate: autoRotate=false disables rotation entirely', () => {
  assert.equal(shouldRotate({ turns: 9999, eventCount: 9999 }, { autoRotate: false }), false)
})

test('shouldRotate: never rotates on nonsensical input', () => {
  assert.equal(shouldRotate({ turns: -5 }), false)
  assert.equal(shouldRotate({ turns: 3, eventCount: -1 }), false)
})

// --- shouldRotate: token axis (the primary cost guard) ---

test('shouldRotate: token axis trips at the default ceiling', () => {
  assert.equal(shouldRotate({ turns: 1, eventCount: 10, lastInputTokens: DEFAULT_MAX_CONTEXT_TOKENS - 1 }), false)
  assert.equal(shouldRotate({ turns: 1, eventCount: 10, lastInputTokens: DEFAULT_MAX_CONTEXT_TOKENS }), true)
})

test('shouldRotate: token axis uses real-observed 598K case', () => {
  // The archived session peaked at 598,312 inputTokens — must rotate.
  assert.equal(shouldRotate({ turns: 1, lastInputTokens: 598312 }), true)
})

test('shouldRotate: maxContextTokens=0 disables the token axis', () => {
  const t = { maxContextTokens: 0 }
  assert.equal(shouldRotate({ turns: 1, lastInputTokens: 999999 }, t), false)
})

test('shouldRotate: custom token threshold', () => {
  const t = { maxContextTokens: 100000 }
  assert.equal(shouldRotate({ turns: 1, lastInputTokens: 99999 }, t), false)
  assert.equal(shouldRotate({ turns: 1, lastInputTokens: 100000 }, t), true)
})

test('shouldRotate: token axis fires even when other axes are unlimited', () => {
  const t = { maxTurnsPerSession: 0, maxSessionEvents: 0 }
  assert.equal(shouldRotate({ turns: 0, eventCount: 0, lastInputTokens: DEFAULT_MAX_CONTEXT_TOKENS }, t), true)
})

// --- sliceFromSeq: binary-search tail slicing ---

const evts = (seqs) => seqs.map((seq) => ({ seq }))

test('sliceFromSeq: empty input yields empty tail', () => {
  assert.deepEqual(sliceFromSeq([], 5), [])
})

test('sliceFromSeq: all events before firstSeq yields empty tail', () => {
  const events = evts([1, 2, 3])
  assert.deepEqual(sliceFromSeq(events, 10), [])
})

test('sliceFromSeq: all events at/after firstSeq yields everything', () => {
  const events = evts([5, 6, 7])
  assert.deepEqual(sliceFromSeq(events, 1), events)
})

test('sliceFromSeq: exact boundary lands on the boundary event', () => {
  const events = evts([1, 2, 3, 4, 5])
  assert.deepEqual(sliceFromSeq(events, 3), evts([3, 4, 5]))
})

test('sliceFromSeq: absent firstSeq falls to the next existing seq', () => {
  const events = evts([10, 20, 30])
  assert.deepEqual(sliceFromSeq(events, 15), evts([20, 30]))
})

test('sliceFromSeq: single event below boundary', () => {
  assert.deepEqual(sliceFromSeq(evts([1]), 2), [])
  assert.deepEqual(sliceFromSeq(evts([2]), 2), evts([2]))
})

// --- usage extraction (real dsh event shape: assistant/chunk -> data.chunk.usage) ---

const usageChunk = (inputTokens, seq) => ({
  type: 'assistant/chunk',
  seq,
  data: { turn: 1, step: 1, chunk: { type: 'usage', usage: { inputTokens, outputTokens: 100 } } },
})

test('extractLastUsageInputTokens: returns the last usage chunk value', () => {
  const events = [usageChunk(1000, 1), usageChunk(2000, 2), usageChunk(3000, 3)]
  assert.equal(extractLastUsageInputTokens(events), 3000)
})

test('extractLastUsageInputTokens: ignores non-usage events and non-usage chunks', () => {
  const events = [
    { type: 'user/message', seq: 1, data: { source: { kind: 'plugin', plugin: 'telegram-duty' } } },
    { type: 'assistant/chunk', seq: 2, data: { chunk: { type: 'text', text: 'hi' } } },
    usageChunk(5000, 3),
  ]
  assert.equal(extractLastUsageInputTokens(events), 5000)
})

test('extractLastUsageInputTokens: no usage at all -> undefined', () => {
  assert.equal(extractLastUsageInputTokens([]), undefined)
  assert.equal(extractLastUsageInputTokens([{ type: 'turn/start', seq: 1, data: {} }]), undefined)
})

test('extractMaxUsageInputTokens: high-water mark across the whole log', () => {
  const events = [usageChunk(1000, 1), usageChunk(598312, 2), usageChunk(200000, 3)]
  assert.equal(extractMaxUsageInputTokens(events), 598312)
})

// --- assistant text extraction ---

const assistantMsg = (text, seq) => ({
  type: 'assistant/message',
  seq,
  data: { message: { content: [{ type: 'text', text }] } },
})

test('extractLastAssistantText: returns the LAST non-empty assistant text', () => {
  const events = [assistantMsg('first', 1), assistantMsg('', 2), assistantMsg('second', 3)]
  assert.equal(extractLastAssistantText(events), 'second')
})

test('extractLastAssistantText: joins multiple text blocks of one message', () => {
  const events = [{
    type: 'assistant/message',
    seq: 1,
    data: { message: { content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] } },
  }]
  assert.equal(extractLastAssistantText(events), 'ab')
})

test('extractLastAssistantText: no assistant text -> empty string', () => {
  assert.equal(extractLastAssistantText([]), '')
  assert.equal(extractLastAssistantText([{ type: 'user/message', seq: 1, data: {} }]), '')
})

// --- buildHandoffSummary ---

test('buildHandoffSummary: caps oversized replies and marks truncation', () => {
  const big = 'x'.repeat(HANDOFF_SUMMARY_CAP + 500)
  const summary = buildHandoffSummary(big, 7)
  assert.ok(summary.length < HANDOFF_SUMMARY_CAP + 300, 'summary should stay bounded')
  assert.ok(summary.includes('已截斷'))
  assert.ok(summary.includes('7'))
})

test('buildHandoffSummary: trims whitespace and falls back on empty replies', () => {
  assert.ok(buildHandoffSummary('   ', 2).includes('沒有留下文字回覆'))
  const summary = buildHandoffSummary('  hello  ', 1)
  assert.ok(summary.includes('hello'))
  assert.ok(!summary.includes('hello  \n'), 'should trim the reply')
})