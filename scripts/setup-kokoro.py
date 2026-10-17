"""Stage and verify pinned Kokoro ONNX, voice, and vocabulary assets."""

import hashlib
import os
import tempfile
import urllib.request
from pathlib import Path


MODEL_REVISION = 'f3ff3571791e39611d31c381e3a41a3af07b4987'
EXPORT_BASE = 'https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0'
ASSETS = (
  (
    'kokoro-v1.0.onnx', f'{EXPORT_BASE}/kokoro-v1.0.onnx',
    '7d5df8ecf7d4b1878015a32686053fd0eebe2bc377234608764cc0ef3636a6c5',
  ),
  (
    'voices-v1.0.bin', f'{EXPORT_BASE}/voices-v1.0.bin',
    'bca610b8308e8d99f32e6fe4197e7ec01679264efed0cac9140fe9c29f1fbf7d',
  ),
  (
    'config.json', f'https://huggingface.co/hexgrad/Kokoro-82M/resolve/{MODEL_REVISION}/config.json',
    '5abb01e2403b072bf03d04fde160443e209d7a0dad49a423be15196b9b43c17f',
  ),
)
MODEL_PATH = Path(os.getenv('MENTOR_KOKORO_MODEL', str(Path.home() / 'Models' / 'kokoro-82m'))).expanduser()
WHISPER_PATH = Path(os.getenv('MENTOR_WHISPER_MODEL', str(Path.home() / 'Models' / 'faster-whisper-base.en'))).expanduser()


def file_digest(path: Path) -> str:
  digest = hashlib.sha256()
  with path.open('rb') as source:
    while block := source.read(1024 * 1024):
      digest.update(block)
  return digest.hexdigest()


def stage_asset(filename: str, url: str, expected_digest: str) -> None:
  MODEL_PATH.mkdir(parents=True, exist_ok=True)
  target = MODEL_PATH / filename
  if target.is_file() and file_digest(target) == expected_digest:
    return
  temporary_path = None
  try:
    with tempfile.NamedTemporaryFile(dir=MODEL_PATH, prefix=f'.{filename}.', delete=False) as destination:
      temporary_path = Path(destination.name)
      with urllib.request.urlopen(url, timeout=60) as source:
        while block := source.read(1024 * 1024):
          destination.write(block)
    if file_digest(temporary_path) != expected_digest:
      raise ValueError(f'Kokoro asset checksum failed: {filename}')
    temporary_path.replace(target)
  finally:
    if temporary_path is not None:
      temporary_path.unlink(missing_ok=True)


def stage_models() -> None:
  for filename, url, digest in ASSETS:
    stage_asset(filename, url, digest)
  if not (WHISPER_PATH / 'model.bin').is_file():
    from huggingface_hub import snapshot_download

    snapshot_download(
      repo_id='Systran/faster-whisper-base.en',
      revision='3d3d5dee26484f91867d81cb899cfcf72b96be6c',
      local_dir=str(WHISPER_PATH),
      allow_patterns=['config.json', 'model.bin', 'tokenizer.json', 'vocabulary.*'],
    )


if __name__ == '__main__':
  stage_models()
