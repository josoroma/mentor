import { calculateRms } from '@/lib/audio/audio-utils'

const processorSource = `
class MentorCapture extends AudioWorkletProcessor {
  constructor() {
    super()
    this.samples = new Float32Array(2048)
    this.offset = 0
  }
  process(inputs) {
    const input = inputs[0]?.[0]
    if (input) {
      for (let i = 0; i < input.length; i++) {
        this.samples[this.offset++] = input[i]
        if (this.offset === this.samples.length) {
          this.port.postMessage(this.samples, [this.samples.buffer])
          this.samples = new Float32Array(2048)
          this.offset = 0
        }
      }
    }
    return true
  }
}
registerProcessor('mentor-capture', MentorCapture)
`

export type Microphone = {
  context: AudioContext
  sampleRate: number
  setMuted: (muted: boolean) => void
  close: () => Promise<void>
}

const resumeAudio = async (context: AudioContext) => {
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      context.resume(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () =>
            reject(
              new Error(
                'Your browser paused audio playback. Press Try again to enable the microphone and coach voice.',
              ),
            ),
          4000,
        )
      }),
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

export const openMicrophone = async ({
  onSamples,
  onEnded,
}: {
  onSamples: (samples: Float32Array) => void
  onEnded: () => void
}): Promise<Microphone> => {
  if (!window.isSecureContext) {
    throw new Error(
      'Microphone access requires HTTPS or localhost. Open mentor on a secure address.',
    )
  }
  if (!navigator.mediaDevices?.getUserMedia || !window.AudioContext) {
    throw new Error(
      'This browser does not support microphone recording. Try a recent version of Chrome, Edge, Safari, or Firefox.',
    )
  }

  // Created during the Start click so playback is unlocked by the same user gesture.
  const context = new AudioContext({ latencyHint: 'interactive' })
  let stream: MediaStream | undefined
  let capture: AudioWorkletNode | ScriptProcessorNode | undefined
  let source: MediaStreamAudioSourceNode | undefined
  let closed = false
  const close = async () => {
    if (closed) return
    closed = true
    if (typeof AudioWorkletNode !== 'undefined' && capture instanceof AudioWorkletNode)
      capture.port.close()
    capture?.disconnect()
    source?.disconnect()
    stream?.getTracks().forEach((track) => {
      track.onended = null
      track.stop()
    })
    if (context.state !== 'closed') await context.close()
  }

  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
      },
    })
    await resumeAudio(context)
    stream.getAudioTracks().forEach((track) => {
      track.onended = onEnded
    })
    source = context.createMediaStreamSource(stream)
    if (context.audioWorklet && typeof AudioWorkletNode !== 'undefined') {
      const moduleUrl = URL.createObjectURL(
        new Blob([processorSource], { type: 'text/javascript' }),
      )
      try {
        await context.audioWorklet.addModule(moduleUrl)
        const worklet = new AudioWorkletNode(context, 'mentor-capture')
        worklet.port.onmessage = (event: MessageEvent<Float32Array>) => {
          if (!closed) onSamples(event.data)
        }
        capture = worklet
      } finally {
        URL.revokeObjectURL(moduleUrl)
      }
    } else {
      // Older WebKit can capture PCM without relying on a cloud speech API.
      const processor = context.createScriptProcessor(2048, 1, 1)
      processor.onaudioprocess = (event) => {
        if (!closed) onSamples(event.inputBuffer.getChannelData(0).slice())
      }
      capture = processor
    }
    const silence = context.createGain()
    silence.gain.value = 0
    source.connect(capture)
    capture.connect(silence)
    silence.connect(context.destination)
    return {
      context,
      sampleRate: context.sampleRate,
      setMuted: (muted) =>
        stream?.getAudioTracks().forEach((track) => {
          track.enabled = !muted
        }),
      close,
    }
  } catch (error) {
    await close()
    if (error instanceof DOMException && error.name === 'NotAllowedError') {
      throw new Error(
        'Microphone permission was denied. Allow microphone access for this site in your browser, then try again.',
      )
    }
    if (error instanceof DOMException && error.name === 'NotFoundError') {
      throw new Error('No microphone was found. Connect a microphone and try again.')
    }
    if (error instanceof DOMException && error.name === 'NotReadableError') {
      throw new Error(
        'Your microphone is busy or unavailable. Close other apps using it and try again.',
      )
    }
    throw error
  }
}

export type SpeechPlayer = {
  play: (audio: ArrayBuffer, signal: AbortSignal) => Promise<void>
  stop: () => void
}

export const createSpeechPlayer = (
  context: AudioContext,
  onLevel: (level: number) => void,
  onStart: () => void,
): SpeechPlayer => {
  let currentSource: AudioBufferSourceNode | undefined
  let cancelCurrent: (() => void) | undefined
  const stop = () => {
    cancelCurrent?.()
    onLevel(0)
  }
  const play = async (audio: ArrayBuffer, signal: AbortSignal) => {
    if (signal.aborted || (context.state as string) === 'closed') return
    const buffer = await context.decodeAudioData(audio)
    if (signal.aborted || context.state === 'closed') return
    if (context.state === 'suspended') await resumeAudio(context)
    if (signal.aborted || (context.state as string) === 'closed') return
    await new Promise<void>((resolve) => {
      const source = context.createBufferSource()
      currentSource = source
      source.buffer = buffer
      const analyser = context.createAnalyser()
      analyser.fftSize = 512
      source.connect(analyser)
      analyser.connect(context.destination)
      const samples = new Float32Array(analyser.fftSize)
      let frame = 0
      let finished = false
      const finish = () => {
        if (finished) return
        finished = true
        cancelAnimationFrame(frame)
        signal.removeEventListener('abort', cancel)
        source.onended = null
        source.disconnect()
        analyser.disconnect()
        if (currentSource === source) {
          currentSource = undefined
          cancelCurrent = undefined
        }
        onLevel(0)
        resolve()
      }
      const cancel = () => {
        try {
          source.stop()
        } catch {
          /* Already stopped or not started. */
        }
        finish()
      }
      const measure = () => {
        analyser.getFloatTimeDomainData(samples)
        onLevel(calculateRms(samples))
        frame = requestAnimationFrame(measure)
      }
      cancelCurrent = cancel
      source.onended = finish
      signal.addEventListener('abort', cancel, { once: true })
      source.start()
      onStart()
      measure()
    })
  }
  return { play, stop }
}
