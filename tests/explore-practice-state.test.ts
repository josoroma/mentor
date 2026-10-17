import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PATCH } from '@/app/api/explore/artifacts/[id]/state/route'
import { ExploreBackupSchema, ExploreLearningStateSchema } from '@/lib/explore/schema'
import { createExploreBackupFixture } from '@/tests/fixtures/explore'

const mocks = vi.hoisted(() => ({
  requireIdentity: vi.fn(),
  saveState: vi.fn(),
}))

vi.mock('@/lib/explore/server', () => ({
  requireExploreIdentity: mocks.requireIdentity,
  saveExploreArtifactState: mocks.saveState,
}))

const practiceState = () =>
  Object.fromEntries(
    Array.from({ length: 40 }, (_, index) => [
      [`examplePractice${index}`, '文'.repeat(2000)],
      [`examplePracticeImproved${index}`, '語'.repeat(2000)],
    ]).flat(),
  )

describe('Explore practice state contracts', () => {
  it('preserves 40 originals and 40 corrections through the backup contract', () => {
    const backup = createExploreBackupFixture()
    backup.artifacts[0].state = practiceState()
    expect(Object.keys(backup.artifacts[0].state)).toHaveLength(80)
    expect(ExploreBackupSchema.parse(JSON.parse(JSON.stringify(backup)))).toEqual(backup)
  })

  it('allows 120 bounded fields and rejects additional fields', () => {
    const state = Object.fromEntries(
      Array.from({ length: 120 }, (_, index) => [`field${index}`, 0]),
    )
    expect(ExploreLearningStateSchema.parse(state)).toEqual(state)
    expect(ExploreLearningStateSchema.safeParse({ ...state, extra: true }).success).toBe(false)
  })

  it.each([
    { text: 'x'.repeat(2001) },
    { text: '😀'.repeat(2001) },
    { ['x'.repeat(81)]: '' },
    { values: ['x'.repeat(501)] },
    { values: Array.from({ length: 101 }, () => 0) },
    { values: [1, 'two'] },
    { nested: { text: 'nested' } },
    { text: null },
    { '': true },
  ])('continues rejecting out-of-bounds state case %#', (state) => {
    expect(ExploreLearningStateSchema.safeParse(state).success).toBe(false)
  })
})

describe('Explore practice state HTTP boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.requireIdentity.mockResolvedValue({ userId: crypto.randomUUID() })
  })

  const patch = (state: unknown) => {
    const artifactId = crypto.randomUUID()
    return PATCH(
      new Request(`http://127.0.0.1:3000/api/explore/artifacts/${artifactId}/state`, {
        method: 'PATCH',
        body: JSON.stringify({ state, expectedRevision: 1 }),
      }),
      { params: Promise.resolve({ id: artifactId }) },
    )
  }

  it('saves all 80 maximum-length multibyte fields, exceeding the usual 128 KiB limit', async () => {
    const state = practiceState()
    const bytes = new TextEncoder().encode(JSON.stringify(state)).byteLength
    expect(bytes).toBeGreaterThan(128 * 1024)
    expect(bytes).toBeLessThan(1024 * 1024)
    mocks.saveState.mockResolvedValue({ ...createExploreBackupFixture().artifacts[0], state })
    const response = await patch(state)
    expect(response.status).toBe(200)
    expect((await response.json()).state).toEqual(state)
    expect(mocks.saveState.mock.calls[0][2]).toEqual(state)
  })

  it('rejects 123 fields before persistence', async () => {
    const state = Object.fromEntries(Array.from({ length: 123 }, (_, index) => [`key${index}`, 0]))
    expect((await patch(state)).status).toBe(400)
    expect(mocks.saveState).not.toHaveBeenCalled()
  })

  it('bounds the complete body at 1 MiB even when each state field is valid', async () => {
    const state = Object.fromEntries(
      Array.from({ length: 10 }, (_, index) => [
        `list${index}`,
        Array.from({ length: 100 }, () => '文'.repeat(500)),
      ]),
    )
    expect(ExploreLearningStateSchema.safeParse(state).success).toBe(true)
    expect((await patch(state)).status).toBe(413)
    expect(mocks.saveState).not.toHaveBeenCalled()
  })
})
