import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  HomeConversationController,
  createHomeConversationSnapshot,
  selectHomeConversationContext,
  type HomeConversationEntry,
} from '@/app/_home-conversation-controller'
import {
  HomeConversationRequestSchema,
  type HomeConversationRequest,
} from '@/lib/ai/home-conversation'

const response = (nextSpeaker: 'alex' | 'sam' = 'alex') => ({
  topic: 'A helpful handover',
  turns: [
    { speaker: nextSpeaker, text: 'We could start with a short guide.' },
    {
      speaker: nextSpeaker === 'alex' ? ('sam' as const) : ('alex' as const),
      text: 'An example could make each step clearer.',
    },
  ],
})
const setup = (
  request = vi.fn(async (body: HomeConversationRequest, _signal: AbortSignal) =>
    response(body.nextSpeaker),
  ),
) => {
  let snapshot = createHomeConversationSnapshot()
  const play = vi.fn(async () => {})
  const setMicrophone = vi.fn(async () => {})
  const pauseVoice = vi.fn()
  const cancelVoice = vi.fn()
  const prepare = vi.fn(async () => ({ personas: { alex: 'alex' as const, sam: 'sam' as const } }))
  const recentTopics: string[] = []
  const rememberTopic = vi.fn((topic: string) => {
    recentTopics.push(topic)
  })
  const controller = new HomeConversationController({
    profile: { roleId: 'deployed-ai-developer', level: 'B1' },
    selection: { path: 'professional', roleId: 'deployed-ai-developer' },
    prepare,
    play,
    setMicrophone,
    pauseVoice,
    cancelVoice,
    rememberTopic,
    recentTopics: () => recentTopics.slice(-8),
    request,
    onChange: (next) => {
      snapshot = next
    },
  })
  return {
    controller,
    request,
    play,
    setMicrophone,
    pauseVoice,
    cancelVoice,
    prepare,
    rememberTopic,
    snapshot: () => snapshot,
  }
}
const flush = async () => {
  for (let i = 0; i < 6; i++) await Promise.resolve()
}
const shown = (controller: HomeConversationController, count = 2) =>
  controller.onPlayback({
    startedTurnCount: count,
    activeSpeaker: count === 1 ? 'alex' : 'sam',
    activeTurnIndex: count - 1,
  })
beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
})

describe('ongoing homepage conversation', () => {
  it('continues past six AI turns without microphone consent or a synthetic user turn', async () => {
    const fixture = setup()
    await fixture.controller.startNew()
    expect(fixture.snapshot().turns).toEqual([])
    for (let batch = 0; batch < 6; batch++) {
      shown(fixture.controller)
      fixture.controller.onComplete()
      await vi.advanceTimersByTimeAsync(800)
    }
    expect(fixture.request).toHaveBeenCalledTimes(7)
    expect(fixture.snapshot().turns).toHaveLength(12)
    expect(fixture.snapshot().turns.every((turn) => turn.speaker !== 'user')).toBe(true)
    expect(fixture.setMicrophone).not.toHaveBeenCalled()
    expect(fixture.request.mock.calls[6][0].history).toHaveLength(12)
    fixture.controller.dispose()
  })

  it('moves to a related topic and continues in the same conversation with the same partners', async () => {
    const topics = [
      'A helpful handover',
      'A helpful handover',
      'Monitoring the deployed service',
      'Monitoring the deployed service',
      'A helpful handover',
    ]
    let generated = 0
    const request = vi.fn(async (body: HomeConversationRequest, _signal: AbortSignal) => ({
      ...response(body.nextSpeaker),
      topic: topics[generated++],
    }))
    const fixture = setup(request)
    await fixture.controller.startNew()
    const id = fixture.snapshot().id
    const personas = fixture.snapshot().personas
    const allShown: HomeConversationEntry[] = []

    for (let batch = 0; batch < topics.length; batch++) {
      shown(fixture.controller, 1)
      const firstShown = fixture.snapshot().turns.at(-1)!
      shown(fixture.controller)
      allShown.push(firstShown, fixture.snapshot().turns.at(-1)!)
      expect(fixture.snapshot()).toMatchObject({
        id,
        personas,
        topic: topics[batch],
        phase: 'playing',
        error: null,
        turns: allShown,
      })
      if (batch < topics.length - 1) {
        fixture.controller.onComplete()
        await vi.advanceTimersByTimeAsync(800)
        expect(request.mock.calls[batch + 1][0]).toMatchObject({
          roleId: 'deployed-ai-developer',
          selection: { path: 'professional', roleId: 'deployed-ai-developer' },
          topic: topics[batch],
          personas,
          history: allShown.map(({ id, speaker, text }) => ({ id, speaker, text })),
        })
      }
    }

    expect(fixture.rememberTopic.mock.calls.map(([topic]) => topic)).toEqual([
      'A helpful handover',
      'Monitoring the deployed service',
      'A helpful handover',
    ])
    expect(request.mock.calls[3][0].recentTopics).toEqual([
      'A helpful handover',
      'Monitoring the deployed service',
    ])
    expect(fixture.snapshot().turns).toHaveLength(10)
    expect(fixture.prepare).toHaveBeenCalledTimes(1)
    expect(fixture.cancelVoice).toHaveBeenCalledTimes(1)
    expect(fixture.pauseVoice).not.toHaveBeenCalled()
    expect(fixture.setMicrophone).not.toHaveBeenCalled()
    fixture.controller.dispose()
  })

  it('does not remember or adopt a topic transition interrupted before its first shown turn', async () => {
    let generated = 0
    const request = vi.fn(async (body: HomeConversationRequest, _signal: AbortSignal) => ({
      ...response(body.nextSpeaker),
      topic: generated++ === 1 ? 'An unheard deployment topic' : 'A helpful handover',
    }))
    const fixture = setup(request)
    await fixture.controller.startNew()
    expect(fixture.snapshot().topic).toBe('')
    expect(fixture.rememberTopic).not.toHaveBeenCalled()
    shown(fixture.controller)
    fixture.controller.onComplete()
    await vi.advanceTimersByTimeAsync(800)

    fixture.controller.onPlayback({
      startedTurnCount: 0,
      activeSpeaker: null,
      activeTurnIndex: null,
    })
    expect(fixture.snapshot().topic).toBe('A helpful handover')
    await fixture.controller.toggleMicrophone(true)
    fixture.controller.onTranscript('I would like to finish the handover first.')
    await flush()
    shown(fixture.controller)

    expect(request.mock.calls[2][0]).toMatchObject({
      topic: 'A helpful handover',
      recentTopics: ['A helpful handover'],
    })
    expect(fixture.rememberTopic.mock.calls).toEqual([['A helpful handover']])
    expect(fixture.snapshot().turns).toHaveLength(5)
    fixture.controller.dispose()
  })

  it('drops unheard queued AI speech and sends the real learner contribution to both partners', async () => {
    const fixture = setup()
    await fixture.controller.startNew()
    shown(fixture.controller, 1)
    await fixture.controller.toggleMicrophone(true)
    fixture.controller.onTranscript('Could the guide be in Spanish too?')
    await flush()
    const request = fixture.request.mock.calls[1][0]
    expect(request.nextSpeaker).toBe('sam')
    expect(request.history.map((turn) => turn.speaker)).toEqual(['alex', 'user'])
    expect(request.history[1].text).toBe('Could the guide be in Spanish too?')
    expect(JSON.stringify(request)).not.toContain('each step clearer')
    expect(fixture.snapshot().turns).toHaveLength(2)
    shown(fixture.controller)
    expect(fixture.snapshot().turns.map((turn) => turn.speaker)).toEqual([
      'alex',
      'user',
      'sam',
      'alex',
    ])
    fixture.controller.dispose()
  })

  it('aborts a pending response when the learner starts speaking and ignores late completion', async () => {
    let resolveLate!: (value: ReturnType<typeof response>) => void
    let count = 0
    const request = vi.fn((body: HomeConversationRequest, _signal: AbortSignal) => {
      count++
      return count === 2
        ? new Promise<ReturnType<typeof response>>((resolve) => {
            resolveLate = resolve
          })
        : Promise.resolve(response(body.nextSpeaker))
    })
    const fixture = setup(request)
    await fixture.controller.startNew()
    shown(fixture.controller)
    fixture.controller.onComplete()
    await vi.advanceTimersByTimeAsync(800)
    fixture.controller.onVoiceState('listening')
    expect(request.mock.calls[1][1].aborted).toBe(true)
    resolveLate(response())
    await flush()
    expect(fixture.play).toHaveBeenCalledTimes(1)
    fixture.controller.onTranscript('Let us talk about the timeline instead.')
    await flush()
    expect(request.mock.calls[2][0].history.at(-1)?.text).toContain('timeline')
    expect(fixture.play).toHaveBeenCalledTimes(2)
    fixture.controller.dispose()
  })

  it('pauses pending work and resumes from shared context without replaying the opening', async () => {
    const fixture = setup()
    await fixture.controller.startNew()
    shown(fixture.controller)
    fixture.controller.onComplete()
    fixture.controller.pause()
    await vi.advanceTimersByTimeAsync(10000)
    expect(fixture.request).toHaveBeenCalledTimes(1)
    await fixture.controller.resume()
    expect(fixture.request.mock.calls[1][0].history).toHaveLength(2)
    expect(fixture.setMicrophone).not.toHaveBeenCalled()
    fixture.controller.dispose()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('continues two-person discussion after a silent learner leaves their mic turn', async () => {
    const fixture = setup()
    await fixture.controller.startNew()
    shown(fixture.controller)
    await fixture.controller.toggleMicrophone(true)
    fixture.controller.onListeningQuiet()
    await flush()
    expect(fixture.request).toHaveBeenCalledTimes(2)
    expect(fixture.snapshot().turns.some((turn) => turn.speaker === 'user')).toBe(false)
    await fixture.controller.toggleMicrophone(false)
    expect(fixture.request).toHaveBeenCalledTimes(2)
    fixture.controller.dispose()
  })

  it('bounds model context while retaining original learner wording and the complete local transcript', () => {
    const turns: HomeConversationEntry[] = Array.from({ length: 100 }, (_, i) => ({
      id: `turn-${i}`,
      speaker: i % 5 === 0 ? 'user' : i % 2 ? 'sam' : 'alex',
      text: `Original words ${i}`,
      timestamp: i,
    }))
    const context = selectHomeConversationContext(turns)
    expect(context.history).toHaveLength(20)
    expect(context.earlierContext.length).toBeLessThanOrEqual(12)
    expect(context.earlierContext).toContainEqual({
      id: 'turn-0',
      speaker: 'user',
      text: 'Original words 0',
    })
    expect(context.history.at(-1)?.id).toBe('turn-99')
    expect(turns).toHaveLength(100)
  })

  it.each(['user', 'sam'] as const)(
    'keeps an older explicit %s agreement with its actual proposal without replacing learner context',
    (speaker) => {
      const turns: HomeConversationEntry[] = Array.from({ length: 50 }, (_, index) => ({
        id: `turn-${index}`,
        speaker: index % 2 ? 'sam' : 'alex',
        text: `An actual spoken point ${index}.`,
        timestamp: index,
      }))
      for (const index of [0, 8, 12, 15, 18, 21, 24, 27]) {
        turns[index].speaker = 'user'
        turns[index].text = `My actual contribution ${index}.`
      }
      turns[4].text = 'Let us provide the guide in both English and Spanish.'
      turns[5] = { ...turns[5], speaker, text: 'Agreed.' }

      const context = selectHomeConversationContext(turns)
      const earlierIds = context.earlierContext.map((turn) => turn.id)
      expect(context.history).toHaveLength(20)
      expect(context.earlierContext).toHaveLength(12)
      expect(earlierIds).toEqual(
        expect.arrayContaining([
          'turn-0',
          'turn-4',
          'turn-5',
          'turn-8',
          'turn-12',
          'turn-15',
          'turn-18',
          'turn-21',
          'turn-24',
          'turn-27',
        ]),
      )
      expect(context.earlierContext.find((turn) => turn.id === 'turn-4')).toEqual({
        id: 'turn-4',
        speaker: 'alex',
        text: 'Let us provide the guide in both English and Spanish.',
      })
      expect(context.earlierContext.find((turn) => turn.id === 'turn-5')).toEqual({
        id: 'turn-5',
        speaker,
        text: 'Agreed.',
      })
      expect(
        context.earlierContext.every((turn) =>
          turns.some(
            (original) =>
              original.id === turn.id &&
              original.speaker === turn.speaker &&
              original.text === turn.text,
          ),
        ),
      ).toBe(true)
      expect(turns).toHaveLength(50)
    },
  )

  it('keeps the proposal when its agreement crosses the recent-history boundary', () => {
    const turns: HomeConversationEntry[] = Array.from({ length: 50 }, (_, index) => ({
      id: `turn-${index}`,
      speaker: index < 8 ? 'user' : index % 2 ? 'sam' : 'alex',
      text: `An actual spoken point ${index}.`,
      timestamp: index,
    }))
    turns[12].text = 'Agreed.'
    turns[18].text = 'Agreed.'
    turns[29].text = 'Let us move the launch to Monday.'
    turns[30] = { ...turns[30], speaker: 'user', text: 'Agreed.' }

    const context = selectHomeConversationContext(turns)
    expect(context.earlierContext).toHaveLength(12)
    expect(context.history[0]).toEqual({ id: 'turn-30', speaker: 'user', text: 'Agreed.' })
    expect(context.earlierContext).toContainEqual({
      id: 'turn-29',
      speaker: 'sam',
      text: 'Let us move the launch to Monday.',
    })
    expect(context.earlierContext.map((turn) => turn.id)).toEqual(
      expect.arrayContaining([
        'turn-0',
        'turn-1',
        'turn-2',
        'turn-3',
        'turn-4',
        'turn-5',
        'turn-6',
        'turn-7',
        'turn-17',
        'turn-18',
      ]),
    )
    expect(context.earlierContext.some((turn) => turn.id === 'turn-12')).toBe(false)
  })

  it('retains a topic change at the end of a long learner contribution', () => {
    const text = `${'The handover should be easy to follow. '.repeat(95)}Actually, let us talk about the budget now.`
    const context = selectHomeConversationContext([
      { id: 'user-long', speaker: 'user', text, timestamp: 1 },
    ])
    expect(context.history.length).toBeGreaterThan(1)
    expect(context.history.every((turn) => turn.text.length <= 2000)).toBe(true)
    expect(context.history.map((turn) => turn.text).join('')).toBe(text)
    expect(context.history.at(-1)?.text).toContain('talk about the budget now')
    expect(
      HomeConversationRequestSchema.safeParse({
        roleId: 'deployed-ai-developer',
        level: 'B1',
        ...context,
      }).success,
    ).toBe(true)
  })
})
