<p align="center">
  <img src="docs/diagrams/mentor-logo.svg" alt="mentor." width="260" />
</p>

# Run Mentor's small language model locally

[Product overview](README.md) · [App configuration](README-CONFIG.md) · **Local SLM setup**

Mentor uses **Gemma 4 E2B**, an instruction-tuned language model, through **llama.cpp** on this Mac. It powers conversations, personalized scenarios, Explore lessons, improved English, and feedback. Speech recognition and voice playback use separate local models.

This guide records the installed model and the commands Mentor's scripts run, then provides commands to reproduce the setup. **Gemma and llama.cpp were already installed when Mentor was configured.** The original download/install commands were not recorded; the fresh-install steps below explain how to recreate the setup. See the [original setup record](docs/local-models.md#inspected-models-and-compatibility).

## Table of contents

- [The model we use](#the-model-we-use)
- [Install the tools](#install-the-tools)
- [Download and verify the model](#download-and-verify-the-model)
- [Set up Mentor and speech](#set-up-mentor-and-speech)
- [Start local inference](#start-local-inference)
- [Test the installation](#test-the-installation)
- [Troubleshooting](#troubleshooting)
- [Related documentation](#related-documentation)

## The model we use

| Item | Installed setup |
| --- | --- |
| Model | Google Gemma 4 E2B, instruction-tuned |
| GGUF distribution | [Unsloth — gemma-4-E2B-it-GGUF](https://huggingface.co/unsloth/gemma-4-E2B-it-GGUF) |
| File | `gemma-4-E2B-it-UD-Q4_K_XL.gguf` |
| Quantization | `UD-Q4_K_XL` |
| Pinned model revision | `90f9618340396838ee7ff5b0ba2da27da62953d3` |
| Download size | 3,184,494,720 bytes — approximately 3.18 GB / 2.97 GiB |
| Inspected runtime | Homebrew `llama.cpp` build **9310**, commit `e2ef8fe42ccef597bfeab901dd6e39589613b71e` |
| Mentor context / concurrency | 8,192 tokens / one inference slot |
| Coach address | `http://127.0.0.1:8000/v1` |
| API model name | `mtplx` — a compatibility alias, not the checkpoint name |

The [model repository](https://huggingface.co/unsloth/gemma-4-E2B-it-GGUF) contains other quantizations. Use the filename and revision above to match this installation. Mentor runs this checkpoint in **text-only mode** with `--no-mmproj`; Whisper handles incoming speech and the selected voice engine handles audio output.

The inspected machine is an Apple Silicon Mac with 36 GiB of unified memory. That is the recorded development setup, not a measured minimum requirement. Model weights, runtime buffers, speech engines, Docker, and the app all consume additional memory.

## Install the tools

The complete app requires **macOS on Apple Silicon, Node.js 22+, Docker running, and the Supabase CLI**. See [Run locally](README.md#run-locally) and the [database guide](supabase/README.md) for the app/database prerequisites. The commands below assume Homebrew is installed.

Install the language runtime and speech setup tools:

```bash
brew install llama.cpp uv ffmpeg
```

Homebrew provides `llama-server` through the [llama.cpp formula](https://formulae.brew.sh/formula/llama.cpp). A fresh install gets Homebrew's current release; it does **not** pin the observed build 9310. The runtime must support the `gemma4` architecture and the [launcher flags](scripts/start-coach.sh).

If `hf` is not already installed, install the Hugging Face CLI in an isolated tool environment:

```bash
uv tool install huggingface_hub
uv tool update-shell
```

Open a new terminal if `uv` reports a PATH update. This uses [uv's tool installation](https://docs.astral.sh/uv/guides/tools/) for the package that provides the [Hugging Face `hf` CLI](https://huggingface.co/docs/huggingface_hub/guides/cli).

Check the commands are available:

```bash
node --version
llama-server --version
uv --version
ffmpeg -version
hf --help
docker info
supabase --version
```

## Download and verify the model

Download this **single GGUF file** from the [pinned Unsloth revision](https://huggingface.co/unsloth/gemma-4-E2B-it-GGUF/blob/90f9618340396838ee7ff5b0ba2da27da62953d3/gemma-4-E2B-it-UD-Q4_K_XL.gguf). The command uses Hugging Face's documented [revision and local-directory options](https://huggingface.co/docs/huggingface_hub/guides/cli#hf-download):

```bash
mkdir -p "$HOME/Models"

hf download unsloth/gemma-4-E2B-it-GGUF \
  gemma-4-E2B-it-UD-Q4_K_XL.gguf \
  --revision 90f9618340396838ee7ff5b0ba2da27da62953d3 \
  --local-dir "$HOME/Models"
```

This needs internet access and roughly 3.18 GB for the weights. It does not download every quantization or a multimodal projector. Check the downloaded file:

```bash
shasum -a 256 "$HOME/Models/gemma-4-E2B-it-UD-Q4_K_XL.gguf"
```

Expected SHA-256:

```text
b8906b8c5e05e57b657646bbc657bd35814a269b2c20f0a2579047fafa1a67dd
```

This checksum matches both the local cached weights and the [upstream file metadata at the pinned revision](https://huggingface.co/api/models/unsloth/gemma-4-E2B-it-GGUF/revision/90f9618340396838ee7ff5b0ba2da27da62953d3?blobs=true), checked on October 17, 2026.

### Already have the cached model?

Skip the download. Mentor's [coach launcher](scripts/start-coach.sh) searches these locations in order:

1. `~/Models/gemma-4-E2B-it-UD-Q4_K_XL.gguf`
2. `~/Models/gemma-4-E2B-it-GGUF/gemma-4-E2B-it-UD-Q4_K_XL.gguf`
3. Hugging Face cache snapshots for `unsloth/gemma-4-E2B-it-GGUF`.

The inspected installation uses:

```text
~/.cache/huggingface/hub/models--unsloth--gemma-4-E2B-it-GGUF/snapshots/90f9618340396838ee7ff5b0ba2da27da62953d3/gemma-4-E2B-it-UD-Q4_K_XL.gguf
```

The cache lookup respects `HF_HUB_CACHE` or `HF_HOME`. To select an exact file elsewhere, export its absolute path as `MENTOR_COACH_MODEL`. The launcher only reads existing files; it never downloads weights at startup.

## Set up Mentor and speech

Run these commands from the Mentor repository. Copy the example environment only on first setup, preserving an existing `.env.local`:

```bash
npm install

if [ ! -f .env.local ]; then
  cp .env.example .env.local
fi

MENTOR_TTS_PROVIDER=kokoro npm run speech:setup
```

With Kokoro selected above, `speech:setup` uses `uv` to create Python 3.12 environments, installs the speech dependencies, and downloads **both recognition and Kokoro playback assets**. Kokoro is also the default when `MENTOR_TTS_PROVIDER` is unset. Gemma is downloaded separately in the preceding step.

| Component | Download / purpose | Setup command |
| --- | --- | --- |
| Speech recognition | `Systran/faster-whisper-base.en`, pinned at `3d3d5dee26484f91867d81cb899cfcf72b96be6c`; about 150 MB. Converts recorded speech into text. | Included in `npm run speech:setup` |
| Balanced voice | Kokoro-82M ONNX model and preset voices; about 354 MB of assets. Reads partner replies and improved English aloud. | Included in `speech:setup`; repeat `npm run speech:setup:kokoro` for setup/repair |
| Fast voice | Installed macOS voices through `say`. | No neural model download |
| Expressive voice, optional | Chatterbox; about 3.21 GB of model assets plus dependencies. | `npm run speech:setup:chatterbox` |

Exact speech sources, revisions, and checksum checks live in [`setup-speech.sh`](scripts/setup-speech.sh), [`setup-kokoro.py`](scripts/setup-kokoro.py), and [`setup-chatterbox.py`](scripts/setup-chatterbox.py). Kokoro shares the historically named `~/Models/.venvs/mentor-chatterbox` environment; that directory name does not mean Chatterbox was downloaded by the default setup.

Keep these values in `.env.local`:

```dotenv
LOCAL_AI_BASE_URL=http://127.0.0.1:8000/v1
LOCAL_AI_MODEL=mtplx
LOCAL_SPEECH_URL=http://127.0.0.1:8765
MENTOR_TTS_PROVIDER=kokoro
```

`LOCAL_AI_MODEL=mtplx` matches the server's `--alias mtplx`. The real model filename appears in **Settings → Models behind Mentor**. No paid AI API key is needed. Inference stays on loopback addresses; raw audio is processed locally and discarded. For transcript storage and hosted-sync opt-in, see the [configuration guide](README-CONFIG.md#check-speech-and-learning-history).

## Start local inference

From the repository, with Docker running:

```bash
MENTOR_COACH_RUNTIME=llama npm run dev:local
```

This explicitly selects llama.cpp, using the model lookup above. The supervisor loads `.env.local`, configures local Supabase and migrations, then starts or reuses the coach, speech service, and Next.js. Open **http://127.0.0.1:3000** and follow the [Settings walkthrough](README-CONFIG.md).

To use a specific downloaded file:

```bash
MENTOR_COACH_RUNTIME=llama \
MENTOR_COACH_MODEL="$HOME/Models/gemma-4-E2B-it-UD-Q4_K_XL.gguf" \
npm run dev:local
```

A healthy existing coach is reused. Changing model variables does not replace that running process: stop the coach or supervisor you previously launched, then restart with the new selection. Ctrl-C stops only processes started by that supervisor; local Supabase remains running. `npm run db:stop` stops the database while retaining its data.

### Run only the coach

For model debugging without starting the rest of Mentor:

```bash
MENTOR_COACH_RUNTIME=llama npm run coach:start
```

Unlike `dev:local`, this shell launcher does not read `.env.local`; export overrides in the terminal. The app can connect to this running coach when started later.

<details>
<summary>The llama-server command Mentor runs</summary>

The following matches [`scripts/start-coach.sh`](scripts/start-coach.sh) with its default settings and the fresh-download path. Use it instead of `coach:start`, with port 8000 free:

```bash
export HF_HUB_OFFLINE=1
export TRANSFORMERS_OFFLINE=1

llama-server \
  --model "$HOME/Models/gemma-4-E2B-it-UD-Q4_K_XL.gguf" \
  --alias mtplx \
  --host 127.0.0.1 --port 8000 \
  --ctx-size 8192 --parallel 1 \
  --batch-size 128 --ubatch-size 64 --gpu-layers auto \
  --cache-ram 256 --flash-attn on \
  --reasoning off --no-mmproj --offline
```

These settings bound context and concurrency, enable automatic GPU offload, and keep loading offline. The launcher also supports `MENTOR_COACH_CONTEXT`, `MENTOR_COACH_PORT`, and `MENTOR_LLAMA_SERVER`. If changing the port, update `LOCAL_AI_BASE_URL` to match. Leave offline variables scoped to the runtime terminal; first-time downloads need network access.

</details>

## Test the installation

### 1. Check availability and model identity

With the coach and app running, use another terminal:

```bash
curl --fail --silent --show-error http://127.0.0.1:8000/health
curl --fail --silent --show-error http://127.0.0.1:8000/v1/models
curl --fail --silent --show-error http://127.0.0.1:3000/api/health
```

The coach health response should contain `"status":"ok"`. `/v1/models` should list `mtplx`. The app health response should report `coach.available: true`, `coach.runtime: "llama.cpp"`, and `coach.displayName: "gemma-4-E2B-it-UD-Q4_K_XL.gguf"`, plus speech availability. These checks passed on the inspected installation on October 17, 2026; they check readiness, not generated-answer quality.

### 2. Generate a real answer

This sends a short request directly to the local model:

```bash
curl --fail --silent --show-error \
  http://127.0.0.1:8000/v1/chat/completions \
  --header 'Content-Type: application/json' \
  --data '{
    "model": "mtplx",
    "messages": [
      {"role": "user", "content": "Explain git rebase in two short sentences for an English learner."}
    ],
    "max_tokens": 120,
    "stream": false
  }'
```

Look for a nonempty `choices[0].message.content`. This exact command returned a nonempty answer on the inspected installation on October 17, 2026. Wording and latency vary; check the content for accuracy as well as successful generation.

### 3. Exercise Mentor's voice and coaching APIs

With `dev:local` running and the default Kokoro setup complete:

```bash
node scripts/smoke-local.mjs
```

This performs real **speech synthesis → Whisper transcription → streaming coach response → feedback**. It also checks malformed-request rejection and verifies that pronunciation remains unscored. A successful run prints `"passed": true` with measured timings. Set `MENTOR_APP_URL` to another loopback app URL if needed. This script does not test browser microphone permission or UI interaction; try a spoken Practice session separately.

For all three installed voice engines, including optional Chatterbox:

```bash
node scripts/smoke-speech-providers.mjs

# Extended check: every supported English conversation persona.
MENTOR_TEST_PERSONAS=1 node scripts/smoke-speech-providers.mjs
```

These provider checks require **macOS voices, Kokoro, and Chatterbox** to be ready; they are not required for a default Kokoro-only installation. Previous real-service test results and their model/hardware context are recorded in [local model validation](docs/local-models.md#verification-and-troubleshooting). Those historical results are separate from the checksum, readiness, and direct-completion checks made for this guide.

### 4. Validate the application

```bash
npm run typecheck
npm test
npm run build
```

These check types, automated behavior, and the production build. They do not replace the real inference and speech checks above.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| `llama-server` not found | Run `command -v llama-server` and check the Homebrew installation/PATH. For another binary, export `MENTOR_LLAMA_SERVER=/absolute/path/to/llama-server`. |
| Unsupported `gemma4` architecture or unknown flag | Check `llama-server --version` and `--help`. The inspected compatible runtime is build 9310. Install a compatible llama.cpp build; [upstream build instructions](https://github.com/ggml-org/llama.cpp/blob/master/docs/build.md) cover source builds. |
| Missing GGUF / unexpected Bonsai error | Verify the file path and checksum, then select `MENTOR_COACH_RUNTIME=llama` with `MENTOR_COACH_MODEL`. Automatic selection can use an existing MTPLX/Bonsai setup when Gemma is absent; it does not fetch a replacement. |
| Model name appears as `mtplx` | This is expected for `/v1/models`. Use the app's `/api/health` or Settings to inspect the actual checkpoint. |
| Port occupied or old model still running | Check the service already on port 8000. Stop only the process you own before restarting; `dev:local` reuses healthy services and does not kill unrelated processes. |
| Coach ready, speech unavailable | Complete `npm run speech:setup`, restart the speech service you launched, and use **Settings → Check connections**. |
| Startup stops at the database step | Ensure Docker and the Supabase CLI are available. Run `npm run db:start` and inspect its error; Explore needs the configured learning database. |
| Slow generation or memory pressure | Close other model jobs, use one coach process, and keep the default one-slot/8,192-token configuration. Response time depends on the machine and request size. |

## Related documentation

- [README.md — product pitch, screenshots, interaction flows, and stack](README.md)
- [README-CONFIG.md — learning focus, voice engines, model status, and privacy](README-CONFIG.md)
- [Local models — detailed runtime options, speech configuration, and validation records](docs/local-models.md)
- [Database guide — local Supabase and learning-data persistence](supabase/README.md)
