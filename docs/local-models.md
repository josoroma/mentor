# Local voice and AI setup

mentor runs its conversation, transcription, and speech synthesis on this Mac. The Next.js server proxies the browser's requests to two loopback services. It never selects a cloud speech service as a fallback.

## Inspected models and compatibility

The implementation was chosen after reading `~/Models/README-MODELS.md`, model directories, and the installed runtime help on 2026-10-15. This machine is Apple Silicon with 36 GiB unified memory.

| Existing checkpoint                                           | Compatibility and decision                                                                                                                                                                                                                                   |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Cached `gemma-4-E2B-it-UD-Q4_K_XL.gguf` (3.184 GB / 2.97 GiB) | Default when this checkpoint and `llama-server` are already installed. The inspected llama.cpp 9310 build supports its `gemma4` architecture and embedded chat template. It uses less memory than Bonsai, allowing more room for the app and local database. |
| `Ternary-Bonsai-2-27B-MTPLX-Optimized-Speed` (8.848 GB)       | Available with `MENTOR_COACH_RUNTIME=mtplx`. Its custom ternary/Hadamard pack requires the existing MTPLX 2.12.2 runtime at `~/Models/.venvs/mtplx`. The API is OpenAI Chat Completions compatible.                                                          |
| `Qwen3.8-3.6-27B-blend-MLX-4bit` (16.082 GB)                  | Compatible with the existing MLX-VLM runtime. Heavier than Bonsai, so it is not loaded alongside the coach.                                                                                                                                                  |
| `Qwen3.8-3.6-27B-blend-MTP-MLX-4bit` (0.266 GB)               | A draft head, not a standalone conversational model. Requires the matching main checkpoint.                                                                                                                                                                  |
| `Qwen-Image-2.1-MLX-4bit` (10.497 GB)                         | Image generation; not speech recognition or speech synthesis. Not used for practice.                                                                                                                                                                         |

The Gemma checkpoint was found in the existing Hugging Face cache at `~/.cache/huggingface/hub/models--unsloth--gemma-4-E2B-it-GGUF/snapshots/90f9618340396838ee7ff5b0ba2da27da62953d3/`. It was not downloaded for this change. The launcher first checks `~/Models`, then the existing Hugging Face cache. The small JetBrains MTP head cannot generate independently; the other existing language checkpoint is larger than Bonsai.

No speech recognition checkpoint was present during initial setup. `speech:setup` adds `Systran/faster-whisper-base.en` (about 150 MB) to `~/Models/faster-whisper-base.en` and an isolated Python 3.12 runtime in `~/Models/.venvs/mentor-speech`. The download is pinned to revision `3d3d5dee26484f91867d81cb899cfcf72b96be6c`. It uses CPU int8 inference, leaving the GPU for the coach. Synthesis defaults to Kokoro 82M in the shared Python 3.12 environment at `~/Models/.venvs/mentor-chatterbox`. That directory name is retained for compatibility; default setup installs Kokoro and recognition dependencies without downloading Chatterbox. Optional Chatterbox setup adds its pinned NumPy 1.x and Torch/Torchaudio 2.6 dependencies. The shared runtime serves installed macOS, Kokoro, and Chatterbox engines without restarting between Settings choices, reusing the same local Whisper checkpoint.

These choices were checked against the [faster-whisper API](https://github.com/SYSTRAN/faster-whisper), the [Bonsai model card](https://huggingface.co/Youssofal/Ternary-Bonsai-2-27B-MTPLX-Optimized-Speed), and the installed MTPLX and llama.cpp CLIs. The MLX checkpoints cannot be loaded directly by llama.cpp; the cached Gemma GGUF is a separate compatible model.

## Start the app

Default setup downloads recognition and approximately 354 MB of Kokoro model and voice assets, plus their dependencies. Optional Chatterbox setup downloads approximately 3.21 GB of model assets plus its Python dependencies. Model and source revisions are pinned in the setup scripts.

Prerequisites: Docker, the Supabase CLI, Node.js 22+, `uv`, `ffmpeg`, macOS `say`, and either the cached Gemma model with `llama-server` or the inspected Bonsai model with MTPLX. On this machine those prerequisites were already installed. Each process below stays in its terminal; stop it with Ctrl-C.

```bash
npm install
cp .env.example .env.local
npm run speech:setup
npm run speech:setup:kokoro
```

Start the local database and all three app/audio services with one command:

```bash
npm run dev:local
```

The launcher first runs `npm run db:start` to configure a separate local Mentor database. It remains running after the voice supervisor stops. The supervisor checks loopback endpoints, reuses healthy services, and starts missing services sequentially. Ctrl-C stops only its own process groups. It does not stop an existing service or a process occupying an unhealthy port. For separate terminals, use:

Terminal 1:

```bash
npm run coach:start
```

Terminal 2:

```bash
npm run speech:start
```

Terminal 3:

```bash
npm run dev
```

Open `http://127.0.0.1:3000`, choose a role and scenario, and allow microphone access when starting practice. Model downloads happen only during setup; the launch scripts force offline inference. `GET /api/health` reports each service independently.

The speech setup is idempotent. Its requirements pin PyAV to 15.1.0 because PyAV 19 removed an argument used by faster-whisper 1.2.1; the actual speech round-trip test caught this incompatibility.

## Configuration

Next.js reads these server-side values from `.env.local`:

```dotenv
LOCAL_AI_BASE_URL=http://127.0.0.1:8000/v1
LOCAL_AI_MODEL=mtplx
LOCAL_SPEECH_URL=http://127.0.0.1:8765
```

`LOCAL_AI_MODEL=mtplx` is a compatibility alias accepted by both launch options; it does not identify which checkpoint is loaded. The startup message reports the selected checkpoint; the application health endpoint reports the API alias. The AI SDK uses `createOpenAI().chat()` explicitly; both local runtimes provide Chat Completions. Inference URLs are restricted to loopback addresses. Deploying only Next.js to a remote host cannot reach models on your laptop.

Optional shell variables for the launch scripts:

| Variable                      | Default                                                                                                                                                                                            |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MENTOR_MODELS_DIR`           | `~/Models`                                                                                                                                                                                         |
| `MENTOR_COACH_RUNTIME`        | `auto`: use installed llama.cpp with cached Gemma when available, otherwise MTPLX; accepts `llama`, `mtplx`, or an explicit executable path                                                        |
| `MENTOR_COACH_MODEL`          | Cached Gemma GGUF for llama.cpp; `~/Models/Ternary-Bonsai-2-27B-MTPLX-Optimized-Speed` for MTPLX. An explicit `.gguf` selects llama.cpp in `auto` mode; an explicit model directory selects MTPLX. |
| `MENTOR_LLAMA_SERVER`         | `llama-server` resolved from `PATH`                                                                                                                                                                |
| `MENTOR_COACH_CONTEXT`        | `8192` for llama.cpp; `8192` for MTPLX                                                                                                                                                             |
| `MENTOR_COACH_PORT`           | `8000`                                                                                                                                                                                             |
| `MENTOR_SPEECH_VENV`          | Optional override; otherwise installed `mentor-chatterbox`, then `mentor-speech`, under `~/Models/.venvs`                                                                                          |
| `MENTOR_WHISPER_MODEL`        | `~/Models/faster-whisper-base.en`                                                                                                                                                                  |
| `MENTOR_SPEECH_PORT`          | `8765`                                                                                                                                                                                             |
| `MENTOR_SPEECH_VOICE`         | `Samantha`                                                                                                                                                                                         |
| `MENTOR_SPEECH_PARTNER_VOICE` | `Daniel` (distinct installed English voice for Sam)                                                                                                                                                |

The `MENTOR_SPEECH_VOICE` variables select installed voices for the explicit macOS engine and for Chatterbox's initial synthetic references. Run `say -v '?'` to list them; rerunning setup preserves existing reference WAVs. Chatterbox voice changes use the reference-file variables below. Export shell variables in the terminal running the relevant service; the Python and shell launchers do not read `.env.local`. `dev:local` reads it before starting services. The speech service reports the active engine and `conversationSynthesis` availability in `/health`. If a service port changes, update its Next.js URL too.

To explicitly retain Bonsai, use `MENTOR_COACH_RUNTIME=mtplx npm run dev:local`. To select a different existing GGUF, use `MENTOR_COACH_RUNTIME=llama MENTOR_COACH_MODEL=/absolute/path/to/model.gguf npm run dev:local`. Stop the supervisor that owns the current coach before changing it; the launcher reuses a healthy existing service instead of replacing someone else's process. The llama.cpp option uses one slot, 128-token logical batches, 64-token physical batches, a 256 MiB prompt-cache limit, and reasoning disabled. It runs offline and does not load a vision projector. Longer prompts may need a larger `MENTOR_COACH_CONTEXT`; increasing it also increases memory use.

## Model identity in Settings

All language-generation features currently use `createCoachModel()`: conversations, sample dialogues, scenarios, plans, storytelling tips, Explore suggestions and lessons, lesson discussion, wording improvements, and feedback. `/api/health` retains `coach.model` as the request alias and adds optional `coach.displayName` and `coach.runtime` for Settings. The adapter matches the configured alias in `/v1/models`, then reads validated llama.cpp `/props` or MTPLX `/health` metadata. Only the loaded checkpoint basename reaches the browser; its absolute path is omitted. Missing or mismatched identity metadata does not make a reachable coach unavailable and does not trigger a guessed model name.

## Voice engine selection

Settings offers three choices, stored as the optional `speechProvider` field in the learning profile. The existing local storage, Supabase profile sync, and backup paths retain it. New and older profiles without a choice use **Balanced — Kokoro 82M**. Explicit saved choices remain unchanged. Every app speech request carries the effective provider, and the Next.js proxy also defaults omitted providers to Kokoro, even if an older running service has a different default. Changing Settings requires no server restart. Playback snapshots its provider and cancels when the effective preference changes, preventing mixed voices within a response.

| Choice     | Local engine                           | Main tradeoff                                                         |
| ---------- | -------------------------------------- | --------------------------------------------------------------------- |
| Fast       | Installed macOS speech                 | Fast system voices; proprietary built-in engine                       |
| Balanced   | Kokoro-82M through ONNX Runtime on CPU | Smaller open-source neural model; preset voices, no reference cloning |
| Expressive | Chatterbox Multilingual V3 on MPS      | Multilingual reference-based voice cloning; longer generation time    |

Kokoro's [model weights are Apache-2.0 licensed](https://huggingface.co/hexgrad/Kokoro-82M). Its ONNX model interface follows the [maintainer's local runtime](https://github.com/thewh1teagle/kokoro-onnx). Mentor uses the already-compatible ONNX Runtime directly, avoiding a NumPy upgrade that would conflict with Chatterbox. `npm run speech:setup:kokoro` stages approximately 354 MB of checksum-verified model and voice assets plus local phonemizer dependencies. ONNX Runtime uses the MIT license; the bundled eSpeak NG pronunciation dependency uses GPLv3. Files live at `~/Models/kokoro-82m`, configurable with `MENTOR_KOKORO_MODEL`. Configured Kokoro voices support English and Spanish; unsupported languages fail explicitly. All inference stays local, and no engine silently falls back to another.

The speech health response includes a `providers` map with each engine's availability, voices, languages, supported `personas` (`id`, `name`, and `languages`), model, and device. Top-level synthesis fields describe the server default, while recognition is independent. The UI resolves readiness for the learner's selected engine. The `X-Mentor-Speech-Provider` and `X-Mentor-Speech-Persona` response headers identify the engine and persona that actually produced a WAV. The Next.js proxy verifies explicitly requested identities.

## Random conversation personas

The installed engines expose these persona pools:

| Persona           | macOS                                        | Kokoro English | Chatterbox                 |
| ----------------- | -------------------------------------------- | -------------- | -------------------------- |
| Alex (`alex`)     | configured coach voice (Samantha by default) | `af_heart`     | existing coach reference   |
| Sam (`sam`)       | configured partner voice (Daniel by default) | `am_michael`   | existing partner reference |
| Jordan (`jordan`) | Karen, when installed and distinct           | `af_bella`     | unavailable                |
| Riley (`riley`)   | Moira, when installed and distinct           | `bm_george`    | unavailable                |

Kokoro Alex and Sam also support Spanish using the existing Spanish presets; Jordan and Riley are English-only. macOS personas require installed voices, so health is the authoritative list. No additional Chatterbox references or weights are downloaded for personas.

Homepage dialogues randomly choose two distinct, supported personas before asking the local AI to write their exchange. Playback, visible names, and prompts use that same assignment; replay retains it. Practice chooses one compatible persona when the session starts and saves it in the scenario snapshot. Engine changes cancel playback and retain the session persona; an unsupported persona produces a clear error rather than a different voice. Starting a new conversation selects a compatible persona.

`POST /api/speech` accepts an optional `persona` (`alex`, `sam`, `jordan`, or `riley`). When present, it selects that engine's validated voice mapping. Existing callers that omit it retain the `voice: 'coach' | 'partner'` behavior. Unsupported engine/persona/language combinations return 422; no hosted or alternate-engine fallback is used.

## Chatterbox voices and offline inference

`npm run speech:setup` installs recognition and the configured default engine (Kokoro when unset). `npm run speech:setup:chatterbox` adds or repairs Chatterbox without changing the original speech environment. Chatterbox setup creates ten-second synthetic reference WAVs for Alex and Sam from installed macOS voices. Existing reference files are preserved. Chatterbox generates the actual playback audio, using separate cached conditioning for each speaker.

| Variable                              | Default / behavior                                                             |
| ------------------------------------- | ------------------------------------------------------------------------------ |
| `MENTOR_TTS_PROVIDER`                 | `kokoro`; accepts `chatterbox`, `kokoro`, or `macos` as the underlying service default |
| `MENTOR_CHATTERBOX_VENV`              | `~/Models/.venvs/mentor-chatterbox`                                            |
| `MENTOR_CHATTERBOX_MODEL`             | `~/Models/chatterbox-multilingual-v3`                                          |
| `MENTOR_CHATTERBOX_DEVICE`            | `auto`: MPS when available, otherwise CPU; accepts `mps` or `cpu`              |
| `MENTOR_CHATTERBOX_COACH_REFERENCE`   | `<model>/voices/coach.wav`                                                     |
| `MENTOR_CHATTERBOX_PARTNER_REFERENCE` | `<model>/voices/partner.wav`                                                   |

Set reference paths to separate local PCM WAV recordings, each 3–30 seconds long, to use voice cloning. Restart the speech service after changing references. The HTTP API accepts validated voice/persona identifiers, never arbitrary file paths; Chatterbox supports Alex/coach and Sam/partner. Reference recordings remain local, separate from learner transcripts and backups. English is the app's default speech language; callers can explicitly request any supported language code through `/api/speech`.

The launcher forces `HF_HUB_OFFLINE=1`, `TRANSFORMERS_OFFLINE=1`, and disables Hugging Face telemetry. Chatterbox loads pinned local files with `from_local(..., t3_model='v3')`; setup also stages the Chinese tokenizer helper's Hugging Face cache and a checksum-verified spaCy PKUSEG archive. Both are initialized even for English. The provider checks those assets before importing the tokenizer and sets `PKUSEG_HOME` to the staged cache. The model's watermarking remains enabled. There is no hosted synthesis fallback and no automatic macOS fallback if Chatterbox fails.

The model stays loaded once per speech process. Startup generates and discards a fixed greeting to warm lazy MPS kernels before reporting ready. Synthesis is serialized because voice conditioning is mutable; recognition has its own lock. Browser playback divides complete text into chunks of at most 100 characters and preserves voice identity across them. Only three synthesis requests may be outstanding. Playback cancellation aborts the HTTP request, discards queued work, and stops additional model segments; an already-running neural forward pass completes before releasing the model. Requests have a bounded deadline and report errors rather than returning truncated speech. CPU execution is supported but needs its own latency assessment.

Choose **Fast — macOS** or **Expressive — Chatterbox** in Settings to override Kokoro immediately. `MENTOR_TTS_PROVIDER` can still configure the underlying service and setup scripts; it does not override the app's Kokoro default or an explicit Settings choice. The launcher verifies the service’s configured default and accepts any ready installed engine so another option remains selectable when the default fails. Each engine loads independently; a missing neural engine does not disable macOS or recognition. macOS uses installed English voices and rejects non-English requests.

Official references: [Chatterbox model and languages](https://huggingface.co/ResembleAI/chatterbox), [local multilingual loader](https://github.com/resemble-ai/chatterbox/blob/master/src/chatterbox/mtl_tts.py), and [runtime dependencies](https://github.com/resemble-ai/chatterbox/blob/master/pyproject.toml).

## Conversation and audio pipeline

1. The browser captures microphone audio during active voice practice or homepage/topic voice interactions and visualizes the actual audio amplitude. Rolling complete recording segments are sent to `/api/transcribe`; recognized text appears progressively in the live transcript. Pausing or leaving the active interaction releases the microphone.
2. The speech service decodes each segment locally, filters silence with Silero VAD, and returns text plus word timestamps. This is rolling segment transcription, not a native word-by-word streaming ASR model. It can revise or miss words near segment boundaries; recognition quality depends on microphone quality and accent.
3. At the end of a learner turn, `/api/coach` sends bounded conversation context, role, scenario, and proficiency instructions to the selected local language model through the Vercel AI SDK. Text deltas stream to the transcript as they arrive.
4. Completed coach sentences are synthesized through `/api/speech` and queued for playback. Coach responses are kept short to reduce time to speech. The UI represents listening, thinking, speaking, paused, and error states separately.
5. `/api/feedback` reviews the transcript. The schema validates the result, drops invented quotations, and always leaves pronunciation, vocal confidence, and acoustic fluency unscored because this pipeline does not implement phonetic or prosodic assessment. Grammar, vocabulary, clarity, conciseness, and professionalism scores are informal model estimates. Very short samples remain unscored.

The coach adapts its questions to CEFR level and the learner's answers. It asks for specifics and introduces constraints rather than interrupting every sentence with corrections. Prompt context is bounded to the most recent turns; the saved transcript can be longer. Requests have cancellation signals and timeouts; microphone and audio errors are exposed to the learner.

Homepage conversations use `/api/home-conversation` to generate two alternating turns at a time. A local progression policy uses displayed turns to limit questions, identify explicit agreement and correction cues, and request fresh examples or related angles. Agreement cues preserve the original speaker and proposal; they do not manufacture learner consent. A repetitive or over-questioning draft triggers one fresh-topic generation under the same cancellation signal and 60-second deadline. The direction comes from the selected professional role's subject catalog or a fresh communication angle within the exact selected life-skills topic. If the second draft still fails the progression checks, the endpoint returns a schema-validated, authored two-turn topic bridge with HTTP 200 so playback and generation continue automatically. Rejected drafts never enter history. A topic is remembered only after its first spoken turn is displayed. Actual model/service failures and cancellation retain their existing handling. The prompt and recent-history checks reduce repetition; semantic agreement recognition still depends on the local model.

The main practice area offers three possible replies between the session title and the coach/learner voice visuals. These update using the local coach whenever the conversation is ready for the learner. Generic practice starters remain available while replies load or generation is unavailable. Learners can copy a reply to practice writing, or pause the conversation and play it through the existing local speech service before saying it aloud. Suggestions are examples, not recorded learner speech; only the learner's actual transcript and its improved wording enter session history. Requests are cancelled when the turn changes, the session ends, the page is hidden, or voice/transcription work needs priority.

Each learner turn in the live transcript includes its own “You, refined” wording directly below the original, before the next coach turn. Drafts stream in place, including during coach audio playback once coach text generation finishes. Corrections yield to coach inference and resume afterward; they do not delay the conversation. Pause to play a refinement aloud. Both versions continue to save automatically.

## API contracts

| Endpoint                      | Request                                                                                                                                                                                                               | Success response                                                                                                                                            |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/health`             | None                                                                                                                                                                                                                  | `{ coach: { available, model, local, detail? }, speech: { available, recognition, synthesis, model, local, providers, detail? }, storage: { configured } }` |
| `POST /api/coach`             | `{ scenarioId, roleId, level, scenario?, messages: [{ role: 'user' \| 'assistant', content }] }`                                                                                                                      | Streaming UTF-8 `text/plain`                                                                                                                                |
| `POST /api/reply-suggestions` | Coach request with 1–12 recent messages ending in a coach turn, up to 6,000 characters per message | `{ replies: [{ label, text }] }`, exactly three distinct possible learner replies |
| `POST /api/transcribe`        | Multipart `audio` file, up to 8 MB and 60 seconds                                                                                                                                                                     | `{ text, language, durationSeconds, words: [{ word, start, end }] }`; silence returns empty text                                                            |
| `POST /api/speech`            | `{ text, provider?: 'macos' \| 'kokoro' \| 'chatterbox', voice?: 'coach' \| 'partner', persona?: 'alex' \| 'sam' \| 'jordan' \| 'riley', language?: 'en' \| 'es' \| ... }`, up to 2,400 characters; defaults to coach | Mono PCM `audio/wav`; `X-Mentor-Speech-Provider` identifies the engine                                                                                      |
| `POST /api/feedback`          | Coach request plus `durationSeconds`                                                                                                                                                                                  | `Feedback` from `app/_schema.ts`                                                                                                                            |
| `POST /api/conversation-plan` | `{ topic, roleId, level, selection?, minutes? }`, topic 3–1,000 characters, 5–30 minutes                                                                                                                              | `{ originalTopic, improvedTopic, stages, usefulPhrases, scenario }`, validated before voice practice                                                        |
| `POST /api/storytelling-tip`  | `{ roleId, level, recentTitles? }`, up to 8 recent titles                                                                                                                                                             | `{ id, title, outline: [3 steps], text }`, freshly generated local tip of at most 90 spoken words                                                           |
| `POST /api/demo-conversation` | `{ roleId, level, recentTopics? }`, up to 8 recent topics                                                                                                                                                             | `{ id, topic, turns: [{ speaker: 'alex' \| 'sam', text }] }`, six alternating turns and at most 150 words                                                   |
| `POST /api/home-conversation` | `{ roleId, level, selection?, personas?, speechProvider?, topic?, recentTopics?, history?, earlierContext?, nextSpeaker? }`; displayed turns use `{ id, speaker: 'alex' \| 'sam' \| 'user', text }` | `{ topic, turns: [{ speaker: 'alex' \| 'sam', text }] }`, two alternating turns with question and repetition checks |

Errors return `{ error: string }` with a non-2xx status. Request validation, same-origin checks, bounded payloads, and a loopback-only service connection prevent accidental forwarding to a hosted model. Speech uploads and temporary synthesis files are discarded after processing. The Next.js and Python service do not log transcript contents. MTPLX's own terminal diagnostics may include previews of generated responses; do not record or share those logs if the practice contains sensitive material. No SSD model session cache is enabled by the launcher.

MTPLX combines `choices` and `error` in failed SSE frames; the adapter normalizes these so the AI SDK preserves an insufficient-memory error. Before any coach audio/text output, the server can retry once with shorter recent context and a smaller output limit. Reviews also retry once with a compact prompt on an explicit memory rejection. Neither route substitutes a fabricated reply. Successful reduced-context responses carry `X-Mentor-Context: reduced`; a review that omitted older learner turns identifies that scope in its summary. Recent unrecovered memory issues appear in health details and as actionable request errors.

The optional `scenario` uses `ScenarioSchema` and must match `scenarioId` and the selected role. It carries the active configuration loaded from Supabase. When omitted, the server uses the curated bundled scenario. Feedback provenance and display labels are assigned server-side, and aggregate scores are computed from supported metrics. Rewrites must quote the learner and are rejected if they introduce new quantities or common deadline expressions, including the observed unsupported addition of “by end of day.” The conservative filter can omit a suggested rewrite; it does not change model scores or invent replacement advice.

Persistent profiles, settings, sessions, and progress use the separate application storage layer. In local-only mode those stay in browser storage. Enabling configured Supabase sync sends learning records and transcripts to that Supabase project; audio recordings are never uploaded to Supabase. See the main README for database setup.

## Verification and troubleshooting

```bash
npm test
npm run typecheck
npm run build
"$HOME/Models/.venvs/mentor-chatterbox/bin/python" scripts/test_setup_chatterbox.py
"$HOME/Models/.venvs/mentor-chatterbox/bin/python" scripts/test_chatterbox_synthesis.py
"$HOME/Models/.venvs/mentor-chatterbox/bin/python" scripts/test_setup_kokoro.py
"$HOME/Models/.venvs/mentor-chatterbox/bin/python" scripts/test_kokoro_synthesis.py
"$HOME/Models/.venvs/mentor-chatterbox/bin/python" scripts/test_speech_service.py
"$HOME/Models/.venvs/mentor-chatterbox/bin/python" scripts/test_speech_launcher.py
"$HOME/Models/.venvs/mentor-chatterbox/bin/python" scripts/test_speech.py
node scripts/smoke-chatterbox.mjs
node scripts/smoke-speech-providers.mjs
MENTOR_TEST_PERSONAS=1 node scripts/smoke-speech-providers.mjs
node scripts/smoke-local.mjs
```

The setup, provider, and service boundary tests use fakes to cover offline assets, full-text segmentation, distinct conditioning, input limits, cancellation, queue capacity, and errors without neural inference. `test_speech.py` explicitly tests the retained macOS provider and real Whisper recognition; it also checks recognition compatibility in the new Python environment. `smoke-chatterbox.mjs` requires the running app and Chatterbox service: it generates English with both voices, generates Spanish, validates non-silent 24 kHz PCM, and transcribes an English result through Whisper. `smoke-local.mjs` checks the actual Next.js speech, transcription, streamed coach, and feedback routes. `smoke-speech-providers.mjs` verifies all three providers through Next.js with the same sentence and both voices, checks the provider header and non-silent PCM, and transcribes every result. Set `MENTOR_TEST_PERSONAS=1` for the provider smoke check to exercise every available English persona, assert its response identity, compare distinct audio outputs, and transcribe each result. These checks print measured latencies for that run, not a latency guarantee.

The 2026-10-16 persona check passed all ten installed engine/persona combinations through Next.js: four macOS, four Kokoro, and two Chatterbox. Every identity header matched, each engine produced distinct non-silent voices, and Whisper transcribed each sample exactly. For “Could you please review my code?”, macOS took 0.80–1.37 seconds, Kokoro 0.49–0.60 seconds, and Chatterbox 8.60–9.23 seconds in this run.

The same-day three-provider Next.js check used “Could you please review my code?” for both voices. macOS generated in 0.76–1.13 seconds, Kokoro in 0.46–0.52 seconds, and Chatterbox in 5.96–6.15 seconds. Every WAV had the requested provider identity, non-silent PCM, and an exact Whisper transcription; each engine produced distinct coach and partner audio. These are short warm-request measurements on this Mac, including API overhead, not a promise for every passage or machine.

On 2026-10-16, Kokoro passed CPU inference with Python network connections blocked. Loading took 2.32 seconds; a 58-character English phrase generated in 1.13 seconds for the coach and 1.48 seconds for the partner, producing 3.45 and 4.15 seconds of audio. A Spanish phrase generated in 1.04 seconds, and a 103-character English phrase in 2.01 seconds. Whisper transcribed the first English sample exactly. The adapter uses four CPU threads and no GPU; the shared Python environment passed its dependency consistency check without upgrading Chatterbox’s NumPy or Torch.

On 2026-10-16, Chatterbox V3 on this M3 Pro passed an offline test with network sockets denied: English coach, English partner, and Spanish coach produced finite 24 kHz audio with zero network attempts. Both English samples transcribed exactly through the existing Whisper model. Direct model loading took 13.1 seconds, first voice conditioning 18.6 seconds, and first generation 25.7 seconds. Later direct generations took 9.9–11.9 seconds for 3.5–4.4 seconds of audio. Peak process RSS was 4.46 GiB; this is not a measurement of total Metal memory.

The live Next.js integration also passed English/Spanish synthesis and English recognition. Short warm requests took 6.3–13.4 seconds; a real browser Play test began audio in 7.1 seconds and finished without microphone access or page errors. A 176-character request exceeded the 48-second service deadline. Browser chunks were therefore reduced to 100 characters; the same passage then completed as shorter chunks without losing its final words. One request after the timeout took 32.1 seconds, illustrating that an in-progress model pass can delay the next request. Startup now warms a fixed greeting before readiness. After a clean startup, the complete local pipeline passed: a 96-character standup update synthesized in 19.9 seconds, transcribed in 1.4 seconds, received the first coach text in 1.2 seconds, and produced feedback in 10.3 seconds. These measurements do not imply realtime synthesis: Chatterbox's richer voice generation is slower than the previous macOS engine, which remains explicitly selectable.

The earlier macOS homepage two-speaker check on 2026-10-15 generated two different six-turn conversations through the real local model in 23.6 and 19.4 seconds. All six turns of one conversation synthesized through the running Next.js API in 0.80–1.22 seconds per turn, using distinct Samantha/Daniel PCM output. Browser checks covered speaker-specific animation, transcript timing, cancellation, microphone interruption with automatic topic-plan handoff, and mobile/desktop light and dark layouts. Initial dialogue generation waits for the complete validated plan; subsequent audio is prefetched one turn ahead.

On 2026-10-15, the initial Bonsai local API smoke test passed with an exact transcription of the synthetic standup phrase, a contextual follow-up question, and validated feedback quoting the learner's actual words. One measured run took 1.08 seconds for synthesis, 0.42 seconds for transcription, 4.54 seconds to the first coach text chunk, 5.61 seconds for the complete short reply, and 37.41 seconds for post-session feedback. A browser test with an actual recorded-audio fixture also passed microphone capture, progressive transcription, a contextual reply with sentence playback, persisted feedback, and transcript download; its review used compact recovery and took 35.7 seconds. That browser turn took about 9.5 seconds from final transcription to first coach audio under memory pressure. This is a practical local turn-based voice pipeline; it is not a sub-second full-duplex audio model. The 21 backend unit tests and 5 real speech integration tests passed, including stream-error recovery, browser-origin normalization, and invented-deadline regressions.

- **Model unavailable:** keep `coach:start` running and wait for the server to finish loading. Check `/api/health`.
- **Memory pressure:** run only one large language/image model at a time. The default cached Gemma model needs less memory than Bonsai. For the MTPLX option, the launcher limits the session cache to 512 MB, MLX allocator cache to 256 MB, serial prefill chunks to 128 tokens, and the engine to 12 GiB. Both the scheduler flag and `MTPLX_PREFILL_CHUNK_SIZE` are set: the scheduler flag alone does not constrain the serial generator. The optional extended warmup benchmark is skipped while the basic 16-token check remains enabled. MTPLX's memory safety guard remains enabled; it may still reject a turn if the Mac is heavily compressed. Close unused memory-heavy applications and retry. No existing application is stopped automatically.
- **No microphone:** use localhost or HTTPS, allow access in browser settings, and check the input device. There is no silent cloud recognition fallback.
- **Speech unavailable:** check Settings or `/api/health` for the active synthesis model. Run `npm run speech:setup:chatterbox` or `npm run speech:setup:kokoro` for missing model files, then restart the owning supervisor. Existing installed engines remain selectable in Settings. Confirm configured reference files are readable. For the explicit macOS provider, confirm `say -v '?'` lists your selected voice and `ffmpeg` is installed.
- **Quiet recordings:** move closer to the microphone. Near-silence is filtered rather than sent as a fabricated message.
- **Long first response:** the model warms up on startup and prefills scenario context on the first turn. Subsequent turns may reuse a small local cache. Context length and memory pressure affect latency.
- **A review cannot be generated:** the transcript remains available; retry when the coach is available. No synthetic score is substituted for a model failure.
