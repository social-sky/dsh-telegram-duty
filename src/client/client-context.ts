/**
 * Structural client context for the browser half (rc.1 face). Type-only:
 * erased at build time, so the bundle requires nothing beyond the react
 * JSX runtime seed word.
 */

import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'

/** The subset of the client root context the duty UI consumes. */
export interface DutyClientContext {
	/** Session list/binding face provided by the session controller. */
	sessions: ISessions & { refresh(): Promise<void> }
	/** Locale registration face. */
	locale: {
		register(namespace: string, dictionary: unknown, tag: string): unknown
	}
	/** Slot mutation face. */
	slots: {
		inject(address: string, factory: () => unknown): unknown
		register(face: unknown, component?: unknown): unknown
	}
	/** Remote event face (forwarded host events). */
	remote: { $on(event: string, handler: (payload: never) => void): () => void }
	/** Scoped effect with dispose. */
	effect(body: () => () => void, tag: string): void
	/** Client event subscription. */
	on(event: 'connection/reset', handler: () => void): () => void
}
