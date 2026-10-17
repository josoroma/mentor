#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
MENTOR_MODELS_DIR="${MENTOR_MODELS_DIR:-$HOME/Models}"
MENTOR_CHATTERBOX_VENV="${MENTOR_CHATTERBOX_VENV:-$MENTOR_MODELS_DIR/.venvs/mentor-chatterbox}"
export MENTOR_KOKORO_MODEL="${MENTOR_KOKORO_MODEL:-$MENTOR_MODELS_DIR/kokoro-82m}"
export MENTOR_WHISPER_MODEL="${MENTOR_WHISPER_MODEL:-$MENTOR_MODELS_DIR/faster-whisper-base.en}"

if ! command -v uv >/dev/null 2>&1; then
  echo 'Kokoro setup requires uv.' >&2
  exit 1
fi
if [[ ! -x "$MENTOR_CHATTERBOX_VENV/bin/python" ]]; then
  uv venv --python 3.12 "$MENTOR_CHATTERBOX_VENV"
fi
uv pip install --python "$MENTOR_CHATTERBOX_VENV/bin/python" \
  -r "$SCRIPT_DIR/kokoro-requirements.txt"

# Only setup performs downloads; the runtime opens the exact files below.
HF_HUB_OFFLINE=0 TRANSFORMERS_OFFLINE=0 HF_HUB_DISABLE_XET=1 \
  "$MENTOR_CHATTERBOX_VENV/bin/python" "$SCRIPT_DIR/setup-kokoro.py"

echo "Kokoro-82M ready at $MENTOR_KOKORO_MODEL"
echo "Shared local speech runtime: $MENTOR_CHATTERBOX_VENV/bin/python"
