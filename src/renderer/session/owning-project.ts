import { createContext, useContext } from 'react'
import type { SessionSource } from './session'

/**
 * The project whose nodes the surrounding subtree renders — set by Canvas around `<ReactFlow>`
 * (to the project React Flow's store holds, `useFlowStoreOwner`) and by a card modal around its
 * terminal. `null` = not known: outside any provider, or before React Flow has held a project.
 *
 * It exists beside the SessionProvider because a session alone cannot say whether a node is in
 * the right place: a remote project with no live relay binding resolves to the LOCAL session, so a
 * terminal that asked only for its session would happily create its host-side id on this core.
 */
export const OwningProjectContext = createContext<string | null>(null)

export function useOwningProjectId(): string | null {
  return useContext(OwningProjectContext)
}

/**
 * True when a spawn for a node of `project` would land on the wrong core: the project lives on
 * another machine (`remote`, a hosted team / relay tab) but the session the node runs under is not
 * a relay session — it is this desktop's own core. The caller must then start nothing.
 * An unknown project (undefined) is not evidence of anything and answers false.
 */
export function spawnBelongsElsewhere(project: { remote?: boolean } | undefined, source: SessionSource): boolean {
  return !!project?.remote && source !== 'relay'
}
