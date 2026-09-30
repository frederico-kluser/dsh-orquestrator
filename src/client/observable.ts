/**
 * A minimal observable snapshot store: the `getSnapshot`/`subscribe` pair
 * React's `useSyncExternalStore` consumes. Kept local so the plugin's pure
 * client logic carries no runtime import from the DSH module table.
 * @module dsh-orquestrator/client/observable
 */

/** Read side of a store. */
export interface Observable<T> {
  getSnapshot(): T
  subscribe(listener: () => void): () => void
}

/** Read/write store. */
export interface Store<T> extends Observable<T> {
  set(next: T): void
}

/**
 * Create a store.
 * @param initial - the first snapshot.
 * @returns the store; `set` notifies subscribers only when the value changed.
 */
export function createStore<T>(initial: T): Store<T> {
  let value = initial
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => value,
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    set(next) {
      if (Object.is(next, value)) return
      value = next
      for (const listener of [...listeners]) {
        try {
          listener()
        } catch (error: unknown) {
          console.error('dsh-orquestrator: store subscriber failed', error)
        }
      }
    },
  }
}
