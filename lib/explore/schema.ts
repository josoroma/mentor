import { z } from 'zod'
import { ProficiencyLevelSchema } from '@/app/_schema'
import { LearningSelectionSchema } from '@/lib/learning/paths'

export const ExploreLearningContextSchema = z.object({
  selection: LearningSelectionSchema,
  level: ProficiencyLevelSchema,
})
export type ExploreLearningContext = z.infer<typeof ExploreLearningContextSchema>

export const ExploreArtifactKindSchema = z.enum([
  'walkthrough',
  'diagram',
  'hanoi',
  'fibonacci',
  'sorting',
  'examples',
  'simulation',
])
export type ExploreArtifactKind = z.infer<typeof ExploreArtifactKindSchema>

const SectionSchema = z.object({
  heading: z.string().min(1).max(120),
  body: z.string().min(1).max(1800),
})
const StepSchema = z.object({
  title: z.string().min(1).max(120),
  body: z.string().min(1).max(1200),
  focus: z.array(z.string().min(1).max(40)).max(12).nullable().optional(),
})

export const ExploreDiagramConfigSchema = z.object({
  view: z.enum(['flow', 'sequence', 'assembly']),
  layout: z.enum(['horizontal', 'vertical']),
})
export type ExploreDiagramConfig = z.infer<typeof ExploreDiagramConfigSchema>

const PositionValueSchema = z.number().finite().min(-12).max(12)
const SizeValueSchema = z.number().finite().min(0.15).max(6)
const SeparationValueSchema = z.number().finite().min(-8).max(8)

// Schematic world units, not measured dimensions or executable geometry.
export const ExploreNodeVisualSchema = z.object({
  shape: z.enum(['box', 'cylinder', 'sphere', 'ring']),
  position: z.tuple([PositionValueSchema, PositionValueSchema, PositionValueSchema]),
  size: z.tuple([SizeValueSchema, SizeValueSchema, SizeValueSchema]),
  separation: z.tuple([SeparationValueSchema, SeparationValueSchema, SeparationValueSchema]),
})
export type ExploreNodeVisual = z.infer<typeof ExploreNodeVisualSchema>

export const ExploreEdgeEvidenceSchema = z.object({
  kind: z.enum(['illustrative', 'provided']),
  quote: z.string().max(300),
})
export type ExploreEdgeEvidence = z.infer<typeof ExploreEdgeEvidenceSchema>
const ExampleSchema = z.object({
  phrase: z.string().min(1).max(700),
  context: z.string().min(1).max(500),
  formality: z.enum(['casual', 'neutral', 'formal']),
  urgency: z.enum(['low', 'normal', 'high']),
  channel: z.string().min(1).max(60),
  note: z.string().max(600),
})
const QuestionSchema = z
  .object({
    question: z.string().min(1).max(500),
    options: z.array(z.string().min(1).max(200)).min(2).max(5),
    answer: z.number().int().min(0).max(4),
    explanation: z.string().min(1).max(800),
  })
  .refine((question) => question.answer < question.options.length)

// Declarative data only. Model output is never evaluated as JavaScript, HTML or shader code.
export const ExploreArtifactContentSchema = z
  .object({
    kind: ExploreArtifactKindSchema,
    learningContext: ExploreLearningContextSchema.optional(),
    title: z.string().trim().min(1).max(120),
    summary: z.string().trim().min(1).max(1600),
    objectives: z.array(z.string().min(1).max(200)).max(6),
    sections: z.array(SectionSchema).max(12),
    steps: z.array(StepSchema).max(20),
    examples: z.array(ExampleSchema).max(40),
    nodes: z
      .array(
        z.object({
          id: z
            .string()
            .regex(/^[a-zA-Z0-9_-]+$/)
            .max(40),
          label: z.string().min(1).max(100),
          detail: z.string().max(700),
          visual: ExploreNodeVisualSchema.nullable().optional(),
        }),
      )
      .max(24),
    edges: z
      .array(
        z.object({
          from: z.string().min(1).max(40),
          to: z.string().min(1).max(40),
          label: z.string().max(100),
          evidence: ExploreEdgeEvidenceSchema.nullable().optional(),
        }),
      )
      .max(40),
    questions: z.array(QuestionSchema).max(8),
    config: z.object({
      size: z.number().int().min(2).max(12),
      values: z.array(z.number().int().min(1).max(99)).max(16),
      simulation: z.enum(['pendulum', 'wave', 'orbit']),
      pseudocode: z.string().max(3000),
      complexity: z.string().max(500),
      diagram: ExploreDiagramConfigSchema.nullable().optional(),
    }),
    assumptions: z.array(z.string().min(1).max(400)).max(6),
  })
  .superRefine((content, context) => {
    const ids = new Set(content.nodes.map((node) => node.id))
    if (
      ids.size !== content.nodes.length ||
      content.edges.some((edge) => !ids.has(edge.from) || !ids.has(edge.to))
    )
      context.addIssue({
        code: 'custom',
        message: 'Diagram nodes must be unique and edges must reference existing nodes.',
        path: ['nodes'],
      })
    const edges = new Set<string>()
    content.edges.forEach((edge, index) => {
      const identity = JSON.stringify([edge.from, edge.to, edge.label])
      if (edges.has(identity))
        context.addIssue({
          code: 'custom',
          message: 'Diagram edges must not repeat the same source, destination and label.',
          path: ['edges', index],
        })
      edges.add(identity)
      if (edge.evidence?.kind === 'provided' && !edge.evidence.quote.trim())
        context.addIssue({
          code: 'custom',
          message: 'A provided connection needs an exact quotation from learner-supplied text.',
          path: ['edges', index, 'evidence', 'quote'],
        })
    })
    content.steps.forEach((step, index) => {
      if (
        step.focus &&
        (new Set(step.focus).size !== step.focus.length || step.focus.some((id) => !ids.has(id)))
      )
        context.addIssue({
          code: 'custom',
          message: 'Step focus must contain unique existing diagram node ids.',
          path: ['steps', index, 'focus'],
        })
    })
    if (
      content.kind !== 'diagram' &&
      (content.config.diagram ||
        content.nodes.some((node) => node.visual) ||
        content.edges.some((edge) => edge.evidence) ||
        content.steps.some((step) => step.focus != null))
    )
      context.addIssue({
        code: 'custom',
        message: 'Visual metadata and node focus are only supported for diagram artifacts.',
        path: ['kind'],
      })
    if (content.kind === 'diagram' && !content.nodes.length)
      context.addIssue({ code: 'custom', message: 'A diagram needs nodes.', path: ['nodes'] })
    if (content.kind === 'examples' && !content.examples.length)
      context.addIssue({
        code: 'custom',
        message: 'Provide examples to practice.',
        path: ['examples'],
      })
    if (content.kind === 'walkthrough' && !content.steps.length)
      context.addIssue({ code: 'custom', message: 'Provide walkthrough steps.', path: ['steps'] })
  })
export type ExploreArtifactContent = z.infer<typeof ExploreArtifactContentSchema>

const StateValueSchema = z.union([
  z.string().max(2000),
  z.number().finite(),
  z.boolean(),
  z.array(z.number().finite()).max(100),
  z.array(z.string().max(500)).max(100),
])
// Forty practice examples can each save an original and a correction, plus viewer controls.
export const MAX_EXPLORE_STATE_KEYS = 120
export const ExploreLearningStateSchema = z
  .record(z.string().min(1).max(80), StateValueSchema)
  .refine(
    (value) => Object.keys(value).length <= MAX_EXPLORE_STATE_KEYS,
    'Learning state supports up to 120 fields.',
  )
export type ExploreLearningState = z.infer<typeof ExploreLearningStateSchema>

export const ExploreSessionSchema = z.object({
  id: z.uuid(),
  title: z.string().min(1).max(160),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
  version: z.number().int().nonnegative(),
  artifactKind: ExploreArtifactKindSchema.nullable(),
  learningContext: ExploreLearningContextSchema.optional(),
})
export type ExploreSession = z.infer<typeof ExploreSessionSchema>
export const ExploreMessageImprovementSchema = z.object({
  text: z.string().trim().min(1).max(6000),
  createdAt: z.string().datetime({ offset: true }),
})
export type ExploreMessageImprovement = z.infer<typeof ExploreMessageImprovementSchema>

export const ExploreMessageSchema = z.object({
  id: z.uuid(),
  sessionId: z.uuid(),
  role: z.enum(['user', 'assistant']),
  content: z.string().min(1).max(16000),
  createdAt: z.string().datetime({ offset: true }),
  sequence: z.number().int().nonnegative(),
  status: z.enum(['pending', 'complete', 'failed']),
  requestId: z.uuid(),
  metadata: z
    .object({
      improvement: ExploreMessageImprovementSchema.optional(),
      learningContext: ExploreLearningContextSchema.optional(),
    })
    .catchall(z.unknown())
    .default({}),
})
export type ExploreMessage = z.infer<typeof ExploreMessageSchema>
export const ExploreArtifactSchema = z.object({
  id: z.uuid(),
  sessionId: z.uuid(),
  sourceMessageId: z.uuid(),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
  revision: z.number().int().positive(),
  revisionId: z.uuid(),
  content: ExploreArtifactContentSchema,
  state: ExploreLearningStateSchema,
})
export type ExploreArtifact = z.infer<typeof ExploreArtifactSchema>
export const ExploreRevisionSchema = z.object({
  id: z.uuid(),
  artifactId: z.uuid(),
  sessionId: z.uuid(),
  messageId: z.uuid(),
  number: z.number().int().positive(),
  content: ExploreArtifactContentSchema,
  createdAt: z.string().datetime({ offset: true }),
  restoredFrom: z.uuid().nullable(),
  sourcePrompt: z.string().min(1).max(16000).optional(),
})
export type ExploreRevision = z.infer<typeof ExploreRevisionSchema>

export const ExploreLibrarySchema = z.object({
  sessions: z.array(ExploreSessionSchema),
  total: z.number().int().nonnegative(),
  page: z.number().int().nonnegative(),
  pageSize: z.number().int().positive(),
})
export const ExploreMessagePageSchema = z.object({
  messages: z.array(ExploreMessageSchema),
  nextCursor: z.number().int().nonnegative().nullable(),
})
export const ExploreDetailSchema = z.object({
  session: ExploreSessionSchema,
  messages: z.array(ExploreMessageSchema),
  nextCursor: z.number().int().nonnegative().nullable(),
  artifacts: z.array(ExploreArtifactSchema),
})
export type ExploreDetail = z.infer<typeof ExploreDetailSchema>
export const ExploreTurnRequestSchema = z.object({
  sessionId: z.uuid(),
  requestId: z.uuid(),
  prompt: z.string().trim().min(1).max(4000),
  artifactId: z.uuid().nullable(),
  expectedVersion: z.number().int().nonnegative(),
  learningContext: ExploreLearningContextSchema.optional(),
})
export type ExploreTurnRequest = z.infer<typeof ExploreTurnRequestSchema>
export const ExploreTurnDraftSchema = z
  .object({
    reply: z.string().min(1).max(6000),
    action: z.enum(['create', 'revise', 'explain']),
    artifact: ExploreArtifactContentSchema.nullable(),
  })
  .refine((draft) =>
    draft.action === 'explain' ? draft.artifact === null : draft.artifact !== null,
  )
export type ExploreTurnDraft = z.infer<typeof ExploreTurnDraftSchema>

export const ExploreBackupSchema = z
  .object({
    sessions: z.array(ExploreSessionSchema),
    messages: z.array(ExploreMessageSchema),
    artifacts: z.array(ExploreArtifactSchema),
    revisions: z.array(ExploreRevisionSchema.omit({ sourcePrompt: true })),
  })
  .superRefine((backup, context) => {
    const problem = (message: string) => context.addIssue({ code: 'custom', message })
    const sessions = new Map(backup.sessions.map((session) => [session.id, session]))
    const messages = new Map(backup.messages.map((message) => [message.id, message]))
    const artifacts = new Map(backup.artifacts.map((artifact) => [artifact.id, artifact]))
    const revisions = new Map(backup.revisions.map((revision) => [revision.id, revision]))
    if (
      sessions.size !== backup.sessions.length ||
      messages.size !== backup.messages.length ||
      artifacts.size !== backup.artifacts.length ||
      revisions.size !== backup.revisions.length
    )
      problem('Explore records must have unique identifiers.')
    const sequences = new Set<string>()
    const requests = new Set<string>()
    for (const message of backup.messages) {
      const sequence = `${message.sessionId}:${message.sequence}`
      const request = `${message.sessionId}:${message.requestId}:${message.role}`
      if (!sessions.has(message.sessionId) || sequences.has(sequence) || requests.has(request))
        problem(
          'Explore messages must belong to a session with unique sequences and request roles.',
        )
      sequences.add(sequence)
      requests.add(request)
    }
    const histories = new Map<string, typeof backup.revisions>()
    for (const revision of backup.revisions) {
      const artifact = artifacts.get(revision.artifactId)
      const source = messages.get(revision.messageId)
      if (
        !artifact ||
        artifact.sessionId !== revision.sessionId ||
        !source ||
        source.sessionId !== revision.sessionId ||
        source.role !== 'user'
      )
        problem('Every revision must reference its artifact and source prompt in the same session.')
      if (revision.restoredFrom) {
        const previous = revisions.get(revision.restoredFrom)
        if (
          !previous ||
          previous.artifactId !== revision.artifactId ||
          previous.sessionId !== revision.sessionId ||
          previous.number >= revision.number
        )
          problem('Restored revisions must reference an earlier version of the same artifact.')
      }
      const history = histories.get(revision.artifactId) ?? []
      history.push(revision)
      histories.set(revision.artifactId, history)
    }
    for (const artifact of backup.artifacts) {
      const source = messages.get(artifact.sourceMessageId)
      const current = revisions.get(artifact.revisionId)
      const history = (histories.get(artifact.id) ?? []).sort(
        (left, right) => left.number - right.number,
      )
      if (
        !sessions.has(artifact.sessionId) ||
        !source ||
        source.sessionId !== artifact.sessionId ||
        source.role !== 'user'
      )
        problem('Every artifact must reference its session and original source prompt.')
      if (
        !current ||
        current.artifactId !== artifact.id ||
        current.sessionId !== artifact.sessionId ||
        current.number !== artifact.revision ||
        JSON.stringify(current.content) !== JSON.stringify(artifact.content)
      )
        problem('An artifact must match its current immutable revision.')
      if (
        history.length !== artifact.revision ||
        history.some((revision, index) => revision.number !== index + 1)
      )
        problem('Artifact revision history must be complete and consecutively numbered.')
    }
  })
export type ExploreBackup = z.infer<typeof ExploreBackupSchema>
