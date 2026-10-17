<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Repository conventions

These rules follow the reviewed `code-style.md` at https://github.com/josoroma/daily-pulse-check/blob/main/.claude/rules/code-style.md.

- Use 2-space indentation, single quotes, trailing commas, and no semicolons.
- Prefer named exports. Default exports are allowed only in Next.js convention files: `page.tsx`, `layout.tsx`, `loading.tsx`, `error.tsx`, and `route.ts`.
- Use the `@/` import alias. Do not use relative imports that traverse more than one parent directory.
- Prefix route module files with an underscore, such as `_schema.ts`, `_types.ts`, `_atoms.ts`, `_hooks.ts`, `_utils.ts`, and `_constants.ts`.
- Keep route components in `_components/`, with kebab-case filenames, PascalCase component names, and one primary component per file.
- Write components as named exported `const` arrow functions and destructure props in the function signature.
- Keep types beside their route; extract them to `lib/` only when shared by three or more routes.
- Export Zod contracts as `export const NameSchema = z.object(...)` and derive types with `export type Name = z.infer<typeof NameSchema>`.
- Name exported actions with a verb and noun, using `export async function verbNoun(...)`.
- Keep JSX and control flow readable across lines; avoid compressing whole components into a single line.

## Local architecture

- The app is voice-first. Keep microphone, transcription, conversation, playback, and persistence concerns in their existing modules.
- Inference endpoints must remain loopback-only unless the user explicitly changes that requirement. Do not add a silent hosted-model fallback.
- Automatically save live original/improved transcripts to the on-device database and configured loopback Supabase instance. Hosted Supabase uploads require the learner’s opt-in; preserve local data on sync errors.
- Validate request, model, and stored-data boundaries with Zod. Never manufacture learner history, scores, quotations, or unsupported acoustic assessments.
- Preserve cancellation and cleanup for microphone streams, audio nodes, requests, and session timers.
- Use `npm run typecheck`, `npm test`, and `npm run build` for application validation. Real speech and API checks are documented in `docs/local-models.md` and require local services.
