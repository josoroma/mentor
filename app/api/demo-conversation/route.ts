import { randomInt, randomUUID } from 'node:crypto'
import { generateText } from 'ai'
import { roles } from '@/app/_constants'
import {
  buildDemoConversationInstructions,
  buildDemoConversationPrompt,
  DemoConversationRequestSchema,
  parseDemoConversation,
} from '@/lib/ai/demo-conversation'
import { errorResponse, readJson, RequestError } from '@/lib/ai/http'
import { getDemoConversationSubjects } from '@/lib/ai/demo-topics'
import { createCoachModel, reportCoachIssue } from '@/lib/ai/local-provider'
import { isMemoryPressureError } from '@/lib/ai/local-stream'
import { resolveLearningSelection } from '@/lib/learning/paths'

export const runtime = 'nodejs'
export const maxDuration = 65

const situations = [
  'They compare two possibilities and arrive at a simple choice.',
  'One has a modest concern, and the other helps think it through.',
  'One shares a small discovery that makes the other curious.',
  'They politely disagree at first and find common ground.',
  'They turn a vague idea into a concrete first step.',
  'A follow-up question reveals an unexpected but plausible perspective.',
]

export async function POST(request: Request) {
  const timeout = AbortSignal.timeout(60_000)
  const signal = AbortSignal.any([request.signal, timeout])

  try {
    const body = await readJson(request, DemoConversationRequestSchema)
    const roleId = body.selection?.path === 'professional' ? body.selection.roleId : body.roleId
    const role = roles.find((item) => item.id === roleId)
    if (!role) throw new RequestError('Choose a valid learning role before hearing a conversation.')
    signal.throwIfAborted()
    const subjects =
      body.selection?.path === 'life-skills'
        ? [resolveLearningSelection(body.selection).subject]
        : getDemoConversationSubjects(role.id)

    const result = await generateText({
      model: createCoachModel(),
      instructions: buildDemoConversationInstructions(body.personas),
      prompt: buildDemoConversationPrompt(body, role, {
        subject: subjects[randomInt(subjects.length)],
        situation: situations[randomInt(situations.length)],
        seed: randomUUID(),
      }),
      maxOutputTokens: 900,
      temperature: 0.85,
      maxRetries: 0,
      abortSignal: signal,
    })
    signal.throwIfAborted()
    if (result.finishReason === 'length') {
      throw new RequestError('The local coach’s sample conversation was cut short. Try again.', 503)
    }
    const conversation = {
      ...parseDemoConversation(result.text, body.recentTopics, body.personas),
      ...(body.speechProvider ? { speechProvider: body.speechProvider } : {}),
    }
    reportCoachIssue()
    return Response.json(conversation, { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) {
    if (request.signal.aborted) {
      return errorResponse(new RequestError('Sample conversation cancelled.', 499), '')
    }
    if (timeout.aborted) {
      return errorResponse(
        new RequestError(
          'The local coach took too long to prepare a conversation. Try again.',
          504,
        ),
        '',
      )
    }
    if (isMemoryPressureError(error)) {
      const detail =
        'The local coach needs more free memory to prepare a conversation. Close unused memory-heavy apps, then retry.'
      reportCoachIssue(detail)
      return errorResponse(new RequestError(detail, 503), detail)
    }
    return errorResponse(
      error,
      'The local coach could not prepare a fresh sample conversation. Check that the coach is running and try again.',
    )
  }
}
