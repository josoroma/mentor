# Mentor product guide

Detailed product behavior and operating notes. For the product overview and visual tour, see the [README](../README.md). Run commands from the repository root.

A voice-first English communication tutor with two learning paths: **Professional Roles**, with 40 positions including **Forward-Deployed AI Engineer**, and **Life & Workplace Skills**, with 49 topics across 14 categories. Practice realistic conversations tailored to your position or chosen topic, from technical decisions and customer delivery to conflict resolution, storytelling, and career development. Forward-deployed practice covers customer workflows, production AI delivery, integrations, reliability, and measurable business outcomes. Existing profiles and history retain their stable role identifiers.

The practice studio has separate audio-reactive visuals, listening/thinking/speaking states, and a live conversation transcript. **You, refined** appears directly beneath each learner message, updating in place while the conversation continues. Pause to play the clearer wording aloud. Original words, draft corrections, completed improvements, and session progress save automatically while you speak. Questions adapt to the selected role, CEFR level, and conversation; detailed feedback follows the session.

Practice shows the full learning path and role or life-skills topic above the session. The **mentor** logo returns to the Practice homepage from every view. Leaving a live session through the logo stops audio and saves the final transcript without opening feedback; a sync outage does not prevent returning home once the completed session is saved on this device.

## Run locally

The included inference setup targets this Apple Silicon Mac: Node.js 22+, `uv`, `ffmpeg`, macOS `say`, Docker, the Supabase CLI, and an existing local language model. The launcher prefers the smaller cached Gemma E2B model through llama.cpp; Bonsai through MTPLX remains available. The [model compatibility review](local-models.md) explains the inspected checkpoints and alternatives.

```bash
npm install
cp .env.example .env.local
npm run speech:setup
```

Speech setup installs isolated Python runtimes, stages `faster-whisper-base.en`, and installs the default Kokoro-82M voice engine. Use `npm run speech:setup:kokoro` to add or refresh Kokoro separately. Chatterbox Multilingual V3 and its synthetic reference voices are optional through `npm run speech:setup:chatterbox`. Start local Supabase, the app, and both local model services with one command:

```bash
npm run dev:local
```

The database setup applies the Mentor migrations and seeds, enables local anonymous authentication, and writes only the local public Supabase URL/key to the ignored `.env.local` file. Database Studio is at **http://127.0.0.1:54323**. The launcher reuses healthy local services, waits for new services to become ready, and stops only processes it started when you press Ctrl-C. It refuses remote endpoints and reports occupied unhealthy ports without stopping another process. Docker database containers persist when the voice launcher exits. Use `npm run db:stop` to stop Mentor’s database while retaining its data. You can also run `npm run db:start` and each voice service separately:

```bash
npm run coach:start
```

```bash
npm run speech:start
```

```bash
npm run dev
```

Open **http://127.0.0.1:3000**. Choose your global learning focus in **Settings**: a professional role, or a life-skills category and topic. The exact selection is saved and reused on the homepage, in Explore, and in AI interactions. Once the full scenario batch for that selection has loaded successfully, two randomly selected AI colleagues prepare a matching conversation and begin speaking automatically when the browser allows it. While scenarios load, the conversation controls stay disabled; if generation fails, retry from the scenario panel before the partners start. If autoplay is blocked, choose **Enable voice** once. Allow microphone access to interrupt with your own topic or begin a practice conversation. The app’s Settings panel checks the model services. No paid AI API key is required. `.env.example` contains local endpoints and commented Supabase placeholders; it contains no credentials.

For a production build on the same machine, run `npm run build` followed by `npm start`; keep the coach and speech processes running. The app has not been published to a hosted service. A remote Next.js deployment alone cannot access models on this laptop.

## Voice and learning architecture

| Area               | Implementation                                                                                                                                                                         |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Application        | Next.js App Router, TypeScript, React, Tailwind CSS, shadcn-style components and Radix dialog primitives                                                                               |
| Client state       | Jotai atoms with validated browser storage; React Hook Form and Zod for profile forms and data contracts                                                                               |
| Speech recognition | Microphone capture → `/api/transcribe` → local faster-whisper, CPU int8, silence filtering                                                                                             |
| AI colleague       | `/api/coach` → Vercel AI SDK → local Gemma through llama.cpp (or Bonsai through MTPLX), using Chat Completions; streamed text and sentence playback                                    |
| Speech synthesis   | `/api/speech` → selected local macOS, Kokoro, or Chatterbox engine → PCM WAV, played with actual amplitude visualization                                                               |
| Homepage dialogue  | `/api/demo-conversation` → local AI generates six alternating turns for two randomly selected personas, matching the selected learning path, position or life topic, and English level |
| Practice scenarios | `/api/scenarios` → local AI generates up to nine fresh scenarios whenever the learning selection or English level changes; validated output and cancellation prevent stale cards       |
| Live improvements  | `/api/improve`, local streaming rewrites, stable source-turn IDs, cancellation, and coach-priority scheduling                                                                          |
| Session review     | `/api/feedback`, validated feedback, grounded learner quotations, and retryable errors                                                                                                 |
| Persistence        | Automatic IndexedDB saves and localStorage recovery; local Supabase in Docker with authenticated ownership and RLS; hosted Supabase remains opt-in                                     |

The requested package ecosystems use real package names: `@date-fns/tz` and `date-fns`; `@hookform/resolvers` and `react-hook-form`; `@supabase/ssr` and `@supabase/supabase-js`. The project also includes `jotai`, `shadcn`, `tailwind-merge`, and `zod`. `@supabase/ssr` is available for future server-managed authentication; database sync uses the browser Supabase client.

Code is organized around small modules:

- `app/_components/`: practice dashboard, voice studio, transcript, feedback, history, and profile UI.
- `app/_hooks/use-voice-session.ts` and `lib/audio/`: microphone lifecycle, turn detection, transcription, streaming playback, cancellation, and recovery.
- `app/_schema.ts`, `_types.ts`, `_constants.ts`, and `_atoms.ts`: validated domain contracts, curriculum, and shared state.
- `app/api/` and `lib/ai/`: bounded API contracts, local inference adapters, role-play prompts, and feedback validation.
- `lib/learning/` and `lib/supabase/`: local persistence, opt-in synchronization, progress calculations, and authenticated client setup.
- `scripts/`: local model setup, launchers, real speech tests, and API smoke checks.

## Automatic transcript storage

`npm run dev:local` starts this repository’s separate `mentor` Supabase project in Docker. No hosted account is needed. Every session has a stable ID; saves update the same row as original transcription, improved wording, and duration change. An on-device IndexedDB copy and localStorage recovery cache remain available if the database disconnects. The studio shows saving, saved, and retry states. A failed final save keeps the studio open so you can retry without losing the conversation.

Incomplete sessions remain visible in history after a reload and are excluded from completed-session progress. Review and transcript download include original wording and matching improvements, labeled as drafts when unfinished. Raw audio is not retained. Improvements continue when their panel is hidden; coach speech takes priority over background editing.

## Backup, restore, and reset

Choose **Backup & reset** in the sidebar (or the navigation menu on mobile). **Download backup** creates a versioned JSON file containing your learning profile, sessions, original and improved transcripts, unfinished speech drafts, feedback, conversation plans, bookmarked scenarios, scenario configurations, and Explore sessions with prompts, artifacts, complete revision histories, and saved interaction state. The export reads the on-device database and the connected learner’s Supabase records when sync is active, including history beyond the normal dashboard limit. Audio recordings and authentication credentials are excluded. Check that your browser saved the file before resetting.

**Restore** validates a Mentor backup of up to 25 MB and previews its contents before you confirm. It merges sessions by their identifiers, preserves completed records and feedback, and restores your profile and scenario settings. Your current privacy preference remains unchanged. Restored data syncs to local Supabase or an explicitly enabled hosted database; a connection failure keeps the restored local practice copy and reports the sync issue. Backups containing explorations require the learning database to be reachable and authorized before any records change; keep the file and retry if it is unavailable. Explore restoration merges records transactionally, preserves newer revisions, and rejects conflicting immutable history.

**Reset** requires typing `RESET` and acknowledging that you have a backup or do not need one. It clears the current learner’s profile, history, transcripts, feedback, plans, bookmarked scenarios, personal scenario settings, and Explore sessions and their artifact revisions from the browser and connected Supabase storage when sync is active. It preserves the browser’s theme, authentication identity, shared scenario library, and other learners’ records. Hosted copies remain untouched when hosted sync is disabled. A database reset failure retains local data and can be retried. Backups can be restored afterward.

Reset and restore wait for pending saves and coordinate between Mentor tabs to prevent stale history from returning. Other tabs refresh after a change; active voice practice stops during a reset or restore. If a tab closes during maintenance, its temporary lock expires after one minute so you can retry. New database migrations apply automatically when running `npm run db:start` or `npm run dev:local`.

## Learning paths and free conversations

Choose **Professional Roles** or **Life & Workplace Skills** under **Settings → Your learning focus**, then save a role or a category and topic. The full selection persists in your profile, local database, and backups, and returns unchanged after reload. The homepage and Explore selectors update that same global preference. When you switch paths or categories, a valid starting choice is provided and remains editable. Existing practice sessions and Explore lessons keep the focus they started with; new AI conversations, scenarios, and explorations use your current saved focus and English level. Free conversation topics can still lead beyond that background focus.

The local AI generates up to nine fresh practice scenarios whenever you change the path, position, category, topic, or English level. Each includes a situation, conversation partner, opening question, and three practice objectives. Previous cards disappear while the new scenarios are generated, and canceled requests cannot replace the current selection. **Regenerate scenarios** creates another set for the same selection and pauses any active homepage conversation. Once the new scenarios are ready, use **Continue conversation** to resume that existing exchange. A new learning focus starts its own conversation after its scenarios load. If the local model is unavailable, retry generation from the scenario panel.

Use the heart in the bottom-right corner of a scenario to save it; a filled red heart marks a saved scenario. The **Saved** filter follows **Collaboration** and shows saved scenarios from all learning focuses, with search and nine scenarios per page. Saving preserves the full scenario and English level in local Supabase, with a browser recovery copy. The heart toggles saving without opening the conversation. Saved scenarios survive regeneration and reload; removing a heart is synced too. Backup, restore, and reset include bookmarks.

Choose **Start voice practice** to enter the first generated scenario directly, or select a scenario card to review its situation before starting. No spoken or typed topic prompt is required for this flow. The coach adapts vocabulary, follow-up questions, and complexity to your English level, including C2. Life skills include communication, leadership, negotiation, focus, career development, and wellness. Health-related topics support educational conversation and question-asking without diagnoses, personal treatment advice, or promised health outcomes. Your selected learning path, the scenario’s exact selection, transcripts, feedback, and progress remain available in saved learning data and backups. Previous sessions retain their original scenario configurations.

The homepage starts an ongoing conversation matching the current position or life skills topic. Two explicitly labeled AI partners take alternating turns using distinct local voices, and the local coach generates the next exchange from their shared conversation history. Both partners respond to your contributions and can follow a new topic. They continue talking when you prefer to listen, until you pause or leave the page. A new conversation randomly selects two supported personas from the chosen engine. Each orb responds to its speaker’s audio, and the transcript reveals each turn when playback starts. Recent topics are remembered to avoid repeats. **New conversation** starts afresh; **Continue conversation** resumes the same discussion after pausing. Changing the learning focus starts a matching conversation.

The partners acknowledge agreements and move on to an example, consequence, next step, or related angle instead of repeatedly asking for confirmation. Each pair of turns can contain at most one question, with no new questions immediately after agreement or while recent questions need room for an answer. New objections and corrections take priority over older agreements; the AI partners never treat your silence as consent. Repeated wording or excessive questions redirect the next local generation toward a fresh topic related to your selected role or learning focus. If the model still repeats itself, a brief prepared topic transition keeps the conversation going automatically. The same partners, microphone setting, and transcript continue; topics already discussed are considered when choosing the next one. Older agreement excerpts retain their preceding proposals so a standalone “yes” is not mistaken for a new decision.

The homepage microphone is **off by default**. Turn on **Your mic** to join the same conversation directly, without opening a dialog. Speech interrupts an AI turn so the partners can respond to what you actually said. **Done speaking** submits your current contribution; natural pauses also finish an utterance. The microphone stays enabled across exchanges until you turn it off or pause. Under **Your mic**, **Join the conversation** offers up to three short ways to catch up, ask a follow-up question, or add an idea. The local coach updates them from the displayed conversation, including your actual contributions, at your English level. Choose a phrase to turn on your microphone, then say it in your own words; choosing does not submit or save the suggested text as your speech. Simple starters remain available while ideas load or the local coach is unavailable, with a separate retry.

Once you contribute, the displayed conversation and your original and improved English save automatically through the existing on-device and configured Supabase storage. Listening alone does not create learner history or scores. Long conversations retain their full local transcript while sending a bounded set of recent turns and earlier contributions to the local coach. **Pause conversation** releases the microphone and cancels pending generation and speech. Leaving the page, opening a dialog, or hiding the tab also pauses the conversation; continuing keeps its context and leaves the microphone off until you choose to enable it again.

Settings also includes **Models behind Mentor**: the loaded local language-model checkpoint and runtime, with the features it powers—conversations, homepage demos, dynamic scenarios, conversation plans, Explore, improved English, and feedback. Separate rows identify the recognition model and your selected playback model. Model details refresh when Settings opens or you choose **Check connections**. If the service does not report a checkpoint name, Mentor shows that explicitly rather than guessing from its API alias.

Choose your **Voice engine** in Settings. **Fast — macOS** uses the installed system voices for quick responses. **Balanced — Kokoro 82M** uses a smaller open-source neural model with preset voices. **Expressive — Chatterbox** supports multilingual speech and reference-based voice cloning. Your selection saves with your learning profile, including local database sync and backups, and applies to practice, homepage conversations, and every improved-English Play button. Switching engines stops current playback; the next playback uses your choice without restarting the app. Unavailable engines show setup guidance rather than silently switching to another engine.

macOS and Kokoro offer **Alex, Sam, Jordan, and Riley**; Chatterbox offers **Alex and Sam** using its existing local reference voices. Settings shows each ready engine’s available personas. New practice sessions also choose a persona once and save its name and ID with the session. The name and voice stay consistent across turns and audio chunks. If you switch to an engine that cannot voice the current persona, start a new conversation or choose a compatible engine; the app never substitutes another persona silently. For Chatterbox, setup creates synthetic references using installed Samantha and Daniel voices and caches their conditioning. To use your own local references, set `MENTOR_CHATTERBOX_COACH_REFERENCE` and `MENTOR_CHATTERBOX_PARTNER_REFERENCE` to separate WAV files and restart speech. References stay on this Mac and are not added to learning history or backups. Chatterbox supports 23 language codes; Kokoro supports English with all four personas and Spanish with Alex and Sam. Mentor's English practice defaults to English, and `/api/speech` accepts an optional supported `language` and `provider`.

**Balanced — Kokoro 82M is the default** for new and existing profiles without a saved voice choice. Choosing another engine in Settings overrides it and saves with your profile. Run `npm run speech:setup` for the default Kokoro and recognition setup, or `npm run speech:setup:chatterbox` / `npm run speech:setup:kokoro` to add an individual engine. Model downloads happen during setup; inference runs offline. `MENTOR_TTS_PROVIDER` controls the underlying service's default, while Mentor explicitly requests Kokoro or your saved Settings choice. See [local speech configuration](local-models.md#voice-engine-selection).

Choose **Free conversation** separately to hear “What would you like to talk about?” and answer aloud. There is no typed topic field. Local speech recognition shows your words as you speak and submits the topic after a natural pause; **Done speaking** is also available. The local coach improves its wording and creates three flexible stages and useful phrases tailored to your level and duration. Personal interests and everyday topics are welcome. Recording is bounded to 45 seconds per utterance; after 30 seconds without a response in this flow, the microphone turns off and can be restarted with the voice controls.

Review the plan, choose **Say another topic** if needed, and select **Start conversation**. The voice coach follows the plan while responding to your answers. The original topic, clearer wording, plan, and complete scenario configuration save with the session in IndexedDB and configured local Supabase. History and transcript downloads preserve that context alongside both transcripts and feedback.

Both voice orbs pulse, animate their voice bars, and move their rings while speaking. The learner orb follows microphone activity with a short release between syllables; coach motion follows actual audio playback. Muting or pausing stops the corresponding motion. Reduced-motion preferences keep the orbs still.

For hosted Supabase, configure your project’s public URL/anon key, apply the existing migration and seed, enable anonymous sign-in, and uncheck **Keep my learning data on this device**. Local loopback Supabase always saves automatically; the checkbox governs hosted uploads. Each browser uses an anonymous authenticated identity. Cross-device login/account recovery is not implemented; clearing its authentication storage loses access to that identity. See [database setup and storage details](../supabase/README.md).

## Explore: learn by exploring

Open **Explore**, directly below **Practice**, or visit `http://127.0.0.1:3000/#explore`. Speak or type a question, then choose **Refine prompt** (or press Command/Ctrl+Enter). The local AI analyzes your intent and offers three distinct, complete prompts tailored to useful diagrams, animations, zoom, pan, step controls, or other supported lesson interactions. Review them and choose **Explore with this prompt** to send your definitive choice. Editing your draft clears the choices; **Refine again** requests three new alternatives. Refinement has cancellation and retry controls and does not create a saved conversation or lesson. Your full selected learning path stays visible at the top, including the professional role or life-skills category and topic. Change those selections directly in the Explore library. The local AI generates up to 12 fresh exploration ideas from that exact combination and your English level; changing any selection refreshes the ideas. Choose a card to put its suggested question in the composer, or ask your own question. **New ideas** requests another set for the same path. Generation has loading and retry states, and older requests cannot replace ideas for a newer selection. Changing the path while a saved lesson is open leaves that lesson and its discussion intact; the selection applies to ideas when you return to the library.

Every library card and opened lesson shows its own saved learning path, including its role or category and topic. Changing your current profile does not relabel existing explorations. Older records without saved context show **Learning path unavailable**. These labels come from existing artifact or original-prompt metadata and require no database migration.

The conversation and lesson stay together. Once a lesson is generated, chat questions discuss that selected artifact: ask about a step, request a simpler explanation, translate its wording, or practice the material. Follow-up drafts also offer three refinements, using the selected lesson and recent discussion for context; choose **Send this prompt** to continue. Answers appear in the conversation without creating or rewriting artifacts. Choose **New** to start a separate exploration for another lesson. Existing explorations with several saved artifacts still let you select which one to discuss. **Revision history** preserves earlier versions and lets you restore them. Controls, notes, estimates, answers, diagrams and camera settings save automatically to the authenticated learning database. Playback reopens paused. The library supports renaming, deletion, title search, format filters and 12 explorations per page; older conversation messages load on demand.

Each **You** message also displays **Improved English** underneath your original text. The local AI corrects grammar and phrasing while preserving your intent, including questions. Corrections run separately from lesson generation, so failed questions and older visible messages can still receive improved wording. Both versions remain in your database and backups; reopening a saved correction does not generate it again. A failed correction has its own retry button.

In communication examples, expand **Practice your version** and write your own request or response. After a brief pause, **Improved English** appears directly below the practice box. The local coach improves your wording without answering the question or replacing it with the lesson’s example. Editing clears the old correction and requests a fresh one. Your original draft and correction save together as learning state and return when you reopen the lesson; they do not change the generated artifact or create a revision. Only expanded practice entries request corrections, one at a time, with retry controls if the local coach is unavailable.

Choose **Play** beside improved wording to hear it with the local coach voice. Playback covers Explore messages and practice drafts, live and saved transcript corrections, feedback rewrites, and improved conversation topics. **Cancel** stops voice preparation and **Stop** ends playback; starting another correction replaces the previous one. Long corrections are read in full. Editing, collapsing the entry, navigating away, or starting the microphone stops playback. During a live conversation, pause practice before listening to a correction, then resume when ready. Audio plays on demand without changing your saved text or storing a recording.

Executable models include Hanoi, stable bubble sort, Fibonacci and Planning Poker, an ideal small-angle pendulum, a traveling wave and a circular orbit. Other topics use generated walkthroughs, diagrams and structured examples. The model emits validated declarative data; the app never executes generated JavaScript, HTML or shaders. Three.js loads on demand for simulations and spatial diagrams, with an SVG fallback when WebGL is unavailable. Model assumptions and sources accompany the built-in scientific and algorithmic models.

For a visual lesson, ask for a diagram explicitly—for example, **“Explain git rebase with an interactive SVG diagram”** or **“Show a local language-model request as a 3D assembly I can separate.”** Diagrams offer 2D/3D views, zoom, pan, camera angles, component search and focus, reversible separation, light and shadows, and chapter playback. Drag to turn a 3D scene; Shift-drag pans. In 2D, drag pans and a focused diagram accepts scroll zoom. Keyboard camera buttons and touch gestures are available. Camera, separation, lighting, selection and chapter position save with the lesson; playback starts paused.

**Download** exports SVG, PNG, a 1200×630 sharing card, or a self-contained interactive HTML file that opens offline. HTML and SVG use a portable 2D schematic; PNG captures the spatial scene when 3D is selected. **Record 8s · WebM** captures a silent clip in supporting browsers; canceling, leaving the lesson or hiding the tab stops recording. Structure checks reject unknown endpoints, duplicate identifiers and invalid chapter references. Shapes are schematic, and model relationships are illustrative unless accompanied by an exact supplied excerpt. A repository URL alone does not inspect its code or verify its connections. Older saved diagrams remain compatible; start a new exploration to generate a different format.

Explore requires the configured learning database and local coach. It reports generation and save failures with retry controls. Requests save their prompt before inference. Initial lesson creation commits the response and artifact together; subsequent questions save only conversation messages. Canceled or interrupted requests can be retried without duplicating completed turns. Local model speed depends on lesson size; generating a long set of examples can take over a minute. Complete Explore histories and revisions are included in **Backup & reset**. See [Explore database details](../supabase/README.md#explore-learning-studio).

## Verify

```bash
npm run typecheck
npm test
npm run build
```

With speech setup completed:

```bash
"$HOME/Models/.venvs/mentor-speech/bin/python" scripts/test_speech.py
```

With all three services running:

```bash
node scripts/smoke-local.mjs
node scripts/smoke-speech-providers.mjs
```

Unit tests cover domain validation, progress, storage recovery, privacy and sync races, API validation, feedback grounding, and audio utilities. The smoke check exercises actual local synthesis, transcription, streamed conversation, and feedback. Measurements and troubleshooting are documented in [local model setup](local-models.md).

## Practical limits

- Live learner transcripts use rolling audio segments, so words can appear in short batches and may be revised at segment boundaries. Coach text streams as tokens arrive. This is a local turn-based voice pipeline; model latency depends on available memory and context.
- Grammar, vocabulary, clarity, conciseness, and professional communication receive transcript-based coaching. Pronunciation, acoustic fluency, and vocal confidence remain unscored because phonetic/prosodic assessment is not implemented. Scores are informal coaching estimates.
- When a model is unavailable, the app shows a recoverable error. Saved transcripts stay available locally, and feedback can be retried. There is no silent cloud speech fallback or fabricated conversation.
- Raw recordings are processed locally and discarded. Supabase stores original and improved text transcripts and feedback; hosted storage requires opt-in. MTPLX terminal diagnostics can include generated text previews.

Repository conventions follow the reviewed [code-style.md](https://github.com/josoroma/daily-pulse-check/blob/main/.claude/rules/code-style.md) and are recorded in [AGENTS.md](../AGENTS.md).
