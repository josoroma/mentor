import { randomInt, randomUUID } from 'node:crypto'
import { generateText, Output } from 'ai'
import { roles } from '@/app/_constants'
import {
  buildHomeConversationInstructions,
  buildHomeConversationPrompt,
  createHomeConversationOutputSchema,
  HomeConversationRequestSchema,
  parseHomeConversation,
  type HomeConversation,
  type HomeConversationTurn,
} from '@/lib/ai/home-conversation'
import { selectHomeConversationTransition } from '@/lib/ai/home-conversation-transition'
import {
  analyzeHomeConversationProgress,
  inspectHomeConversationProgress,
} from '@/lib/ai/home-conversation-progress'
import { errorResponse, readJson, RequestError } from '@/lib/ai/http'
import { getDemoConversationSubjects } from '@/lib/ai/demo-topics'
import { createCoachModel, reportCoachIssue } from '@/lib/ai/local-provider'
import { isMemoryPressureError } from '@/lib/ai/local-stream'
import { resolveLearningSelection } from '@/lib/learning/paths'

export const runtime = 'nodejs'
export const maxDuration = 65

export async function POST(request: Request) {
  const timeout = AbortSignal.timeout(60_000)
  const signal = AbortSignal.any([request.signal, timeout])

  try {
    const body = await readJson(request, HomeConversationRequestSchema)
    const roleId = body.selection?.path === 'professional' ? body.selection.roleId : body.roleId
    const role = roles.find((item) => item.id === roleId)
    if (!role)
      throw new RequestError('Choose a valid learning role before starting a conversation.')
    signal.throwIfAborted()
    const focus = resolveLearningSelection(body.selection ?? { path: 'professional', roleId })
    const subjects =
      body.selection?.path === 'life-skills' ? [focus.subject] : getDemoConversationSubjects(roleId)
    const configuredContext = Number(process.env.MENTOR_COACH_CONTEXT ?? 4096)
    const contextTokens = Number.isFinite(configuredContext) ? configuredContext : 4096
    const variation = { subject: subjects[randomInt(subjects.length)], seed: randomUUID() }
    const progression = analyzeHomeConversationProgress(body)
    let revision: { issues: string[]; rejectedTurns: HomeConversationTurn[] } | undefined
    let transition: HomeConversation | undefined
    // A repetitive draft redirects the next attempt to a fresh, relevant topic.
    // Both attempts share the original deadline; rejected drafts are never played.
    for (let attempt = 0; attempt < 2; attempt++) {
      signal.throwIfAborted()
      const result = await generateText({
        model: createCoachModel(),
        instructions: buildHomeConversationInstructions(
          body.personas,
          focus.wellness,
          body.nextSpeaker,
        ),
        output: Output.object({ schema: createHomeConversationOutputSchema(body.nextSpeaker) }),
        prompt: buildHomeConversationPrompt(
          body,
          role,
          variation,
          contextTokens,
          revision,
          transition,
        ),
        maxOutputTokens: 650,
        temperature: 0.7,
        maxRetries: 0,
        abortSignal: signal,
      })
      signal.throwIfAborted()
      if (result.finishReason === 'length') {
        throw new RequestError(
          'The local coach’s next turns were cut short. Try continuing again.',
          503,
        )
      }
      const conversation = parseHomeConversation(JSON.stringify(result.output), body.nextSpeaker)
      const issues = inspectHomeConversationProgress(
        conversation,
        body,
        transition ? { ...progression, questionBudget: 0 } : progression,
      )
      if (transition && conversation.topic !== transition.topic) {
        issues.push('Introduce the requested fresh topic instead of returning to the prior one.')
      }
      if (!issues.length) {
        reportCoachIssue()
        return Response.json(conversation, { headers: { 'Cache-Control': 'no-store' } })
      }
      revision = { issues, rejectedTurns: conversation.turns }
      transition ??= selectHomeConversationTransition(body, role)
    }
    // If the small model still circles back, speak a safe authored topic bridge.
    // It becomes actual dialogue only through normal playback; the following
    // request can develop this fresh topic without resetting anyone's history.
    signal.throwIfAborted()
    reportCoachIssue()
    return Response.json(transition ?? selectHomeConversationTransition(body, role), {
      headers: { 'Cache-Control': 'no-store' },
    })
  } catch (error) {
    if (request.signal.aborted) {
      return errorResponse(new RequestError('Conversation continuation cancelled.', 499), '')
    }
    if (timeout.aborted) {
      return errorResponse(
        new RequestError('The local coach took too long to continue. Try again.', 504),
        '',
      )
    }
    if (isMemoryPressureError(error)) {
      const detail =
        'The local coach needs more free memory to continue. Close unused memory-heavy apps, then retry.'
      reportCoachIssue(detail)
      return errorResponse(new RequestError(detail, 503), detail)
    }
    return errorResponse(
      error,
      'The conversation is paused. Check that the local coach is running, then continue.',
    )
  }
}
