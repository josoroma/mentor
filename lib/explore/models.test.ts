import { describe, expect, it } from 'vitest'
import {
  createHanoiFrames,
  createBubbleSortFrames,
  fibonacciSequence,
  normalizeSimulationParameters,
  orbitAt,
  pendulumAt,
  waveAt,
} from '@/lib/explore/models'

describe('Explore executable models', () => {
  it.each([3, 4, 5, 6, 7])(
    'solves %i-disk Hanoi optimally with legal moves and immutable snapshots',
    (size) => {
      const frames = createHanoiFrames(size)
      expect(frames).toHaveLength(2 ** size)
      expect(frames[0].pegs).toEqual([Array.from({ length: size }, (_, i) => size - i), [], []])
      expect(frames.at(-1)!.pegs).toEqual([
        [],
        [],
        Array.from({ length: size }, (_, i) => size - i),
      ])
      for (let index = 1; index < frames.length; index += 1) {
        const previous = frames[index - 1]
        const current = frames[index]
        const move = current.move!
        expect(previous.pegs[move.from].at(-1)).toBe(move.disk)
        expect(previous.pegs[move.to].at(-1) ?? Infinity).toBeGreaterThan(move.disk)
        expect(current.pegs.flat().sort((a, b) => a - b)).toEqual(
          Array.from({ length: size }, (_, i) => i + 1),
        )
        for (const peg of current.pegs) expect(peg).toEqual([...peg].sort((a, b) => b - a))
        expect(move.stack.at(-1)).toContain(`hanoi(${move.disk},`)
      }
    },
  )

  it('bounds Hanoi work and reproduces identical reverse-seek snapshots', () => {
    expect(createHanoiFrames(100)).toHaveLength(128)
    expect(createHanoiFrames(-2)).toHaveLength(8)
    const first = createHanoiFrames(4)
    expect(createHanoiFrames(4)[8]).toEqual(first[8])
    expect(first[0].pegs[0]).toHaveLength(4)
  })

  it.each([[5, 2, 2, 9, 1], [1, 2, 3], [9, 8, 7, 6], []])(
    'bubble sorts %j without mutating input or losing identities',
    (...values) => {
      const original = [...values]
      const frames = createBubbleSortFrames(values)
      const result = frames.at(-1)!
      expect(result.items.map((item) => item.value)).toEqual([...values].sort((a, b) => a - b))
      expect(values).toEqual(original)
      expect(frames[0].items.map((item) => item.value)).toEqual(original)
      const equalTwos = result.items.filter((item) => item.value === 2)
      expect(equalTwos.map((item) => item.id)).toEqual(
        equalTwos.map((item) => item.id).sort((a, b) => a - b),
      )
      expect(createBubbleSortFrames(values)).toEqual(frames)
    },
  )

  it('records exact bubble comparison and swap counts', () => {
    const frames = createBubbleSortFrames([3, 2, 1])
    expect(frames.at(-1)).toMatchObject({ comparisons: 3, swaps: 3, action: 'complete' })
    expect(createBubbleSortFrames([1, 2, 3, 4]).at(-1)).toMatchObject({ comparisons: 3, swaps: 0 })
    expect(frames.filter((frame) => frame.action === 'compare')).toHaveLength(3)
    expect(frames.filter((frame) => frame.action === 'swap')).toHaveLength(3)
  })

  it('computes the mathematical Fibonacci sequence including both initial ones', () => {
    expect(fibonacciSequence(12)).toEqual([0, 1, 1, 2, 3, 5, 8, 13, 21, 34, 55, 89])
  })

  it('returns the pendulum to its release position after a period, preserving linearized energy', () => {
    const parameters = normalizeSimulationParameters(
      { length: 1, gravity: 9.81, amplitude: 8 },
      'pendulum',
    )
    const start = pendulumAt(0, parameters)
    const quarter = pendulumAt(start.period / 4, parameters)
    const end = pendulumAt(start.period, parameters)
    expect(start.period).toBeCloseTo(2.00606668)
    expect(quarter.angle).toBeCloseTo(0)
    expect(end.x).toBeCloseTo(start.x)
    expect(Math.hypot(end.x, end.y)).toBeCloseTo(parameters.length)
    const energy = (time: number) => {
      const snapshot = pendulumAt(time, parameters)
      return (
        (parameters.length ** 2 * snapshot.angularVelocity ** 2) / 2 +
        (parameters.gravity * parameters.length * snapshot.angle ** 2) / 2
      )
    }
    expect(energy(0)).toBeCloseTo(energy(start.period / 4))
    expect(pendulumAt(0, { ...parameters, length: 4 }).period).toBeCloseTo(
      2 * Math.PI * Math.sqrt(3 / 9.81),
    )
  })

  it('keeps a circular orbit at its radius with the expected period and speed', () => {
    const parameters = normalizeSimulationParameters({ radius: 2, mu: 8 }, 'orbit')
    const start = orbitAt(0, parameters)
    expect(start.period).toBeCloseTo(2 * Math.PI)
    expect(start.speed).toBeCloseTo(2)
    for (const time of [0, 0.3, 1, 12])
      expect(Math.hypot(orbitAt(time, parameters).x, orbitAt(time, parameters).z)).toBeCloseTo(2)
    expect(orbitAt(start.period, parameters).x).toBeCloseTo(start.x)
  })

  it('advances a traveling wave one wavelength per period', () => {
    const parameters = normalizeSimulationParameters({}, 'wave')
    expect(waveAt(0, 0, parameters)).toBeCloseTo(0)
    expect(waveAt(parameters.wavelength / 4, 0, parameters)).toBeCloseTo(parameters.amplitude)
    expect(waveAt(0.2, 0, parameters)).toBeCloseTo(
      waveAt(0.2, 1 / parameters.frequency, parameters),
    )
    expect(waveAt(0.2, 0, parameters)).toBeCloseTo(
      waveAt(0.2 + parameters.wavelength / 4, 1 / parameters.frequency / 4, parameters),
    )
  })
})
