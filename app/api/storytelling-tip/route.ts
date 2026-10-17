import { randomInt, randomUUID } from 'node:crypto'
import { generateText } from 'ai'
import { roles } from '@/app/_constants'
import { errorResponse, readJson, RequestError } from '@/lib/ai/http'
import { createCoachModel, reportCoachIssue } from '@/lib/ai/local-provider'
import { isMemoryPressureError } from '@/lib/ai/local-stream'
import {
  buildStorytellingInstructions,
  buildStorytellingPrompt,
  parseStorytellingTip,
  StorytellingTipRequestSchema,
} from '@/lib/ai/storytelling-tip'

export const runtime = 'nodejs'
export const maxDuration = 45

const storytellingAngles = [
  'Give the listener a clear starting situation before the change.',
  'Explain why a moment mattered to someone.',
  'Choose one concrete detail instead of several vague adjectives.',
  'Use a clear before-and-after contrast.',
  'Build a short story around a decision and its consequence.',
  'Use a brief pause before the turning point.',
  'End with a useful takeaway instead of trailing off.',
  'Keep the main thread by leaving out an unnecessary detour.',
  'Make a technical story understandable with an everyday comparison.',
  'Use a short question to invite the listener into the story.',
  'Connect events with natural spoken transitions.',
  'Describe a small obstacle and the next step toward resolving it.',
]

const exampleSettings = [
  'a team trying a new way of working',
  'an unexpected moment on a journey',
  'learning a small new skill',
  'a product demonstration for a curious colleague',
  'a misunderstanding that gets resolved',
  'a hobby project that takes an unexpected turn',
  'choosing between two everyday options',
  'helping a friend understand a new idea',
]

export async function POST(request: Request) {
  const timeout = AbortSignal.timeout(40_000)
  const signal = AbortSignal.any([request.signal, timeout])

  try {
    const body = await readJson(request, StorytellingTipRequestSchema)
    const roleId = body.selection?.path === 'professional' ? body.selection.roleId : body.roleId
    const role = roles.find((item) => item.id === roleId)
    if (!role) throw new RequestError('Choose a valid learning role before hearing a tip.')
    signal.throwIfAborted()

    const result = await generateText({
      model: createCoachModel(),
      instructions: buildStorytellingInstructions(),
      prompt: buildStorytellingPrompt(body, role, {
        angle: storytellingAngles[randomInt(storytellingAngles.length)],
        exampleSetting: exampleSettings[randomInt(exampleSettings.length)],
        seed: randomUUID(),
      }),
      maxOutputTokens: 500,
      temperature: 0.85,
      maxRetries: 0,
      abortSignal: signal,
    })
    signal.throwIfAborted()
    if (result.finishReason === 'length') {
      throw new RequestError('The local coach’s tip was cut short. Try a new tip.', 503)
    }
    const tip = parseStorytellingTip(result.text, body.recentTitles)
    reportCoachIssue()
    return Response.json(tip, { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) {
    if (request.signal.aborted) {
      return errorResponse(new RequestError('Storytelling tip cancelled.', 499), '')
    }
    if (timeout.aborted) {
      return errorResponse(
        new RequestError('The local coach took too long to prepare a tip. Try again.', 504),
        '',
      )
    }
    if (isMemoryPressureError(error)) {
      const detail =
        'The local coach needs more free memory to prepare a tip. Close unused memory-heavy apps, then retry.'
      reportCoachIssue(detail)
      return errorResponse(new RequestError(detail, 503), detail)
    }
    return errorResponse(
      error,
      'The local coach could not prepare a fresh storytelling tip. Check that the coach is running and try again.',
    )
  }
}
