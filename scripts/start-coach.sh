#!/usr/bin/env bash
set -euo pipefail

MENTOR_MODELS_DIR="${MENTOR_MODELS_DIR:-$HOME/Models}"
MENTOR_COACH_RUNTIME="${MENTOR_COACH_RUNTIME:-auto}"
MENTOR_COACH_MODEL="${MENTOR_COACH_MODEL:-}"
MENTOR_LLAMA_SERVER="${MENTOR_LLAMA_SERVER:-$(command -v llama-server || true)}"
MENTOR_HF_CACHE="${HF_HUB_CACHE:-${HF_HOME:-$HOME/.cache/huggingface}/hub}"
MENTOR_SMALL_MODEL=""

# Prefer the existing small checkpoint in Models, then the inspected HF cache.
# This only resolves files already present; neither backend downloads a model.
for candidate in \
  "$MENTOR_MODELS_DIR/gemma-4-E2B-it-UD-Q4_K_XL.gguf" \
  "$MENTOR_MODELS_DIR/gemma-4-E2B-it-GGUF/gemma-4-E2B-it-UD-Q4_K_XL.gguf" \
  "$MENTOR_HF_CACHE"/models--unsloth--gemma-4-E2B-it-GGUF/snapshots/*/gemma-4-E2B-it-UD-Q4_K_XL.gguf; do
  if [[ -f "$candidate" ]]; then
    MENTOR_SMALL_MODEL="$candidate"
    break
  fi
done

if [[ "$MENTOR_COACH_RUNTIME" == auto ]]; then
  if [[ -n "$MENTOR_COACH_MODEL" ]]; then
    if [[ "$MENTOR_COACH_MODEL" == *.gguf ]]; then
      MENTOR_COACH_RUNTIME=llama
    else
      MENTOR_COACH_RUNTIME=mtplx
    fi
  elif [[ -n "$MENTOR_SMALL_MODEL" && -x "$MENTOR_LLAMA_SERVER" ]]; then
    MENTOR_COACH_RUNTIME=llama
  else
    MENTOR_COACH_RUNTIME=mtplx
  fi
fi

export HF_HUB_OFFLINE=1
export TRANSFORMERS_OFFLINE=1

case "$MENTOR_COACH_RUNTIME" in
  llama|llama-server|*/llama-server)
    if [[ "$MENTOR_COACH_RUNTIME" == */* ]]; then
      MENTOR_LLAMA_SERVER="$MENTOR_COACH_RUNTIME"
    fi
    MENTOR_COACH_MODEL="${MENTOR_COACH_MODEL:-$MENTOR_SMALL_MODEL}"
    if [[ ! -x "$MENTOR_LLAMA_SERVER" || ! -f "$MENTOR_COACH_MODEL" ]]; then
      echo 'A local GGUF checkpoint and llama-server are required. Set MENTOR_COACH_MODEL or see docs/local-models.md.' >&2
      exit 1
    fi
    echo "[mentor] Local coach: $(basename "$MENTOR_COACH_MODEL") via llama.cpp." >&2
    exec "$MENTOR_LLAMA_SERVER" \
      --model "$MENTOR_COACH_MODEL" --alias mtplx \
      --host 127.0.0.1 --port "${MENTOR_COACH_PORT:-8000}" \
      --ctx-size "${MENTOR_COACH_CONTEXT:-8192}" --parallel 1 \
      --batch-size 128 --ubatch-size 64 --gpu-layers auto \
      --cache-ram 256 --flash-attn on --reasoning off --no-mmproj --offline
    ;;
  mtplx)
    MENTOR_COACH_RUNTIME="$MENTOR_MODELS_DIR/.venvs/mtplx/bin/mtplx"
    ;;
esac

# An explicit MTPLX executable path remains supported for existing setups.
MENTOR_COACH_MODEL="${MENTOR_COACH_MODEL:-$MENTOR_MODELS_DIR/Ternary-Bonsai-2-27B-MTPLX-Optimized-Speed}"
if [[ ! -x "$MENTOR_COACH_RUNTIME" || ! -d "$MENTOR_COACH_MODEL" ]]; then
  echo 'The Bonsai model or MTPLX runtime is missing. Choose MENTOR_COACH_RUNTIME=llama or see docs/local-models.md.' >&2
  exit 1
fi

echo "[mentor] Local coach: $(basename "$MENTOR_COACH_MODEL") via MTPLX." >&2
# Keep practice sessions from growing the large default cache on a busy laptop.
export MTPLX_SESSION_BANK_MAX_BYTES="${MTPLX_SESSION_BANK_MAX_BYTES:-512M}"
export MTPLX_SESSION_BANK_PER_SESSION_BYTES="${MTPLX_SESSION_BANK_PER_SESSION_BYTES:-512M}"
# The CLI prefill flag configures the scheduler; serial decoding has its own
# generator setting. Pin both so a longer turn cannot allocate a 2048-row batch.
export MTPLX_PREFILL_CHUNK_SIZE="${MTPLX_PREFILL_CHUNK_SIZE:-128}"
export MTPLX_PREFILL_CHUNK_CACHE_CLEANUP=1
export MTPLX_MLX_CACHE_LIMIT="${MTPLX_MLX_CACHE_LIMIT:-256M}"
# Keep the 16-token startup check, but skip the optional 2560-token background
# benchmark that repeatedly exhausted memory on this already busy Mac.
export MTPLX_WARMUP_EXTENDED="${MTPLX_WARMUP_EXTENDED:-0}"
exec "$MENTOR_COACH_RUNTIME" serve \
  --model "$MENTOR_COACH_MODEL" \
  --host 127.0.0.1 --port "${MENTOR_COACH_PORT:-8000}" \
  --depth 1 --context-window "${MENTOR_COACH_CONTEXT:-8192}" --max-tokens 1800 \
  --prefill-chunk-tokens 128 --memory-limit 12G --ssd-session-cache off \
  --default-temperature 1.0 --default-top-p 0.95 --default-top-k 20 \
  --reasoning off
