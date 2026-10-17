// Pure, bounded models shared by the SVG and WebGL renderers.
export const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, Number.isFinite(value) ? value : min))

export type HanoiMove = { disk: number; from: number; to: number; stack: string[] }
export type HanoiFrame = { pegs: number[][]; move: HanoiMove | null }

export const createHanoiFrames = (requestedSize: number): HanoiFrame[] => {
  const size = Math.round(clamp(requestedSize, 3, 7))
  const pegs = [Array.from({ length: size }, (_, index) => size - index), [], []]
  const frames: HanoiFrame[] = [{ pegs: pegs.map((peg) => [...peg]), move: null }]
  const move = (count: number, from: number, to: number, spare: number, parents: string[]) => {
    if (count === 0) return
    const stack = [...parents, `hanoi(${count}, ${'ABC'[from]}, ${'ABC'[to]}, ${'ABC'[spare]})`]
    move(count - 1, from, spare, to, stack)
    const disk = pegs[from].pop()!
    pegs[to].push(disk)
    frames.push({ pegs: pegs.map((peg) => [...peg]), move: { disk, from, to, stack } })
    move(count - 1, spare, to, from, stack)
  }
  move(size, 0, 2, 1, [])
  return frames
}

export type SortItem = { value: number; id: number }
export type SortFrame = {
  items: SortItem[]
  active: number[]
  sortedFrom: number
  comparisons: number
  swaps: number
  action: 'initial' | 'compare' | 'swap' | 'complete'
  caption: string
}

export const createBubbleSortFrames = (input: number[]): SortFrame[] => {
  const items = input
    .slice(0, 16)
    .map((value, id) => ({ value: Math.round(clamp(value, 1, 99)), id }))
  let comparisons = 0
  let swaps = 0
  const frames: SortFrame[] = []
  const add = (
    action: SortFrame['action'],
    active: number[],
    sortedFrom: number,
    caption: string,
  ) => {
    frames.push({
      items: items.map((item) => ({ ...item })),
      active,
      sortedFrom,
      comparisons,
      swaps,
      action,
      caption,
    })
  }
  add(
    'initial',
    [],
    items.length,
    'Compare neighbors, swapping only when the left value is larger.',
  )
  for (let end = items.length - 1; end > 0; end -= 1) {
    let changed = false
    for (let index = 0; index < end; index += 1) {
      comparisons += 1
      add(
        'compare',
        [index, index + 1],
        end + 1,
        `Compare ${items[index].value} and ${items[index + 1].value}.`,
      )
      if (items[index].value > items[index + 1].value) {
        const left = items[index]
        items[index] = items[index + 1]
        items[index + 1] = left
        swaps += 1
        changed = true
        add(
          'swap',
          [index, index + 1],
          end + 1,
          'Swap these neighbors so the smaller value comes first.',
        )
      }
    }
    if (!changed) break
  }
  add('complete', [], 0, 'Sorted. Equal values retain their original relative order.')
  return frames
}

export const fibonacciSequence = (requestedCount: number) => {
  const count = Math.round(clamp(requestedCount, 2, 20))
  const sequence = [0, 1]
  while (sequence.length < count) sequence.push(sequence.at(-1)! + sequence.at(-2)!)
  return sequence
}

export type SimulationKind = 'pendulum' | 'orbit' | 'wave'
export type SimulationParameters = {
  length: number
  gravity: number
  amplitude: number
  frequency: number
  wavelength: number
  radius: number
  mu: number
}
export const defaultSimulationParameters: SimulationParameters = {
  length: 2,
  gravity: 9.81,
  amplitude: 8,
  frequency: 0.5,
  wavelength: 3,
  radius: 2,
  mu: 8,
}

export const normalizeSimulationParameters = (
  parameters: Partial<SimulationParameters>,
  kind: SimulationKind,
): SimulationParameters => ({
  length: clamp(parameters.length ?? 2, 0.5, 3),
  gravity: clamp(parameters.gravity ?? 9.81, 1, 20),
  amplitude: clamp(
    parameters.amplitude ?? (kind === 'wave' ? 0.6 : 8),
    kind === 'wave' ? 0.1 : 1,
    kind === 'wave' ? 1.5 : 12,
  ),
  frequency: clamp(parameters.frequency ?? 0.5, 0.2, 2),
  wavelength: clamp(parameters.wavelength ?? 3, 1, 5),
  radius: clamp(parameters.radius ?? 2, 1, 4),
  mu: clamp(parameters.mu ?? 8, 1, 20),
})

export const pendulumAt = (time: number, parameters: SimulationParameters) => {
  const { length, gravity, amplitude } = normalizeSimulationParameters(parameters, 'pendulum')
  const omega = Math.sqrt(gravity / length)
  const initialAngle = (amplitude * Math.PI) / 180
  const angle = initialAngle * Math.cos(omega * time)
  const angularVelocity = -initialAngle * omega * Math.sin(omega * time)
  return {
    angle,
    angularVelocity,
    x: length * Math.sin(angle),
    y: -length * Math.cos(angle),
    period: (2 * Math.PI) / omega,
  }
}

export const orbitAt = (time: number, parameters: SimulationParameters) => {
  const { radius, mu } = normalizeSimulationParameters(parameters, 'orbit')
  const omega = Math.sqrt(mu / radius ** 3)
  return {
    x: radius * Math.cos(omega * time),
    z: radius * Math.sin(omega * time),
    speed: Math.sqrt(mu / radius),
    period: (2 * Math.PI) / omega,
  }
}

export const waveAt = (x: number, time: number, parameters: SimulationParameters) => {
  const { amplitude, frequency, wavelength } = normalizeSimulationParameters(parameters, 'wave')
  return amplitude * Math.sin(2 * Math.PI * (x / wavelength - frequency * time))
}

export const simulationSources = {
  pendulum: {
    label: 'MIT: small-angle pendulum model',
    url: 'https://ocw.mit.edu/courses/8-01sc-classical-mechanics-fall-2016/mit8_01scs22_chapter24.pdf',
  },
  orbit: {
    label: 'OpenStax: circular orbits',
    url: 'https://openstax.org/books/university-physics-volume-1/pages/13-4-satellite-orbits-and-energy',
  },
  wave: {
    label: 'OpenStax: mathematics of waves',
    url: 'https://openstax.org/books/university-physics-volume-1/pages/16-2-mathematics-of-waves',
  },
}
