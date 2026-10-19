import { Suspense, lazy, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { NodeResizer, useReactFlow, useStore, type NodeProps } from '@xyflow/react'
import { Tooltip } from '../components/Tooltip'
import { IconCheck, IconClose, IconCopy, IconPlay } from '../components/icons'
import { NODE_MIN_SIZES } from '../lib/nodeSizing'
import type { CanvasNode } from '../state/workspace'
import { useAppTheme } from '../state/useAppTheme'
import { useProjects } from '../state/projects'
import { markWorkspaceDirty } from '../state/workspaceDirty'
import { useSession } from '../session/session'
import { MaximizeButton, useNodeMaximize } from './MaximizeButton'

// Excalidraw (~1.7 MB of JS + CSS) loads the first time a board is opened for editing, never at
// startup and never for a board that is only being looked at. The asset path must be set before
// the chunk evaluates: Excalidraw builds its font list once and caches it.
const WhiteboardEditor = lazy(async () => {
  ;(window as unknown as { EXCALIDRAW_ASSET_PATH: string }).EXCALIDRAW_ASSET_PATH = new URL(
    'excalidraw-assets/',
    window.location.href
  ).href
  return import('../whiteboard/WhiteboardEditor')
})

/** The canvas transform as a primitive key: re-measure the overlay whenever it pans or zooms. */
const transformKey = (s: { transform: [number, number, number] }): string => s.transform.join(',')

interface Box {
  left: number
  top: number
  width: number
  height: number
}

/** Where the live editor goes: the canvas area (`clip`, relative to `.canvas-root`) and the
 *  node's body inside it (`board`, relative to the clip). */
interface Geometry {
  root: HTMLElement
  clip: Box
  board: Box
}

const pngDataUrl = (base64: string): string => `data:image/png;base64,${base64}`

/**
 * A whiteboard: an infinite Excalidraw canvas inside a canvas node.
 *
 * At rest the body shows a picture of the board. Editing does NOT happen inside the node: React
 * Flow scales every node with `transform: scale(zoom)`, and Excalidraw sizes its canvas and maps
 * the pointer from `getBoundingClientRect()`, so inside a scaled node it draws off the pointer and
 * goes soft. Instead one live editor is portaled into `.canvas-root` — OUTSIDE `.flow-wrap`, whose
 * capture-phase wheel listener always zooms the canvas on ⌘-wheel / pinch — and laid exactly over
 * the node's on-screen box, clipped to the canvas area and stacked under the sidebar and Dock. It
 * follows the box as the canvas pans or zooms and the node moves, resizes or maximizes.
 *
 * The drawing lives in a side file the core addresses by (project, node id) — core/whiteboards.ts.
 * Node data carries only `whiteboardSource` (a copy's original, by id) and `boardRev` (bumped once
 * per editing session that changed the board), so strokes never reach the workspace save, canvas
 * undo or team sync.
 */
export function WhiteboardNode({ id, data, selected, positionAbsoluteX, positionAbsoluteY, width, height }: NodeProps<CanvasNode>) {
  const { updateNodeData, deleteElements } = useReactFlow()
  const { api } = useSession()
  const theme = useAppTheme()
  const setMaximized = useNodeMaximize(id)
  // A node renders only inside its own project, and a project switch unmounts it — after the
  // active id has already moved on. Capture the owner once so a flush on the way out still lands
  // in THIS project's folder.
  const projectIdRef = useRef(useProjects.getState().activeProjectId)
  const dataRef = useRef(data)
  dataRef.current = data

  const frameRef = useRef<HTMLDivElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const overlayRef = useRef<HTMLDivElement>(null)
  const [mode, setMode] = useState<null | 'edit' | 'present'>(null)
  const [geom, setGeom] = useState<Geometry | null>(null)
  const [thumb, setThumb] = useState<string>()
  const sceneRef = useRef<string | undefined>(undefined)
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'unreadable'>('loading')
  const [saveFailed, setSaveFailed] = useState(false)
  const [copied, setCopied] = useState(false)
  const maximizedByPresentRef = useRef(false)
  const viewKey = useStore(transformKey)
  const canvasZoom = useStore((s) => s.transform[2])

  // Load the board (and again when a copy saves its own file, or a session elsewhere bumps the rev).
  useEffect(() => {
    let live = true
    // Through a promise chain so a session api without the channel at all (a relay host on an older
    // build answers with no `readWhiteboard`) lands in the catch below instead of throwing in render.
    Promise.resolve()
      // Picture only: the scene (megabytes once screenshots are pasted in) is fetched on open.
      .then(() => api.files.readWhiteboard(projectIdRef.current, id, data.whiteboardSource, false))
      .then((file) => {
        if (!live) return
        setThumb(file?.thumbnailBase64 ? pngDataUrl(file.thumbnailBase64) : undefined)
        setLoadState('ready')
      })
      .catch(() => {
        // A relay host on an older build has no such channel, or the read failed outright. Not
        // "empty": opening an editor here and saving would overwrite a board we could not read.
        if (live) setLoadState('unreadable')
      })
    return () => {
      live = false
    }
  }, [api, id, data.whiteboardSource, data.boardRev])

  const measure = useCallback(() => {
    const body = bodyRef.current
    const wrap = body?.closest<HTMLElement>('.flow-wrap')
    const root = body?.closest<HTMLElement>('.canvas-root')
    if (!body || !wrap || !root) return
    const r = root.getBoundingClientRect()
    const w = wrap.getBoundingClientRect()
    const b = body.getBoundingClientRect()
    setGeom({
      root,
      clip: { left: w.left - r.left, top: w.top - r.top, width: w.width, height: w.height },
      board: { left: b.left - w.left, top: b.top - w.top, width: b.width, height: b.height }
    })
  }, [])

  // Follow the node's on-screen box while editing: pan/zoom (viewKey), drag (position), resize.
  useLayoutEffect(() => {
    if (mode) measure()
  }, [mode, measure, viewKey, positionAbsoluteX, positionAbsoluteY, width, height])
  useEffect(() => {
    if (!mode || !bodyRef.current) return
    const ro = new ResizeObserver(measure)
    ro.observe(bodyRef.current)
    window.addEventListener('resize', measure)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [mode, measure])

  const save = useCallback(
    async (scene: string, thumbnailBase64?: string): Promise<boolean> => {
      const path = await Promise.resolve()
        .then(() => api.files.saveWhiteboard(projectIdRef.current, id, scene, thumbnailBase64))
        .catch(() => null)
      if (!path) {
        setSaveFailed(true)
        return false
      }
      setSaveFailed(false)
      sceneRef.current = scene
      if (thumbnailBase64 !== undefined) setThumb(thumbnailBase64 ? pngDataUrl(thumbnailBase64) : undefined)
      // A copy has its own file now; it stops reading the original's.
      if (dataRef.current.whiteboardSource) {
        updateNodeData(id, { whiteboardSource: undefined })
        markWorkspaceDirty()
      }
      return true
    },
    [api, id, updateNodeData]
  )

  const openingRef = useRef(false)
  const start = useCallback(
    async (next: 'edit' | 'present') => {
      if (loadState !== 'ready' || openingRef.current) return
      openingRef.current = true
      try {
        const file = await Promise.resolve()
          .then(() => api.files.readWhiteboard(projectIdRef.current, id, dataRef.current.whiteboardSource))
          .catch(() => undefined)
        if (file === undefined) return setLoadState('unreadable')
        if (file?.scene !== undefined) {
          try {
            JSON.parse(file.scene)
          } catch {
            // Corrupt, or written by something else: never open an editor over it, or its first
            // autosave would overwrite the board.
            return setLoadState('unreadable')
          }
        }
        sceneRef.current = file?.scene
        if (next === 'present' && !dataRef.current.premaxRect) {
          setMaximized(false)
          maximizedByPresentRef.current = true
        }
        setMode(next)
      } finally {
        openingRef.current = false
      }
    },
    [api, id, loadState, setMaximized]
  )

  // A new board opens straight into drawing — the reason you made one.
  useEffect(() => {
    if (data.autoEdit && loadState === 'ready') {
      updateNodeData(id, { autoEdit: undefined })
      void start('edit')
    }
  }, [data.autoEdit, loadState, id, updateNodeData, start])

  const end = useCallback(
    (changed: boolean) => {
      if (maximizedByPresentRef.current && dataRef.current.premaxRect) setMaximized(true)
      maximizedByPresentRef.current = false
      setMode(null)
      // Read again on the next open; a board at rest keeps only its picture.
      sceneRef.current = undefined
      if (changed) {
        // Once per session, never per stroke: what a linked agent and the save cadence key on.
        updateNodeData(id, { boardRev: Date.now() })
        markWorkspaceDirty()
      }
    },
    [id, setMaximized, updateNodeData]
  )

  const copyImage = useCallback(async () => {
    if (!thumb) return
    try {
      const blob = await (await fetch(thumb)).blob()
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // Clipboard refused (no focus / permission): nothing was copied, the icon simply stays put.
    }
  }, [thumb])

  return (
    <>
      <div
        ref={frameRef}
        className={`whiteboard-node${selected ? ' selected' : ''}${mode ? ' editing' : ''}`}
        style={{ borderColor: data.color }}
      >
        <NodeResizer isVisible={selected} color={data.color} lineClassName="nt-resize-ghost" handleClassName="nt-resize-ghost" />
        <div className="whiteboard-node__header" style={{ background: `${data.color}33` }}>
          <span className="term-node__color" style={{ background: data.color }} />
          <input
            className="term-node__title nodrag"
            value={data.title}
            spellCheck={false}
            onChange={(e) => updateNodeData(id, { title: e.target.value })}
          />
          {saveFailed && (
            <span
              className="whiteboard-node__save-failed"
              role="status"
              title="The last change could not be written. The board stays open; it retries on the next change."
            >
              Not saved
            </span>
          )}
          <span className="term-node__spacer" />
          <Tooltip label={copied ? 'Copied' : 'Copy as image'}>
            <button
              className="term-node__maximize nodrag"
              aria-label="Copy whiteboard as image"
              disabled={!thumb}
              onClick={(e) => {
                e.stopPropagation()
                void copyImage()
              }}
            >
              {copied ? <IconCheck /> : <IconCopy />}
            </button>
          </Tooltip>
          <Tooltip label="Present — fill the canvas and hide the toolbars (Esc to finish)">
            <button
              className="term-node__maximize nodrag"
              aria-label="Present whiteboard"
              aria-pressed={mode === 'present'}
              onClick={(e) => {
                e.stopPropagation()
                if (mode === 'present') setMode('edit')
                else void start('present')
              }}
            >
              <IconPlay />
            </button>
          </Tooltip>
          <MaximizeButton id={id} maximized={!!data.premaxRect} />
          <Tooltip label="Close">
            <button className="term-node__close" aria-label="Close" onClick={() => deleteElements({ nodes: [{ id }] })}>
              <IconClose />
            </button>
          </Tooltip>
        </div>
        <div
          ref={bodyRef}
          className="whiteboard-node__body nodrag nowheel"
          onDoubleClick={() => void start('edit')}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void start('edit')
          }}
          tabIndex={0}
          role="button"
          aria-label="Open whiteboard for drawing"
        >
          {loadState === 'unreadable' ? (
            <span className="whiteboard-node__hint">This board could not be read here</span>
          ) : thumb ? (
            <img className="whiteboard-node__thumb" src={thumb} alt="" draggable={false} />
          ) : loadState === 'ready' ? (
            <span className="whiteboard-node__hint">Double-click to draw</span>
          ) : null}
        </div>
      </div>
      <NodeResizer
        minWidth={NODE_MIN_SIZES.whiteboard.width}
        minHeight={NODE_MIN_SIZES.whiteboard.height}
        isVisible={selected}
        color={data.color}
      />
      {mode &&
        geom &&
        createPortal(
          <div className="whiteboard-clip" style={geom.clip}>
            <div ref={overlayRef} className="whiteboard-overlay" data-nt-keyboard-owner="" style={geom.board}>
              <Suspense fallback={<div className="whiteboard-overlay__loading">Loading whiteboard…</div>}>
                <WhiteboardEditor
                  initialScene={sceneRef.current}
                  theme={theme}
                  canvasZoom={canvasZoom}
                  present={mode === 'present'}
                  geometryKey={`${geom.board.left},${geom.board.top},${geom.board.width},${geom.board.height},${geom.clip.left},${geom.clip.top}`}
                  overlayRef={overlayRef}
                  frameRef={frameRef}
                  onSave={save}
                  onExit={end}
                />
              </Suspense>
            </div>
          </div>,
          geom.root
        )}
    </>
  )
}
