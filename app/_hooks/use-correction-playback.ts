'use client'

import { useCallback, useLayoutEffect, useRef, useSyncExternalStore } from 'react'
import { createCorrectionPlaybackController } from '@/lib/audio/correction-playback'

export const useCorrectionPlayback = (
  text: string,
  disabled = false,
  onBeforePlay?: () => void | Promise<void>,
) => {
  const controllerRef = useRef<ReturnType<typeof createCorrectionPlaybackController> | null>(null)
  if (!controllerRef.current) controllerRef.current = createCorrectionPlaybackController()
  const controller = controllerRef.current
  const snapshot = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  )
  useLayoutEffect(() => {
    controller.stop()
    return () => controller.stop()
  }, [controller, text, disabled])
  const toggle = useCallback(() => {
    if (disabled || !text.trim()) return
    const status = controller.getSnapshot().status
    if (status === 'loading' || status === 'playing') controller.stop()
    else void controller.play(text, onBeforePlay)
  }, [controller, disabled, text, onBeforePlay])
  return { ...snapshot, toggle, stop: controller.stop }
}
