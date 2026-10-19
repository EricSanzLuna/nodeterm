import { describe, it, expect } from 'vitest'
import { needsYouQueue, nextNeedingYou, type NeedsYouProject } from './nextNeedingYou'
import type { AgentNodeStatus } from '../state/agentStatus'

const node = (id: string, title = id) => ({ id, kind: 'terminal' as const, title, color: '#888' })

const projects = (): NeedsYouProject[] => [
  { id: 'p1', name: 'Alpha', color: '#111', nodes: [node('a1'), node('a2'), node('a3')] },
  { id: 'p2', name: 'Beta', color: '#222', nodes: [node('b1'), node('b2')] },
  { id: 'p3', name: 'Gamma', color: '#333', nodes: [node('c1')] }
]

const st = (state: AgentNodeStatus['state'], at?: number, unread = false): AgentNodeStatus => ({
  unread,
  state,
  lastEventAt: at
})

describe('needsYouQueue', () => {
  it('lists waiting AND blocked agents across projects, oldest wait first', () => {
    const status: Record<string, AgentNodeStatus> = {
      a1: st('waiting', 300),
      a2: st('working', 50),
      b1: st('blocked', 100),
      b2: st('done', 10, true),
      c1: st('waiting', 200)
    }
    // Working, done and unread rows are not "needing you"; the active project is irrelevant to order.
    expect(needsYouQueue(projects(), null, 'p1', status)).toEqual(['b1', 'c1', 'a1'])
    expect(needsYouQueue(projects(), null, 'p3', status)).toEqual(['b1', 'c1', 'a1'])
  })

  it('breaks clock ties by project store order, then title, deterministically', () => {
    const ps = projects()
    ps[0].nodes = [node('a1', 'zeta'), node('a2', 'Alpha')]
    const status = { a1: st('waiting', 100), a2: st('waiting', 100), b1: st('waiting', 100) }
    expect(needsYouQueue(ps, null, 'p1', status)).toEqual(['a2', 'a1', 'b1'])
  })

  it('sorts a row with no clock last instead of first', () => {
    const status = { a1: st('waiting'), b1: st('waiting', 999) }
    expect(needsYouQueue(projects(), null, 'p1', status)).toEqual(['b1', 'a1'])
  })

  it('matches the sidebar: closed projects are out, an unavailable one cannot be travelled to', () => {
    const ps = projects()
    ps[1].closed = true
    ps[2].unavailable = true
    const status = { a1: st('waiting', 3), b1: st('waiting', 1), c1: st('waiting', 2) }
    expect(needsYouQueue(ps, null, 'p1', status)).toEqual(['a1'])
  })

  it('counts a live active-project node that is not committed to the store yet', () => {
    const live = [...projects()[0].nodes, node('fresh')]
    const status = { fresh: st('blocked', 5), b1: st('waiting', 9) }
    expect(needsYouQueue(projects(), live, 'p1', status)).toEqual(['fresh', 'b1'])
  })

  it('is empty when nothing needs the user', () => {
    expect(needsYouQueue(projects(), null, 'p1', { a1: st('working', 1) })).toEqual([])
  })
})

describe('nextNeedingYou', () => {
  const q = ['x', 'y', 'z']

  it('starts at the oldest, then walks the queue and wraps', () => {
    expect(nextNeedingYou(q, null, null)).toBe('x')
    expect(nextNeedingYou(q, 'x', null)).toBe('y')
    expect(nextNeedingYou(q, 'y', null)).toBe('z')
    expect(nextNeedingYou(q, 'z', null)).toBe('x')
  })

  it('restarts at the oldest still waiting when the last stop was answered', () => {
    expect(nextNeedingYou(['y', 'z'], 'x', null)).toBe('y')
  })

  it('skips the node the user is already in, unless it is the only one', () => {
    expect(nextNeedingYou(q, null, 'x')).toBe('y')
    expect(nextNeedingYou(q, 'y', 'z')).toBe('x')
    expect(nextNeedingYou(['x'], null, 'x')).toBe('x')
  })

  it('is null on an empty queue', () => {
    expect(nextNeedingYou([], 'x', 'x')).toBeNull()
  })
})
