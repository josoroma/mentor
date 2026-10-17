#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
MENTOR_MODELS_DIR="${MENTOR_MODELS_DIR:-$HOME/Models}"
export MENTOR_TTS_PROVIDER="${MENTOR_TTS_PROVIDER:-kokoro}"

case "$MENTOR_TTS_PROVIDER" in
  chatterbox|kokoro|macos) ;;
  *)
    echo 'MENTOR_TTS_PROVIDER must be chatterbox, kokoro, or macos.' >&2
    exit 1
    ;;
esac

# All installed choices share one service, even when its default is system speech.
# A recognition-only installation can still offer macOS without neural packages.
NEURAL_SPEECH_VENV="${MENTOR_CHATTERBOX_VENV:-$MENTOR_MODELS_DIR/.venvs/mentor-chatterbox}"
if [[ -x "$NEURAL_SPEECH_VENV/bin/python" ]]; then
  MENTOR_SPEECH_VENV="${MENTOR_SPEECH_VENV:-$NEURAL_SPEECH_VENV}"
else
  MENTOR_SPEECH_VENV="${MENTOR_SPEECH_VENV:-$MENTOR_MODELS_DIR/.venvs/mentor-speech}"
fi

if [[ ! -x "$MENTOR_SPEECH_VENV/bin/python" ]]; then
  echo 'Speech runtime is missing. Run npm run speech:setup first.' >&2
  exit 1
fi

export MENTOR_WHISPER_MODEL="${MENTOR_WHISPER_MODEL:-$MENTOR_MODELS_DIR/faster-whisper-base.en}"
export MENTOR_CHATTERBOX_MODEL="${MENTOR_CHATTERBOX_MODEL:-$MENTOR_MODELS_DIR/chatterbox-multilingual-v3}"
export MENTOR_KOKORO_MODEL="${MENTOR_KOKORO_MODEL:-$MENTOR_MODELS_DIR/kokoro-82m}"
export PYTORCH_ENABLE_MPS_FALLBACK=1
export HF_HUB_OFFLINE=1
export TRANSFORMERS_OFFLINE=1
export HF_HUB_DISABLE_TELEMETRY=1
export TOKENIZERS_PARALLELISM=false
exec "$MENTOR_SPEECH_VENV/bin/python" -m uvicorn speech_server:app \
  --app-dir "$SCRIPT_DIR" --host 127.0.0.1 --port "${MENTOR_SPEECH_PORT:-8765}"
