import { createContext, createElement, useContext, type ReactNode } from 'react'
import { SessionProvider, sessionForProject, type SessionSource } from './session'

/**
 * The project whose nodes the surrounding subtree renders — set by Canvas around `<ReactFlow>`
 * (to the project React Flow's store holds, `useFlowStoreOwner`) and by `ProjectSessionScope`
 * around a surface that mounts a node outside the canvas (the kanban card modal, on both boards).
 * `null` = not known: outside any provider, or before React Flow has held a project.
 *
 * It exists beside the SessionProvider because a session alone cannot say whether a node is in
 * the right place. An unbound remote project resolves to the offline relay session, whose calls
 * all reject — but a node of a remote project that ends up under a LOCAL session anyway (a provider
 * keyed on the wrong project, a surface mounted outside any project's provider) would create its
 * host-side id on this core. The terminal asks `spawnBelongsElsewhere` with this id before it spawns.
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

/**
 * Mount `children` the way a node of `projectId` is mounted on the canvas: under THAT project's
 * session (`sessionForProject` — the relay session for a bound team tab, the offline relay session
 * for an unbound one, the local session for a local project), keyed by the session id so a session
 * change remounts them, with `OwningProjectContext` set to the project. For a surface that renders a
 * project's node outside Canvas's node subtree — the kanban boards live under App's LOCAL provider,
 * so a card modal mounted there would otherwise attach a team tab's terminal to this desktop's core.
 *
 * The session is resolved at render (the registry is runtime, not reactive), like Canvas's.
 */
export function ProjectSessionScope({ projectId, children }: { projectId: string; children: ReactNode }) {
  const session = sessionForProject(projectId)
  return createElement(SessionProvider, {
    session,
    key: session.id,
    children: createElement(OwningProjectContext.Provider, { value: projectId }, children)
  })
}
