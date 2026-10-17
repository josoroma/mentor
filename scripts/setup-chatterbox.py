"""Stage pinned local TTS assets and synthetic reference voices; no inference."""

import hashlib
import os
import re
import subprocess
import tempfile
import urllib.request
import zipfile
from pathlib import Path

from huggingface_hub import hf_hub_download, snapshot_download


MODEL_REPO = 'ResembleAI/chatterbox'
MODEL_REVISION = '5bb1f6ee58e50c3b8d408bc82a6d3740c2db6e18'
MODEL_FILES = [
  've.pt',
  't3_mtl23ls_v3.safetensors',
  's3gen.pt',
  'grapheme_mtl_merged_expanded_v1.json',
  'conds.pt',
  'Cangjie5_TC.json',
]
MODEL_PATH = Path(os.environ['MENTOR_CHATTERBOX_MODEL']).expanduser().resolve()
WHISPER_PATH = Path(os.environ['MENTOR_WHISPER_MODEL']).expanduser().resolve()
PKUSEG_URL = 'https://github.com/explosion/spacy-pkuseg/releases/download/v0.0.26/spacy_ontonotes.zip'
PKUSEG_SHA256 = 'b216e7f92de7ae285aeab8feba2faa8ea8216e5995ff6fb3d391cc8356db1bfe'


def resolve_reference_voice(name, installed):
  if name in installed:
    return name
  matches = {voice for voice in installed if voice.startswith(f'{name} (')}
  if len(matches) == 1:
    return matches.pop()
  raise ValueError(f'The configured reference voice {name!r} is unavailable or ambiguous.')


def reference_voice_names():
  listing = subprocess.run(
    ['say', '-v', '?'], check=True, capture_output=True, text=True, timeout=10,
  )
  installed = {
    match.group(1).strip()
    for line in listing.stdout.splitlines()
    if (match := re.match(r'^(.*?)\s+en_[A-Z]+\s+#', line))
  }
  coach = resolve_reference_voice(os.getenv('MENTOR_SPEECH_VOICE', 'Samantha'), installed)
  partner = resolve_reference_voice(
    os.getenv('MENTOR_SPEECH_PARTNER_VOICE', os.getenv('MENTOR_TTS_PARTNER_VOICE', 'Daniel')),
    installed,
  )
  if coach == partner:
    raise ValueError('Choose distinct installed coach and partner reference voices.')
  return coach, partner


def stage_models():
  snapshot_download(
    repo_id=MODEL_REPO,
    revision=MODEL_REVISION,
    local_dir=str(MODEL_PATH),
    allow_patterns=MODEL_FILES,
  )
  # MTLTokenizer's Chinese helper uses cache_dir=checkpoint_dir and revision=main
  # internally, even for English. Stage its standard HF cache and point main at
  # our pinned snapshot so loading is complete with HF_HUB_OFFLINE=1.
  hf_hub_download(
    repo_id=MODEL_REPO,
    filename='Cangjie5_TC.json',
    revision=MODEL_REVISION,
    cache_dir=str(MODEL_PATH),
  )
  cache_ref = MODEL_PATH / 'models--ResembleAI--chatterbox' / 'refs' / 'main'
  cache_ref.parent.mkdir(parents=True, exist_ok=True)
  cache_ref.write_text(MODEL_REVISION, encoding='utf-8')

  if not (WHISPER_PATH / 'model.bin').is_file():
    snapshot_download(
      repo_id='Systran/faster-whisper-base.en',
      revision='3d3d5dee26484f91867d81cb899cfcf72b96be6c',
      local_dir=str(WHISPER_PATH),
      allow_patterns=['config.json', 'model.bin', 'tokenizer.json', 'vocabulary.*'],
    )


def stage_pkuseg():
  # The official multilingual tokenizer eagerly constructs this segmenter.
  # Its upstream downloader is independent of HF_HUB_OFFLINE, so prepare its
  # complete verified cache here; runtime sets PKUSEG_HOME to this directory.
  cache = MODEL_PATH / 'pkuseg'
  cache.mkdir(parents=True, exist_ok=True)
  archive = cache / 'spacy_ontonotes.zip'
  valid_cache = False
  if archive.is_file():
    with archive.open('rb') as cached:
      valid_cache = hashlib.file_digest(cached, 'sha256').hexdigest() == PKUSEG_SHA256
  if not valid_cache:
    with tempfile.NamedTemporaryFile(dir=cache, suffix='.download', delete=False) as staged:
      temporary_path = Path(staged.name)
      try:
        with urllib.request.urlopen(PKUSEG_URL, timeout=90) as response:
          while chunk := response.read(1024 * 1024):
            staged.write(chunk)
        staged.close()
        with temporary_path.open('rb') as downloaded:
          if hashlib.file_digest(downloaded, 'sha256').hexdigest() != PKUSEG_SHA256:
            raise ValueError('The Chinese segmenter archive did not match its pinned checksum.')
        temporary_path.replace(archive)
      finally:
        temporary_path.unlink(missing_ok=True)
  target = cache / 'spacy_ontonotes'
  target.mkdir(exist_ok=True)
  with zipfile.ZipFile(archive) as source:
    for member in source.infolist():
      if not (target / member.filename).resolve().is_relative_to(target.resolve()):
        raise ValueError('The Chinese segmenter archive contains an invalid path.')
    source.extractall(target)


def stage_reference_voice(name, destination):
  # Existing administrator-supplied references are preserved. These defaults
  # come from installed synthetic voices, never a learner's recording.
  if destination.is_file():
    return
  text = (
    'Hello, and welcome. Let us practice a clear, thoughtful conversation together. '
    'Take your time, share your ideas, and explain what matters most to you.'
  )
  destination.parent.mkdir(parents=True, exist_ok=True)
  with tempfile.TemporaryDirectory(prefix='mentor-chatterbox-reference-') as temporary:
    directory = Path(temporary)
    source = directory / 'voice.aiff'
    output = directory / 'reference.wav'
    script = directory / 'reference.txt'
    script.write_text(text, encoding='utf-8')
    subprocess.run(
      ['say', '-v', name, '-r', '180', '-o', str(source), '-f', str(script)],
      check=True, capture_output=True, timeout=30,
    )
    subprocess.run(
      ['ffmpeg', '-nostdin', '-v', 'error', '-i', str(source),
       '-af', 'apad,atrim=duration=10', '-ar', '24000', '-ac', '1',
       '-c:a', 'pcm_s16le', str(output)],
      check=True, capture_output=True, timeout=15,
    )
    # Replace atomically on the destination filesystem so setup can be retried.
    with tempfile.NamedTemporaryFile(dir=destination.parent, suffix='.wav', delete=False) as staged:
      temporary_path = Path(staged.name)
      staged.write(output.read_bytes())
    try:
      temporary_path.replace(destination)
    finally:
      temporary_path.unlink(missing_ok=True)


if __name__ == '__main__':
  coach_voice, partner_voice = reference_voice_names()
  stage_models()
  stage_pkuseg()
  stage_reference_voice(coach_voice, MODEL_PATH / 'voices' / 'coach.wav')
  stage_reference_voice(partner_voice, MODEL_PATH / 'voices' / 'partner.wav')
  (MODEL_PATH / 'mentor-model-revision.txt').write_text(
    f'{MODEL_REPO}\n{MODEL_REVISION}\n', encoding='utf-8',
  )
  print(f'Offline model files and synthetic coach/partner references ready: {MODEL_PATH}')
