/**
 * Photo support: download one Telegram photo (largest file_size variant) via
 * getFile + file download URL, and persist it through the host attachment
 * store so it can ride a user message as a durable ImageBlock.
 *
 * Telegram sends photos as an array of resized variants; we pick the largest
 * by file_size (falling back to the last entry, which Telegram documents as
 * the biggest). File downloads go over the same proxy as the Bot API.
 * @module @social-sky/dsh-telegram-duty/photo
 */

import * as https from 'node:https'
import type { IncomingMessage } from 'node:http'
import type { TelegramClient, TelegramPhotoSize } from './telegram.ts'

/** Telegram file API response for getFile. */
export interface TelegramFile {
  file_id: string
  file_unique_id?: string
  file_size?: number
  file_path?: string
}

/** One downloaded photo, ready for attachment admission. */
export interface DownloadedPhoto {
  data: Uint8Array
  mediaType: 'image/jpeg'
  name: string
}

/** Max bytes we accept for one photo (Bot API bots receive ≤ ~5 MB photos). */
export const MAX_PHOTO_BYTES = 10 * 1024 * 1024

/** Pick the largest variant of a Telegram photo array. */
export function largestPhotoSize(photos: readonly TelegramPhotoSize[]): TelegramPhotoSize | undefined {
  if (photos.length === 0) return undefined
  let best = photos[0]
  for (const candidate of photos) {
    if ((candidate.file_size ?? -1) > (best.file_size ?? -1)) best = candidate
  }
  // Telegram's last variant is the original when file_size is absent.
  if ((best.file_size ?? -1) < 0) best = photos[photos.length - 1]
  return best
}

/**
 * GET one binary URL through the same https.Agent as the Bot API client,
 * enforcing a byte cap so a hostile/mis-sized file cannot exhaust memory.
 */
function fetchBinary(url: string, agent: https.Agent, maxBytes: number): Promise<Uint8Array> {
  return fetchBinaryImpl(url, agent, maxBytes, https.request)
}

/**
 * Same call shape as {@link fetchBinary} but routed through
 * `client.requestBinary` so tests can supply a deterministic stub.
 */
function fetchBinaryVia(
  client: TelegramClient,
  url: string,
  agent: https.Agent,
  maxBytes: number,
): Promise<Uint8Array> {
  return fetchBinaryImpl(url, agent, maxBytes, client.requestBinary)
}

function fetchBinaryImpl(
  url: string,
  agent: https.Agent,
  maxBytes: number,
  requester: (...args: Parameters<typeof https.request>) => ReturnType<typeof https.request>,
): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const req = requester(url, { agent, method: 'GET' }, (res: IncomingMessage) => {
      if (res.statusCode !== 200) {
        res.resume()
        reject(new Error(`photo download failed with HTTP ${res.statusCode}`))
        return
      }
      const chunks: Buffer[] = []
      let total = 0
      res.on('data', (chunk: Buffer) => {
        total += chunk.length
        if (total > maxBytes) {
          req.destroy(new Error(`photo download exceeded ${maxBytes} bytes`))
          return
        }
        chunks.push(chunk)
      })
      res.on('end', () => resolve(new Uint8Array(Buffer.concat(chunks))))
      res.on('error', reject)
    })
    req.setTimeout(30_000, () => {
      req.destroy(new Error('photo download timed out after 30000ms'))
    })
    req.on('error', reject)
    req.end()
  })
}

/**
 * Download the largest variant of one Telegram photo as JPEG bytes.
 * Uses the client's agent so the download honors the deployment proxy.
 */
export async function downloadPhoto(
  client: TelegramClient,
  photo: TelegramPhotoSize,
): Promise<DownloadedPhoto> {
  const fileRes = await client.call<TelegramFile>('getFile', { file_id: photo.file_id }, 30_000)
  if (!fileRes.ok || fileRes.result?.file_path === undefined) {
    throw new Error(`getFile rejected: ${fileRes.description ?? 'no file_path'}`)
  }
  // Undocumented-but-stable download host; path is bot-scoped.
  const url = `https://api.telegram.org/file/bot${client.botToken}/${fileRes.result.file_path}`
  // Use the test-overridable seam so unit tests can stub the network layer
  // without monkey-patching the global `node:https` module (which is sealed
  // under ESM module namespaces).
  const data = await fetchBinaryVia(client, url, client.httpAgent, MAX_PHOTO_BYTES)
  return {
    data,
    mediaType: 'image/jpeg',
    name: `telegram-photo-${photo.file_unique_id ?? photo.file_id.slice(-8)}.jpg`,
  }
}
