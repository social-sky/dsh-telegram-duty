import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import https from 'node:https'
import { Gateway, startTypingLoop, TYPING_INTERVAL_MS } from '../src/gateway.ts'
import type { TelegramClient, TelegramUpdate } from '../src/telegram.ts'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { stringsFor } from '../src/i18n.ts'
import { largestPhotoSize } from '../src/photo.ts'

const strings = stringsFor('zh')

function ev(seq: number, type: string, data: unknown): SessionEvent {
  return { seq, type, data } as unknown as SessionEvent
}

interface FakeAgent {
  id: string
  status: 'idle' | 'running'
  session: { seq: number; events: SessionEvent[] }
  whenIdle: ReturnType<typeof vi.fn>
  followup: ReturnType<typeof vi.fn>
  cancel: ReturnType<typeof vi.fn>
}

function agentOf(id: string, reply: string, extra: Partial<FakeAgent> = {}): FakeAgent {
  const events = [
    ev(1, 'turn/start', { turn: 1 }),
    ev(2, 'assistant/message', { turn: 1, step: 1, message: { content: [{ type: 'text', text: reply }] } }),
    ev(3, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
  ]
  return {
    id,
    status: 'idle',
    session: { seq: 1, events },
    whenIdle: vi.fn(async () => undefined),
    followup: vi.fn(),
    cancel: vi.fn(),
    ...extra,
  }
}

interface FakeClient {
  sent: string[]
  actions: string[]
}

interface FakeResponse {
  statusCode: number
  resume: () => void
  setEncoding: (enc: string) => void
  on: (event: string, cb: (chunk?: Buffer | Error) => void) => void
}

interface FakeRequest {
  setTimeout: (ms: number, cb: () => void) => FakeRequest
  destroy: (err?: Error) => void
  on: (event: string, cb: (chunk?: Buffer | Error) => void) => void
  end: () => void
}

/** Build a stub response emitter that fires its handlers on the next microtask. */
function buildResponseEmitters(body: Buffer, status: number): {
  res: FakeResponse
  req: FakeRequest
} {
  let onErrorHandlers: Array<(err: Error) => void> = []
  const res: FakeResponse = {
    statusCode: status,
    resume: () => undefined,
    setEncoding: () => undefined,
    on: (event, cb) => {
      if (event === 'data') {
        queueMicrotask(() => cb(body))
        queueMicrotask(() => {
          for (const fn of (res.on as never as { end: () => void }[] ?? []) as never) (fn as () => void)()
        })
      } else if (event === 'end') {
        queueMicrotask(() => cb())
      } else if (event === 'error') {
        onErrorHandlers.push(cb as (err: Error) => void)
      }
    },
  }
  const req: FakeRequest = {
    setTimeout: () => req,
    destroy: () => undefined,
    on: () => undefined,
    end: () => undefined,
  }
  void onErrorHandlers
  return { res, req }
}

/**
 * Produce a stub for TelegramClient.requestBinary that synthesizes the
 * Node.js IncomingMessage flow (data → end on success, error on failure).
 */
function stubDownload(
  behavior: (url: string) => { status?: number; body?: Buffer; error?: Error } | undefined,
): (url: string, opts: unknown, cb: (res: FakeResponse) => void) => FakeRequest {
  return (url, _opts, cb) => {
    const req: FakeRequest = {
      setTimeout: () => req,
      destroy: () => undefined,
      on: () => undefined,
      end: () => undefined,
    }
    queueMicrotask(() => {
      try {
        const out = behavior(url)
        if (out?.error !== undefined) {
          const errorHandlers: Array<(err: Error) => void> = []
          ;(req as unknown as { on: (e: string, cb: (err: Error) => void) => void }).on('error', (err) => {
            for (const fn of errorHandlers) fn(err)
          })
          errorHandlers.push((err) => req.destroy?.(err))
          queueMicrotask(() => {
            for (const fn of errorHandlers) fn(out.error as Error)
          })
          return
        }
        const status = out?.status ?? 200
        const body = out?.body ?? Buffer.alloc(0)
        const dataHandlers: Array<(chunk: Buffer) => void> = []
        const endHandlers: Array<() => void> = []
        const res: FakeResponse = {
          statusCode: status,
          resume: () => undefined,
          setEncoding: () => undefined,
          on: (event, fn) => {
            if (event === 'data') dataHandlers.push(fn as (chunk: Buffer) => void)
            else if (event === 'end') endHandlers.push(fn as () => void)
          },
        }
        cb(res)
        queueMicrotask(() => {
          if (status === 200) {
            for (const fn of dataHandlers) fn(body)
            for (const fn of endHandlers) fn()
          } else {
            for (const fn of endHandlers) fn()
          }
        })
      } catch (error) {
        req.destroy?.(error as Error)
      }
    })
    return req
  }
}

function fakeClient(
  getFileResult: unknown,
  requestBinaryImpl?: (url: string, opts: unknown, cb: (res: FakeResponse) => void) => FakeRequest,
): TelegramClient & FakeClient {
  const client: FakeClient = { sent: [], actions: [] }
  return {
    ...client,
    sendMessage: vi.fn(async (_chatId: number, text: string) => {
      client.sent.push(text)
      return { ok: true }
    }),
    sendChatAction: vi.fn(async (_chatId: number, action: string) => {
      client.actions.push(action)
      return { ok: true }
    }),
    answerCallbackQuery: vi.fn(async () => ({ ok: true })),
    getUpdates: vi.fn(),
    getMe: vi.fn(),
    close: vi.fn(),
    call: vi.fn(async () => getFileResult),
    httpAgent: new https.Agent({ keepAlive: false }),
    botToken: 'test-token',
    requestBinary: (requestBinaryImpl ?? (() => ({ setTimeout: () => ({} as never), destroy: () => undefined, on: () => undefined, end: () => undefined }))) as never,
  } as unknown as TelegramClient & FakeClient
}

interface GatewayHarness {
  gateway: Gateway
  client: TelegramClient & FakeClient
  duty: FakeAgent
  ctx: Context
  attachmentSaves: Array<{ data: Uint8Array; mediaType: string; name?: string }>
}

function makeGateway(opts: {
  dutyReply?: string
  get?: (id: string) => FakeAgent | undefined
  attachments?: { saveImage: ReturnType<typeof vi.fn> }
  getFileResult?: unknown
  downloadBehavior?: (url: string) => { status?: number; body?: Buffer; error?: Error } | undefined
} = {}): GatewayHarness {
  const duty = agentOf('duty', opts.dutyReply ?? '已辨識圖片')
  const attachmentSaves: Array<{ data: Uint8Array; mediaType: string; name?: string }> = []
  const saveImage = opts.attachments?.saveImage
    ?? vi.fn(async (input: { data: Uint8Array; mediaType: string; name?: string }) => {
      attachmentSaves.push(input)
      return { attachmentId: 'att-1', mediaType: 'image/jpeg' as const, bytes: input.data.length, width: 1, height: 1, name: input.name }
    })
  const ctx = {
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    get: vi.fn((name: string) => (name === 'attachments' ? { saveImage } : undefined)),
    on: vi.fn(),
    agents: {
      roots: vi.fn(() => [duty]),
      get: vi.fn(opts.get ?? ((id: string) => (id === 'duty' ? duty : undefined))),
      resume: vi.fn(async () => { throw new Error('no such session') }),
      create: vi.fn(async () => { throw new Error('create not expected') }),
      list: vi.fn(() => [duty]),
    },
    agentDefaultModel: {
      currentSelection: vi.fn(() => ({ provider: 'test', model: 'test' })),
    },
  } as unknown as Context
  const settings = {
    get: vi.fn(() => ({ watchMode: 'duty', language: 'zh' })),
    watch: vi.fn(),
    update: vi.fn(async () => undefined),
  }
  const stateOn = { update: vi.fn(async () => undefined) }
  const stateOff = { update: vi.fn(async () => undefined) }
  const client = fakeClient(
    opts.getFileResult ?? { ok: true, result: { file_id: 'f1', file_path: 'photos/f1.jpg' } },
    opts.downloadBehavior ? stubDownload(opts.downloadBehavior) : undefined,
  )
  const gateway = new Gateway({
    ctx,
    runtime: { chatId: 1, sessionId: 'duty', language: 'zh', approvalTimeoutMinutes: 10, replyChunkChars: 3800, dutyCwd: '.', dataDir: '.' },
    client,
    settings: settings as never,
    stateOn: stateOn as never,
    stateOff: stateOff as never,
  })
  return { gateway, client, duty, ctx, attachmentSaves }
}

function photoUpdate(id: number, caption?: string): TelegramUpdate {
  return {
    update_id: id,
    message: {
      message_id: id,
      chat: { id: 1 },
      caption,
      photo: [
        { file_id: 'small', file_unique_id: 's1', width: 90, height: 90, file_size: 1200 },
        { file_id: 'large', file_unique_id: 'l1', width: 1280, height: 960, file_size: 250_000 },
      ],
    },
  }
}

function followupContent(agent: FakeAgent): Array<{ type: string; text?: string; attachment?: unknown }> {
  const call = agent.followup.mock.calls.at(-1)?.[0] as { content: Array<{ type: string; text?: string; attachment?: unknown }> } | undefined
  return call?.content ?? []
}

describe('photo routing', () => {
  // photo delivery uses microtask I/O; fake timers would freeze the
  // queueMicrotask drain and hang the download path. Real timers only.
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('largestPhotoSize picks the biggest variant by file_size', () => {
    const picked = largestPhotoSize([
      { file_id: 'a', width: 90, height: 90, file_size: 1200 },
      { file_id: 'b', width: 640, height: 480, file_size: 80_000 },
      { file_id: 'c', width: 1280, height: 960, file_size: 250_000 },
    ])
    expect(picked?.file_id).toBe('c')
  })

  it('largestPhotoSize falls back to the last entry when sizes are absent', () => {
    const picked = largestPhotoSize([
      { file_id: 'a', width: 90, height: 90 },
      { file_id: 'b', width: 1280, height: 960 },
    ])
    expect(picked?.file_id).toBe('b')
  })

  it('delivers a photo message as image + caption into the duty session', async () => {
    const png = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6, 7, 8])
    const h = makeGateway({
      downloadBehavior: () => ({ status: 200, body: png }),
    })
    await h.gateway.handleUpdate(photoUpdate(1, '辨識這張圖'))
    expect(h.client.sent[0]).toBe(strings.ack)
    const content = followupContent(h.duty)
    expect(content[0]?.type).toBe('image')
    expect((content[0]?.attachment as { attachmentId: string }).attachmentId).toBe('att-1')
    expect(content[1]).toEqual({ type: 'text', text: '辨識這張圖' })
    expect(h.client.sent).toContain('已辨識圖片')
  })

  it('delivers image-only photos (no caption) with the image block alone', async () => {
    const png = Buffer.from([1, 2, 3])
    const h = makeGateway({ downloadBehavior: () => ({ status: 200, body: png }) })
    await h.gateway.handleUpdate(photoUpdate(2))
    const content = followupContent(h.duty)
    expect(content).toHaveLength(1)
    expect(content[0]?.type).toBe('image')
  })

  it('commits the downloaded bytes through the attachment store before the turn', async () => {
    const png = Buffer.from([1, 2, 3, 4, 5])
    const h = makeGateway({ downloadBehavior: () => ({ status: 200, body: png }) })
    await h.gateway.handleUpdate(photoUpdate(3, '記錄'))
    expect(h.attachmentSaves).toHaveLength(1)
    expect(h.attachmentSaves[0]?.mediaType).toBe('image/jpeg')
    expect(h.attachmentSaves[0]?.name).toContain('telegram-photo-')
    expect(h.attachmentSaves[0]?.data.length).toBe(png.length)
    expect(h.duty.followup).toHaveBeenCalledTimes(1)
  })

  it('replies taskError instead of running the turn when the attachment store is absent', async () => {
    const png = Buffer.from([1, 2, 3])
    const h = makeGateway({ downloadBehavior: () => ({ status: 200, body: png }) })
    ;(h.ctx.get as ReturnType<typeof vi.fn>).mockImplementation(() => undefined)
    await h.gateway.handleUpdate(photoUpdate(4, '辨識'))
    expect(h.client.sent.some(text => text.includes('no attachment store'))).toBe(true)
    expect(h.duty.followup).not.toHaveBeenCalled()
  })

  it('replies taskError instead of running the turn when getFile fails', async () => {
    const h = makeGateway({ getFileResult: { ok: false, description: 'file not found' } })
    await h.gateway.handleUpdate(photoUpdate(5, '辨識'))
    expect(h.client.sent.some(text => text.includes('getFile rejected'))).toBe(true)
    expect(h.duty.followup).not.toHaveBeenCalled()
  })

  it('still runs a plain text message exactly as before (no regression)', async () => {
    const h = makeGateway({})
    await h.gateway.handleUpdate({ update_id: 6, message: { message_id: 6, chat: { id: 1 }, text: '你好' } })
    const content = followupContent(h.duty)
    expect(content).toEqual([{ type: 'text', text: '你好' }])
    expect(h.attachmentSaves).toHaveLength(0)
  })
})

// Silence unused-import linters; buildResponseEmitters is reserved for future
// fidelity work (multi-chunk streaming bodies).
void buildResponseEmitters
void startTypingLoop
void TYPING_INTERVAL_MS
