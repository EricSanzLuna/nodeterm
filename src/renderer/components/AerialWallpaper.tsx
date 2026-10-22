import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { nextShuffleClip, normalizeWallpaper, parseAerialId } from '@shared/wallpaper'
import { CANVAS_COVERED_ATTR } from '../lib/canvasCovered'
import { useSettings } from '../state/settings'

const REDUCED_MOTION = '(prefers-reduced-motion: reduce)'
const motionQuery = (): MediaQueryList | null =>
  typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(REDUCED_MOTION) : null

function useReducedMotion(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const q = motionQuery()
      q?.addEventListener('change', onChange)
      return () => q?.removeEventListener('change', onChange)
    },
    () => motionQuery()?.matches ?? false
  )
}

/**
 * The moving half of an aerial wallpaper (`aerial:` / `aerial-shuffle:`): a muted `<video>` layer
 * right above the wallpaper's CSS background (which holds the aerial's thumbnail still) and below
 * everything else, so the glass and tint layers sit on it exactly as they sit on a still. Renders
 * nothing for any other wallpaper, before the first clip resolves, with no downloaded clip at all,
 * or after a load error — in those cases the thumbnail still shows, never black. Under Reduce
 * Motion the video is mounted but never played: its first frame is a full-resolution still, where
 * the thumbnail is a 214×130 PNG.
 *
 * The clips are nt-media: URLs core minted from its own manifest scan (`wallpaper.aerialClips`).
 * A single aerial loops; a shuffle asks core again when a clip ends (macOS downloads more over
 * time) and plays a random other one. Paused while the document is hidden, and the canvas's layer
 * also while a board covers the canvas — the board plays its own (`board`), and two 4K HEVC
 * decodes for one visible picture is pure waste.
 *
 * `board`: the kanban overlay's layer, fixed to the viewport so it lines up with the canvas's.
 */
export function AerialWallpaper({ board = false }: { board?: boolean }): React.JSX.Element | null {
  const w = normalizeWallpaper(useSettings((s) => s.settings.desktopWallpaper))
  const id = w.kind === 'preset' && parseAerialId(w.id) ? w.id : null
  const shuffle = !!id && parseAerialId(id)!.shuffle
  const reduced = useReducedMotion()
  const [clip, setClip] = useState<{ id: string; src: string } | null>(null)
  const ref = useRef<HTMLVideoElement>(null)

  useEffect(() => {
    if (!id) return
    let live = true
    window.nodeTerminal.wallpaper
      .aerialClips({ kind: 'preset', id })
      .then((clips) => {
        const src = nextShuffleClip(clips, null)
        if (live) setClip(src ? { id, src } : null)
      })
      .catch(() => live && setClip(null))
    return () => {
      live = false
    }
  }, [id])

  const src = clip?.id === id ? clip.src : null

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const root = document.documentElement
    const sync = (): void => {
      if (reduced || document.hidden || (!board && root.hasAttribute(CANVAS_COVERED_ATTR))) el.pause()
      else void el.play().catch(() => {})
    }
    sync()
    document.addEventListener('visibilitychange', sync)
    const covered = board ? null : new MutationObserver(sync)
    covered?.observe(root, { attributes: true, attributeFilter: [CANVAS_COVERED_ATTR] })
    return () => {
      document.removeEventListener('visibilitychange', sync)
      covered?.disconnect()
    }
  }, [src, board, reduced])

  if (!id || !src) return null

  const onEnded = (): void => {
    const playing = id
    void window.nodeTerminal.wallpaper
      .aerialClips({ kind: 'preset', id: playing })
      .catch(() => [] as string[])
      .then((clips) => {
        const next = nextShuffleClip(clips, src)
        if (next === src && ref.current) {
          ref.current.currentTime = 0
          void ref.current.play().catch(() => {})
        } else {
          setClip((c) => (c?.id === playing ? (next ? { id: playing, src: next } : null) : c))
        }
      })
  }

  return (
    <video
      ref={ref}
      key={src}
      src={src}
      className={board ? 'aerial-wallpaper aerial-wallpaper--board' : 'aerial-wallpaper'}
      aria-hidden
      tabIndex={-1}
      muted
      autoPlay={!reduced}
      preload="auto"
      playsInline
      loop={!shuffle}
      onEnded={shuffle ? onEnded : undefined}
      onError={() => setClip(null)}
    />
  )
}
