import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_MAX_TURNS_PER_SESSION,
  DEFAULT_MAX_SESSION_EVENTS,
  shouldRotate,
  sliceFromSeq,
  buildHandoffSummary,
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