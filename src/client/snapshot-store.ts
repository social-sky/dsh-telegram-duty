/**
 * Local snapshot store (rc.1-native). dsh 0.1.5-rc.1 no longer ships
 * `@deepseek-ai/dsh-client-runtime` as a resolvable client module, and the
 * renderer's `bindSnapshotSelector` contract only requires `subscribe(fn)`
 * plus `getSnapshot()`. This file implements that contract in-package so the
 * client half carries zero injected runtime modules.
 */

/** Minimal observable snapshot store consumed by the renderer's selector hook. */
export interface SnapshotStore<T> {
	/** Current immutable snapshot. */
	getSnapshot(): T
	/** Apply a recipe to a structural clone; the result becomes the snapshot. */
	update(recipe: (draft: T) => void): void
	/** Subscribe to snapshot changes; returns the unsubscribe function. */
	subscribe(listener: () => void): () => void
}

/** Create a snapshot store over `initial`; every update clones, then notifies. */
export function createSnapshotStore<T>(initial: T): SnapshotStore<T> {
	let snapshot = initial
	const listeners = new Set<() => void>()
	return {
		getSnapshot: () => snapshot,
		update(recipe) {
			const draft = structuredClone(snapshot)
			recipe(draft)
			snapshot = draft
			for (const listener of listeners) listener()
		},
		subscribe(listener) {
			listeners.add(listener)
			return () => {
				listeners.delete(listener)
			}
		},
	}
}
