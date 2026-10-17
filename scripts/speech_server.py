"""Loopback-only speech service. Audio is processed locally and never retained."""

import asyncio
import io
import logging
import os
import re
import shutil
import subprocess
import tempfile
import threading
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Literal

import numpy as np
from fastapi import FastAPI, File, HTTPException, Request, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import Response
from faster_whisper import WhisperModel
from faster_whisper.audio import decode_audio
from pydantic import BaseModel, ConfigDict, Field
from chatterbox_synthesis import SynthesisError
from speech_personas import LEGACY_PERSONAS, PERSONA_NAMES, persona_metadata


logger = logging.getLogger('mentor.speech')
MODEL_PATH = Path(os.getenv('MENTOR_WHISPER_MODEL', '~/Models/faster-whisper-base.en')).expanduser()
MAX_AUDIO_BYTES = 8 * 1024 * 1024
MAX_AUDIO_SECONDS = 60
SAMPLE_RATE = 16000
TTS_PROVIDER = os.getenv('MENTOR_TTS_PROVIDER', 'kokoro')
VOICE = os.getenv('MENTOR_SPEECH_VOICE', 'Samantha')
PARTNER_VOICE = os.getenv('MENTOR_SPEECH_PARTNER_VOICE', os.getenv('MENTOR_TTS_PARTNER_VOICE', 'Daniel'))
voices = {}
persona_voices = {}
voice_errors = {}
model = None
model_error = None
model_lock = threading.Lock()
synthesis_lock = threading.Lock()
synthesis_slots = threading.BoundedSemaphore(3)
SYNTHESIS_TIMEOUT = 48
synthesizers = {}
synthesis_errors = {}
NEURAL_MODELS = {
  'kokoro': 'Kokoro 82M',
  'chatterbox': 'Chatterbox Multilingual V3',
}


def resolve_installed_voice(name: str, installed: set[str]):
  if name in installed:
    return name
  # macOS lists some familiar short names with an English locale suffix.
  matches = {voice for voice in installed if voice.startswith(f'{name} (')}
  if len(matches) == 1:
    return matches.pop()
  raise ValueError('The configured English voice is not installed or is ambiguous.')


def load_voices():
  voices.clear()
  persona_voices.clear()
  voice_errors.clear()
  try:
    listing = subprocess.run(['say', '-v', '?'], check=True, capture_output=True, text=True, timeout=10)
    installed = {
      match.group(1).strip()
      for line in listing.stdout.splitlines()
      if (match := re.match(r'^(.*?)\s+en_[A-Z]+\s+#', line))
    }
  except (OSError, subprocess.CalledProcessError, subprocess.TimeoutExpired):
    voice_errors.update({key: 'Installed macOS voices could not be checked.' for key in ('coach', 'partner')})
    return

  for key, configured in (('coach', VOICE), ('partner', PARTNER_VOICE)):
    try:
      voices[key] = resolve_installed_voice(configured, installed)
    except ValueError:
      voice_errors[key] = f'The configured {key} voice is not an installed English macOS voice.'
  if voices.get('partner') and voices.get('partner') == voices.get('coach'):
    del voices['partner']
    voice_errors['partner'] = 'Choose a different installed English voice for MENTOR_SPEECH_PARTNER_VOICE.'
  for legacy, persona in LEGACY_PERSONAS.items():
    if legacy in voices:
      persona_voices[persona] = voices[legacy]
  for persona, configured in (('jordan', 'Karen'), ('riley', 'Moira')):
    try:
      installed_voice = resolve_installed_voice(configured, installed)
      if installed_voice not in persona_voices.values():
        persona_voices[persona] = installed_voice
    except ValueError:
      # Extra personas are capabilities, never substitutions for missing voices.
      continue


def create_neural_synthesizer(provider: str):
  if provider == 'kokoro':
    from kokoro_synthesis import KokoroSynthesis
    return KokoroSynthesis()
  from chatterbox_synthesis import ChatterboxSynthesis
  return ChatterboxSynthesis()


def load_neural_synthesis(provider: str):
  try:
    candidate = create_neural_synthesizer(provider)
    candidate.load()
    # Warm each engine before reporting ready. Discard this synthetic phrase.
    candidate.synthesize('Hello. Let us practice together.')
    synthesizers[provider] = candidate
  except Exception as error:
    synthesis_errors[provider] = f'{NEURAL_MODELS[provider]} could not load. Run npm run speech:setup:{provider} and restart speech.'
    logger.error('%s startup failed (%s).', provider, type(error).__name__)


def load_synthesis():
  synthesizers.clear()
  synthesis_errors.clear()
  # The system voices stay available regardless of the default neural provider.
  load_voices()
  for provider in NEURAL_MODELS:
    load_neural_synthesis(provider)


def load_model():
  global model, model_error
  try:
    model = WhisperModel(
      str(MODEL_PATH),
      device='cpu',
      compute_type='int8',
      cpu_threads=4,
      num_workers=1,
      local_files_only=True,
    )
    # Warm up the decoder before the first microphone turn.
    segments, _ = model.transcribe(np.zeros(SAMPLE_RATE, dtype=np.float32), language='en')
    list(segments)
    logger.info('Whisper ready at %s', MODEL_PATH)
  except Exception:
    model = None
    model_error = 'Local recognition model could not load. Run npm run speech:setup and restart.'
    logger.exception('Speech model failed to load')


@asynccontextmanager
async def lifespan(_app):
  await run_in_threadpool(load_synthesis)
  await run_in_threadpool(load_model)
  yield


app = FastAPI(title='mentor local speech', lifespan=lifespan, docs_url=None, redoc_url=None)


class SpeechRequest(BaseModel):
  model_config = ConfigDict(extra='forbid')
  text: str = Field(min_length=1, max_length=2400)
  voice: Literal['coach', 'partner'] = 'coach'
  provider: Literal['macos', 'kokoro', 'chatterbox'] | None = None
  persona: Literal['alex', 'sam', 'jordan', 'riley'] | None = None
  language: Literal[
    'ar', 'da', 'de', 'el', 'en', 'es', 'fi', 'fr', 'he', 'hi', 'it', 'ja',
    'ko', 'ms', 'nl', 'no', 'pl', 'pt', 'ru', 'sv', 'sw', 'tr', 'zh',
  ] = 'en'


def provider_health(provider: str):
  if provider == 'macos':
    synthesis = 'coach' in voices and shutil.which('say') is not None and shutil.which('ffmpeg') is not None
    return {
      'provider': 'macos',
      'synthesisModel': 'macOS speech',
      'device': 'cpu',
      'languages': ['en'],
      'synthesis': synthesis,
      'ready': synthesis,
      'voices': dict(voices),
      'conversationSynthesis': synthesis and 'partner' in voices,
      'personas': [persona_metadata(persona, ['en']) for persona in persona_voices] if synthesis else [],
      'detail': voice_errors.get('coach') or voice_errors.get('partner') or (
        None if synthesis else 'Local system speech needs macOS say and ffmpeg.'
      ),
    }
  engine = synthesizers.get(provider)
  if engine is not None:
    capabilities = engine.health()
    if provider == 'chatterbox':
      capabilities['personas'] = [
        persona_metadata(persona, capabilities.get('languages', []))
        for voice, persona in LEGACY_PERSONAS.items()
        if capabilities.get('synthesis') and capabilities.get('voices', {}).get(voice)
      ]
    return capabilities
  return {
    'provider': provider,
    'synthesisModel': NEURAL_MODELS.get(provider, 'Unknown local voice model'),
    'synthesis': False,
    'ready': False,
    'conversationSynthesis': False,
    'voices': {},
    'personas': [],
    'languages': [],
    'detail': synthesis_errors.get(provider) or 'Local speech synthesis is starting.',
  }


@app.get('/health')
def health():
  recognition = model is not None
  providers = {provider: provider_health(provider) for provider in ('macos', *NEURAL_MODELS)}
  speech = providers.get(TTS_PROVIDER) or provider_health(TTS_PROVIDER)
  return {
    **speech,
    'available': recognition and speech.get('synthesis', False),
    'recognition': recognition,
    'model': MODEL_PATH.name,
    'voice': speech.get('voices', {}).get('coach'),
    'local': True,
    'detail': model_error or speech.get('detail'),
    'providers': providers,
  }


def recognize_audio(data: bytes):
  if model is None:
    raise HTTPException(status_code=503, detail=model_error or 'Speech recognition is starting.')

  try:
    samples = decode_audio(io.BytesIO(data), sampling_rate=SAMPLE_RATE)
  except Exception as error:
    raise HTTPException(status_code=422, detail='This audio could not be decoded. Record a new turn.') from error

  duration = len(samples) / SAMPLE_RATE
  if duration > MAX_AUDIO_SECONDS:
    raise HTTPException(status_code=413, detail='Audio segments must be 60 seconds or shorter.')
  if duration < 0.15 or not len(samples) or float(np.max(np.abs(samples))) < 0.003:
    return {'text': '', 'language': 'en', 'durationSeconds': round(duration, 3), 'words': []}

  with model_lock:
    segments, _ = model.transcribe(
      samples,
      language='en',
      beam_size=1,
      best_of=1,
      temperature=0,
      condition_on_previous_text=False,
      vad_filter=True,
      vad_parameters={'min_silence_duration_ms': 300, 'speech_pad_ms': 150},
      word_timestamps=True,
    )
    accepted = [segment for segment in segments if segment.no_speech_prob < 0.8]

  return {
    'text': ' '.join(segment.text.strip() for segment in accepted).strip(),
    'language': 'en',
    'durationSeconds': round(duration, 3),
    'words': [
      {'word': word.word.strip(), 'start': word.start, 'end': word.end}
      for segment in accepted
      for word in (segment.words or [])
    ],
  }


@app.post('/transcribe')
async def transcribe(audio: UploadFile = File(...)):
  data = await audio.read(MAX_AUDIO_BYTES + 1)
  await audio.close()
  if not data:
    raise HTTPException(status_code=400, detail='The audio segment is empty.')
  if len(data) > MAX_AUDIO_BYTES:
    raise HTTPException(status_code=413, detail='Audio segments must be smaller than 8 MB.')
  return await run_in_threadpool(recognize_audio, data)


def synthesize_macos(text: str, voice: str = 'coach', cancel_event=None, persona: str | None = None):
  if not shutil.which('say') or not shutil.which('ffmpeg'):
    raise HTTPException(status_code=503, detail='Local speech needs macOS say and ffmpeg.')
  selected_voice = persona_voices.get(persona) if persona is not None else voices.get(voice)
  if not selected_voice:
    if persona is not None:
      raise HTTPException(status_code=422, detail='This macOS voice persona is unavailable. Choose an installed persona.')
    raise HTTPException(status_code=503, detail=voice_errors.get(voice, 'This local voice is unavailable.'))

  deadline = time.monotonic() + 45
  def check_active():
    if cancel_event is not None and cancel_event.is_set():
      raise HTTPException(status_code=499, detail='Speech was cancelled.')
    if time.monotonic() >= deadline:
      raise HTTPException(status_code=504, detail='Local speech took too long. Retry a shorter passage.')

  # Poll the lock so a cancelled queued system voice does not start speaking.
  while not synthesis_lock.acquire(timeout=0.05):
    check_active()
  try:
    check_active()
    return render_macos_audio(text, selected_voice, check_active)
  finally:
    synthesis_lock.release()


def render_macos_audio(text: str, selected_voice: str, check_active):
  # Pass text via a file, never a shell command, and remove every temporary artifact.
  with tempfile.TemporaryDirectory(prefix='mentor-speech-') as directory:
    base = Path(directory)
    (base / 'input.txt').write_text(text, encoding='utf-8')
    try:
      subprocess.run(
        ['say', '-v', selected_voice, '-r', '175', '-o', str(base / 'speech.aiff'), '-f', str(base / 'input.txt')],
        check=True, capture_output=True, timeout=30,
      )
      check_active()
      subprocess.run(
        ['ffmpeg', '-nostdin', '-v', 'error', '-i', str(base / 'speech.aiff'),
         '-ar', '22050', '-ac', '1', '-c:a', 'pcm_s16le', str(base / 'speech.wav')],
        check=True, capture_output=True, timeout=15,
      )
      check_active()
      return (base / 'speech.wav').read_bytes()
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired) as error:
      logger.warning('Local synthesis failed: %s', type(error).__name__)
      raise HTTPException(status_code=503, detail='Local speech synthesis failed. Check the configured macOS voice.') from error


def synthesize_audio(
  text: str,
  voice: str = 'coach',
  language: str = 'en',
  cancel_event=None,
  provider: str | None = None,
  persona: str | None = None,
):
  if cancel_event is not None and cancel_event.is_set():
    raise HTTPException(status_code=499, detail='Speech was cancelled.')
  selected_provider = provider or TTS_PROVIDER
  if persona is not None and (not isinstance(persona, str) or persona not in PERSONA_NAMES):
    raise HTTPException(status_code=422, detail='Choose an available built-in voice persona.')
  if selected_provider == 'macos':
    if language != 'en':
      raise HTTPException(status_code=422, detail='These macOS voices support English. Choose Chatterbox for multilingual speech.')
    if persona is not None:
      return synthesize_macos(text, voice, cancel_event, persona=persona)
    return synthesize_macos(text, voice, cancel_event)
  synthesizer = synthesizers.get(selected_provider)
  if synthesizer is None:
    raise HTTPException(status_code=503, detail=synthesis_errors.get(selected_provider) or 'The selected local voice model is unavailable. Check Settings and speech setup.')
  try:
    if persona is not None:
      if selected_provider == 'chatterbox':
        persona_legacy = {value: key for key, value in LEGACY_PERSONAS.items()}
        if persona not in persona_legacy:
          raise HTTPException(status_code=422, detail='Chatterbox currently has Alex and Sam reference voices. Choose one of these personas.')
        return synthesizer.synthesize(text, persona_legacy[persona], language, cancel_event=cancel_event)
      return synthesizer.synthesize(text, voice, language, cancel_event=cancel_event, persona=persona)
    return synthesizer.synthesize(text, voice, language, cancel_event=cancel_event)
  except HTTPException:
    raise
  except SynthesisError as error:
    raise HTTPException(status_code=error.status_code, detail=str(error)) from error
  except Exception as error:
    if cancel_event is not None and cancel_event.is_set():
      raise HTTPException(status_code=499, detail='Speech was cancelled.') from error
    logger.warning('%s synthesis failed (%s).', selected_provider, type(error).__name__)
    raise HTTPException(status_code=503, detail='Local speech could not be generated. Check the selected voice model and retry.') from error


@app.post('/speech')
async def speech(body: SpeechRequest, request: Request):
  text = body.text.strip()
  if not text:
    raise HTTPException(status_code=400, detail='Provide text to speak.')
  if not synthesis_slots.acquire(blocking=False):
    raise HTTPException(status_code=429, detail='Local speech is busy. Stop other playback and retry.')

  cancel_event = threading.Event()

  def work():
    try:
      return synthesize_audio(text, body.voice, body.language, cancel_event, body.provider, body.persona)
    finally:
      synthesis_slots.release()

  task = asyncio.create_task(run_in_threadpool(work))
  # Disconnects stop queued work and the next model segment; an in-progress
  # neural forward pass finishes cooperatively without overlapping another one.
  async def wait_for_disconnect():
    while True:
      if await request.is_disconnected():
        return
      await asyncio.sleep(0.05)

  monitor = asyncio.create_task(wait_for_disconnect())
  try:
    done, _ = await asyncio.wait(
      [task, monitor], timeout=SYNTHESIS_TIMEOUT, return_when=asyncio.FIRST_COMPLETED,
    )
    if task in done:
      data = await task
      return Response(content=data, media_type='audio/wav', headers={
        'Cache-Control': 'no-store',
        'X-Mentor-Speech-Provider': body.provider or TTS_PROVIDER,
        'X-Mentor-Speech-Persona': body.persona or LEGACY_PERSONAS[body.voice],
      })
    cancel_event.set()
    if monitor in done:
      raise HTTPException(status_code=499, detail='Speech was cancelled.')
    raise HTTPException(status_code=504, detail='Local speech took too long. Try a shorter passage or retry.')
  finally:
    cancel_event.set()
    monitor.cancel()
    # Keep the worker alive until its cooperative cancellation releases its slot.
    # Consume any late exception when the HTTP client has already disconnected.
    def consume_result(completed):
      if not completed.cancelled():
        completed.exception()
    task.add_done_callback(consume_result)
