// "Go to next agent needing you" (`node.nextNeedingYou`, audit roadmap #19 / qol-2): one chord
// instead of the 3-5 clicks it took to reach a waiting agent in another project (open the sidebar,
// find the project, find the row, click; more when the project is collapsed).
//
// Pure, so the ordering and the cycle are unit-tested here (vitest runs in the node environment,
// no jsdom). Canvas calls this ON DEMAND, once per keypress or palette open, reading the stores
// with `getState()` — it must NEVER subscribe to `statusById` for this: every working/waiting flip
// would re-render the whole canvas (see `StatusAwareMiniMap`'s header in Canvas.tsx).

import type { AgentNodeStatus } from '../state/agentStatus'
import { buildStatusList, type ProjectInput, type SessionNodeInput } from './sessionList'
import { nodeTravel, type TravelProject } from './presenceTravel'

export type NeedsYouProject = ProjectInput & TravelProject

/**
 * The node ids that need the user (`waiting` / `blocked` — the sidebar's "Need attention" section),
 * across projects, OLDEST first: the agent that has been waiting longest is the one to answer next.
 *
 * Membership is exactly the status-mode sidebar's (`buildStatusList` over the non-closed projects,
 * the same filter `SessionsSidebar` applies), so the command never disagrees with the list the user
 * can see. Order is a re-sort of a COPY: the sidebar's own section stays newest-first.
 *  - key: `statusUpdatedAt` ascending (the transition clock); an absent stamp sorts last, then
 *    project store order, then title, then id — a deterministic order so the cycle is stable.
 *  - a row whose project `nodeTravel` reports `blocked` (unreadable `.nodeterm` folder) is dropped:
 *    `travelToNode` silently refuses it, and leaving it in would stall the cycle on a dead stop.
 */
export function needsYouQueue(
  projects: readonly NeedsYouProject[],
  liveActiveNodes: SessionNodeInput[] | null,
  activeProjectId: string,
  statusById: Record<string, AgentNodeStatus>
): string[] {
  const open = projects.filter((p) => !p.closed)
  const pidx = new Map(open.map((p, i) => [p.id, i]))
  const attention =
    buildStatusList(open, liveActiveNodes, activeProjectId, statusById, '').find(
      (s) => s.kind === 'attention'
    )?.rows ?? []
  return attention
    .filter((r) => nodeTravel(projects, activeProjectId, r.id).kind !== 'blocked')
    .sort((a, b) => {
      const at = a.statusUpdatedAt ?? Number.POSITIVE_INFINITY
      const bt = b.statusUpdatedAt ?? Number.POSITIVE_INFINITY
      if (at !== bt) return at < bt ? -1 : 1
      const ap = pidx.get(a.projectId ?? '') ?? Number.MAX_SAFE_INTEGER
      const bp = pidx.get(b.projectId ?? '') ?? Number.MAX_SAFE_INTEGER
      if (ap !== bp) return ap - bp
      const byTitle = a.title.toLowerCase().localeCompare(b.title.toLowerCase())
      if (byTitle !== 0) return byTitle
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
    })
    .map((r) => r.id)
}

/**
 * The next stop in the cycle.
 *  - `cursor` is the node this command last travelled to (Canvas keeps it in memory only — a ref,
 *    never persisted). The pick is the entry AFTER it, wrapping to the oldest.
 *  - A cursor no longer in the queue (that agent was answered) restarts at the oldest: the queue
 *    is re-read on every press, so "oldest still waiting" is the right next stop.
 *  - `currentNodeId` (the terminal the user is focused in) is skipped when anything else waits:
 *    the first press from inside the oldest waiting agent must not be a visible no-op.
 *  - `null` when nothing needs the user.
 */
export function nextNeedingYou(
  queue: readonly string[],
  cursor: string | null,
  currentNodeId: string | null
): string | null {
  if (queue.length === 0) return null
  const at = cursor === null ? -1 : queue.indexOf(cursor)
  let next = (at + 1) % queue.length
  if (queue[next] === currentNodeId && queue.length > 1) next = (next + 1) % queue.length
  return queue[next]
}
