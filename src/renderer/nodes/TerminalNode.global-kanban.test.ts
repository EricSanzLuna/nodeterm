import fs from 'fs'
import path from 'path'
import { describe, expect, it } from 'vitest'

const TERMINAL_SRC = fs.readFileSync(path.join(__dirname, 'TerminalNode.tsx'), 'utf8')

describe('TerminalNode global kanban sizing', () => {
  it('parks the canvas size vote while the global kanban overlay is open', () => {
    const start = TERMINAL_SRC.indexOf('const boardOpen = useViewMode(')
    const end = TERMINAL_SRC.indexOf('const boardOpenRef', start)
    const boardOpen = TERMINAL_SRC.slice(start, end)

    // The modal is a co-attached viewer. If the hidden canvas node keeps voting, the PTY uses its
    // smaller grid (usually 80 columns) instead of the visible modal's measured width.
    expect(boardOpen).toContain('s.globalKanban')
    expect(boardOpen).toContain('omniKanbanEnabled')
  })
})

describe('TerminalNode board render pause wiring', () => {
  // The same `boardOpen` (Omni included) also stops xterm DRAWING under the board (audit GT-6:
  // 36.5 % GPU board-open over streaming terminals vs 0.0 % over silent ones). The decision itself
  // is unit-tested in `terminal/board-render-pause.test.ts`; this pins that the node feeds it the
  // right inputs and re-syncs it on both things it reads.
  it('pauses on the board flag, except for the focus-mode node that sits above the board', () => {
    expect(TERMINAL_SRC).toContain('covered: () => boardOpenRef.current && focusedNodeId() !== id')
    expect(TERMINAL_SRC).toContain('onUncover: fullRepaint')
  })

  it('re-syncs after the board flag moves and when focus mode moves', () => {
    const effect = TERMINAL_SRC.slice(TERMINAL_SRC.indexOf('boardOpenRef.current = boardOpen'))
    const body = effect.slice(0, effect.indexOf('}, [boardOpen])'))
    // After the ref write, so the pause reads the new value.
    expect(body.indexOf('boardPauseRef.current?.sync()')).toBeGreaterThan(0)
    const focus = TERMINAL_SRC.slice(TERMINAL_SRC.indexOf('subscribeFocusedNode(() => {'))
    expect(focus.slice(0, focus.indexOf('[]'))).toContain('boardPauseRef.current?.sync()')
  })

  it('is removed by the run that installed it, before a park keeps the xterm', () => {
    expect(TERMINAL_SRC).toContain('boardPause?.dispose()')
  })

  it('never feeds the visibility verdict (budget, hibernation, offscreen teardown)', () => {
    const report = TERMINAL_SRC.slice(TERMINAL_SRC.indexOf('const reportVisible = (visible: boolean): void => {'))
    const body = report.slice(0, report.indexOf('visibilityReportRef.current = reportVisible'))
    expect(body).not.toContain('boardOpen')
    expect(body).not.toContain('boardPause')
  })
})
