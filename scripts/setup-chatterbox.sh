#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
MENTOR_MODELS_DIR="${MENTOR_MODELS_DIR:-$HOME/Models}"
MENTOR_CHATTERBOX_VENV="${MENTOR_CHATTERBOX_VENV:-$MENTOR_MODELS_DIR/.venvs/mentor-chatterbox}"
export MENTOR_CHATTERBOX_MODEL="${MENTOR_CHATTERBOX_MODEL:-$MENTOR_MODELS_DIR/chatterbox-multilingual-v3}"
export MENTOR_WHISPER_MODEL="${MENTOR_WHISPER_MODEL:-$MENTOR_MODELS_DIR/faster-whisper-base.en}"

for command_name in uv say ffmpeg; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "Chatterbox setup requires $command_name on this Mac." >&2
    exit 1
  fi
done

if [[ ! -x "$MENTOR_CHATTERBOX_VENV/bin/python" ]]; then
  uv venv --python 3.12 "$MENTOR_CHATTERBOX_VENV"
fi
uv pip install --python "$MENTOR_CHATTERBOX_VENV/bin/python" \
  --override "$SCRIPT_DIR/chatterbox-overrides.txt" \
  -r "$SCRIPT_DIR/chatterbox-requirements.txt"

# Downloads are limited to setup. The speech service must use from_local with
# HF_HUB_OFFLINE=1 and TRANSFORMERS_OFFLINE=1 during inference.
HF_HUB_OFFLINE=0 TRANSFORMERS_OFFLINE=0 HF_HUB_DISABLE_XET=1 \
  "$MENTOR_CHATTERBOX_VENV/bin/python" "$SCRIPT_DIR/setup-chatterbox.py"

echo "Chatterbox Multilingual V3 ready at $MENTOR_CHATTERBOX_MODEL"
echo "Isolated runtime: $MENTOR_CHATTERBOX_VENV/bin/python"
