#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
MENTOR_MODELS_DIR="${MENTOR_MODELS_DIR:-$HOME/Models}"
MENTOR_SPEECH_VENV="${MENTOR_SPEECH_VENV:-$MENTOR_MODELS_DIR/.venvs/mentor-speech}"
MENTOR_WHISPER_MODEL="${MENTOR_WHISPER_MODEL:-$MENTOR_MODELS_DIR/faster-whisper-base.en}"
export MENTOR_TTS_PROVIDER="${MENTOR_TTS_PROVIDER:-kokoro}"

if ! command -v uv >/dev/null 2>&1; then
  echo 'Install uv first: brew install uv' >&2
  exit 1
fi

if [[ ! -x "$MENTOR_SPEECH_VENV/bin/python" ]]; then
  uv venv --python 3.12 "$MENTOR_SPEECH_VENV"
fi
uv pip install --python "$MENTOR_SPEECH_VENV/bin/python" -r "$SCRIPT_DIR/speech-requirements.txt"

# Recognition downloads happen only during setup. Inference uses local_files_only=True.
MENTOR_WHISPER_MODEL="$MENTOR_WHISPER_MODEL" HF_HUB_DISABLE_XET=1 \
  "$MENTOR_SPEECH_VENV/bin/python" - <<'PYTHON'
import os
from huggingface_hub import snapshot_download

path = snapshot_download(
  repo_id='Systran/faster-whisper-base.en',
  revision='3d3d5dee26484f91867d81cb899cfcf72b96be6c',
  local_dir=os.environ['MENTOR_WHISPER_MODEL'],
  allow_patterns=['config.json', 'model.bin', 'tokenizer.json', 'vocabulary.*'],
)
print(f'Local speech model ready: {path}')
PYTHON

if [[ "$MENTOR_TTS_PROVIDER" == 'chatterbox' ]]; then
  bash "$SCRIPT_DIR/setup-chatterbox.sh"
elif [[ "$MENTOR_TTS_PROVIDER" == 'kokoro' ]]; then
  bash "$SCRIPT_DIR/setup-kokoro.sh"
fi

echo 'Speech setup complete. Start it with: npm run speech:start'
