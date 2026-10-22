import { useCallback, useEffect, useMemo, useRef } from 'react'

/**
 * Runs work that frames a just-loaded project, or reads its nodes off React Flow's store, only once
 * that store holds the project's nodes (`flowOwnerProjectId`, see flowStoreOwner.ts).
 *
 * The load effect's settle timer used to run that work directly. A session-changing switch
 * remounts `<ReactFlow>` one commit AFTER the store copies the incoming nodes, and that copy runs
 * in a passive effect React may defer to a later task — so a due timer could fire first. The work
 * then framed the OUTGOING pan/zoom instance, which the remount destroys (the new one starts from
 * the saved camera), and `getInternalNode` answered from the outgoing project's copy of a shared
 * node id. A local → local switch has no remount, but its owner still flips, so the same rule holds.
 *
 * `land(projectId, run)` queues `run` and runs it at once if the store already holds that project
 * (an in-place reload, or a timer that fired after the copy); otherwise the owner effect runs it
 * when ownership arrives. One item at a time: a later `land` replaces it, and `cancel` drops it —
 * the load effect's cleanup calls it, so a project the user moved on from never runs its work late.
 *
 * The owner is read from a ref set in a PASSIVE effect, never at render time: Canvas's own effects
 * run after its children's, so by then the remounted `<ReactFlow>` has handed its store the nodes
 * and its new pan/zoom instance.
 */
export function useFlowLanding(flowOwnerProjectId: string | null): {
  land: (projectId: string, run: () => void) => void
  cancel: () => void
} {
  const committedOwnerRef = useRef<string | null>(null)
  const queuedRef = useRef<{ projectId: string; run: () => void } | null>(null)

  const flush = useCallback(() => {
    const queued = queuedRef.current
    if (!queued || queued.projectId !== committedOwnerRef.current) return
    queuedRef.current = null
    queued.run()
  }, [])

  useEffect(() => {
    committedOwnerRef.current = flowOwnerProjectId
    flush()
  }, [flowOwnerProjectId, flush])

  const land = useCallback(
    (projectId: string, run: () => void) => {
      queuedRef.current = { projectId, run }
      flush()
    },
    [flush]
  )
  const cancel = useCallback(() => {
    queuedRef.current = null
  }, [])

  return useMemo(() => ({ land, cancel }), [land, cancel])
}
