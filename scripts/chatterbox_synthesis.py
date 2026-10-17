"""Offline Chatterbox synthesis with isolated voices and cooperative cancellation."""

import io
import math
import os
import re
import threading
import time
import wave
from dataclasses import dataclass, field
from pathlib import Path


SAMPLE_RATE = 24000
MAX_TEXT_CHARACTERS = 2400
SUPPORTED_LANGUAGES = (
  'ar', 'da', 'de', 'el', 'en', 'es', 'fi', 'fr', 'he', 'hi', 'it', 'ja',
  'ko', 'ms', 'nl', 'no', 'pl', 'pt', 'ru', 'sv', 'sw', 'tr', 'zh',
)
REQUIRED_MODEL_FILES = (
  've.pt',
  't3_mtl23ls_v3.safetensors',
  's3gen.pt',
  'grapheme_mtl_merged_expanded_v1.json',
)
REQUIRED_TOKENIZER_FILES = (
  'pkuseg/spacy_ontonotes.zip',
  'pkuseg/spacy_ontonotes/features.msgpack',
  'pkuseg/spacy_ontonotes/weights.npz',
)
VOICE_LABELS = {'coach': 'Alex · Chatterbox', 'partner': 'Sam · Chatterbox'}


class SynthesisError(Exception):
  """A safe public error that never includes a prompt or a local file path."""

  def __init__(self, message: str, status_code: int = 503):
    super().__init__(message)
    self.status_code = status_code


class SynthesisCancelledError(SynthesisError):
  def __init__(self):
    super().__init__('Speech was cancelled.', 499)


class SynthesisTimeoutError(SynthesisError):
  def __init__(self):
    super().__init__('Local speech took too long. Try a shorter passage or retry.', 504)


@dataclass(frozen=True)
class ChatterboxConfig:
  model_path: Path = field(default_factory=lambda: Path.home() / 'Models' / 'chatterbox-multilingual-v3')
  device: str = 'auto'
  coach_reference: Path | None = None
  partner_reference: Path | None = None
  request_timeout_seconds: float = 45
  max_segment_characters: int = 180

  @classmethod
  def from_env(cls):
    default_model = Path.home() / 'Models' / 'chatterbox-multilingual-v3'
    return cls(
      model_path=Path(os.getenv('MENTOR_CHATTERBOX_MODEL', str(default_model))).expanduser(),
      device=os.getenv('MENTOR_CHATTERBOX_DEVICE', 'auto'),
      coach_reference=Path(value).expanduser() if (value := os.getenv('MENTOR_CHATTERBOX_COACH_REFERENCE')) else None,
      partner_reference=Path(value).expanduser() if (value := os.getenv('MENTOR_CHATTERBOX_PARTNER_REFERENCE')) else None,
    )


def split_speech_text(text: str, max_characters: int = 180) -> list[str]:
  """Bound each inference call without dropping any of the requested text.

  Prefer complete sentences, then word boundaries. An unusually long token is
  divided only when necessary. Whitespace stays with its preceding segment.
  """
  if max_characters < 1:
    raise ValueError('The speech segment limit must be positive.')
  remaining = text.strip()
  segments = []
  while len(remaining) > max_characters:
    window = remaining[:max_characters]
    sentence_ends = [
      match.end() for match in re.finditer(r'[.!?。！？][\'"”’)\]]*\s*|\n+', window)
      if match.end() >= max_characters // 3
    ]
    word_ends = [match.end() for match in re.finditer(r'\s+', window)]
    boundary = sentence_ends[-1] if sentence_ends else word_ends[-1] if word_ends else max_characters
    segments.append(remaining[:boundary])
    remaining = remaining[boundary:]
  if remaining:
    segments.append(remaining)
  return segments


def _resolve_device(requested: str) -> str:
  if requested not in ('auto', 'mps', 'cpu'):
    raise SynthesisError('Choose auto, mps, or cpu for the local Chatterbox device.')
  import torch

  available = torch.backends.mps.is_available()
  if requested == 'mps' and not available:
    raise SynthesisError('The configured MPS device is unavailable. Choose cpu or auto and restart speech.')
  return ('mps' if available else 'cpu') if requested == 'auto' else requested


def _load_engine(model_path: Path, device: str):
  # Never call from_pretrained: all inference dependencies must already exist
  # on disk, including the tokenizer's Chinese helper cache staged by setup.
  from chatterbox.mtl_tts import ChatterboxMultilingualTTS

  return ChatterboxMultilingualTTS.from_local(str(model_path), device=device, t3_model='v3')


def _reference_path(configured: Path | None, default: Path) -> Path:
  reference = (configured if configured is not None else default).expanduser()
  if not reference.is_file() or reference.stat().st_size > 12 * 1024 * 1024:
    raise SynthesisError('A configured Chatterbox reference voice is missing or too large. Run speech setup or check the voice configuration.')
  try:
    with wave.open(str(reference), 'rb') as audio:
      duration = audio.getnframes() / audio.getframerate()
      if not 3 <= duration <= 30 or audio.getnchannels() not in (1, 2) or audio.getframerate() < 8000:
        raise SynthesisError('Chatterbox reference voices must be 3–30 second mono or stereo PCM WAV recordings.')
      if audio.getcomptype() != 'NONE' or audio.getsampwidth() not in (1, 2, 3, 4):
        raise SynthesisError('Chatterbox reference voices must use PCM WAV audio.')
  except (EOFError, OSError, wave.Error, ZeroDivisionError) as error:
    raise SynthesisError('A configured Chatterbox reference voice could not be read as PCM WAV audio.') from error
  return reference.resolve()


def _pcm_bytes(waveform) -> bytes:
  import numpy as np

  # Chatterbox returns the already-watermarked waveform. Only encode that
  # waveform as PCM; do not normalize, resample, or bypass the watermark stage.
  if hasattr(waveform, 'detach'):
    waveform = waveform.detach().cpu().numpy()
  samples = np.asarray(waveform)
  if samples.ndim == 2 and samples.shape[0] == 1:
    samples = samples[0]
  real_audio = np.issubdtype(samples.dtype, np.floating) or np.issubdtype(samples.dtype, np.integer)
  if samples.ndim != 1 or not samples.size or not real_audio:
    raise SynthesisError('Local speech returned invalid audio. Retry the passage.')
  if not np.isfinite(samples).all():
    raise SynthesisError('Local speech returned invalid audio. Retry the passage.')
  return (np.clip(samples, -1, 1) * 32767).round().astype('<i2').tobytes()


class ChatterboxSynthesis:
  def __init__(self, config: ChatterboxConfig | None = None):
    self.config = config or ChatterboxConfig.from_env()
    self._model = None
    self._conditionals = {}
    self._device = None
    self._error = None
    # Both preparation and generation mutate engine.conds. One lock protects
    # the entire operation so concurrent voices cannot share conditioning.
    self._lock = threading.Lock()

  def load(self) -> None:
    with self._lock:
      if self._model is not None:
        return
      try:
        # Force offline before importing any model/tokenizer dependency. An
        # incomplete setup must fail, never download during learner inference.
        os.environ['HF_HUB_OFFLINE'] = '1'
        os.environ['TRANSFORMERS_OFFLINE'] = '1'
        os.environ['HF_HUB_DISABLE_TELEMETRY'] = '1'
        if not math.isfinite(self.config.request_timeout_seconds) or self.config.request_timeout_seconds <= 0:
          raise SynthesisError('The local speech timeout must be positive and finite.')
        if not 16 <= self.config.max_segment_characters <= 180:
          raise SynthesisError('Local speech segments must contain between 16 and 180 characters.')
        model_path = self.config.model_path.expanduser()
        if not model_path.is_dir() or any(not (model_path / name).is_file() for name in REQUIRED_MODEL_FILES):
          raise SynthesisError('Chatterbox Multilingual V3 model files are missing. Run npm run speech:setup:chatterbox and restart speech.')
        # Unlike Hugging Face, pkuseg does not honor HF_HUB_OFFLINE. Its loader
        # skips download only when this complete, setup-verified cache exists.
        if any(not (model_path / name).is_file() for name in REQUIRED_TOKENIZER_FILES):
          raise SynthesisError('Chatterbox offline tokenizer files are missing. Run npm run speech:setup:chatterbox and restart speech.')
        os.environ['PKUSEG_HOME'] = str(model_path / 'pkuseg')
        references = {
          'coach': _reference_path(self.config.coach_reference, model_path / 'voices' / 'coach.wav'),
          'partner': _reference_path(self.config.partner_reference, model_path / 'voices' / 'partner.wav'),
        }
        if references['coach'] == references['partner'] or references['coach'].read_bytes() == references['partner'].read_bytes():
          raise SynthesisError('Choose two different reference voices for the coach and partner.')
        device = _resolve_device(self.config.device)
        engine = _load_engine(model_path, device)
        if engine.sr != SAMPLE_RATE:
          raise SynthesisError('The local Chatterbox model must produce 24 kHz audio.')
        conditionals = {}
        for voice, reference in references.items():
          engine.prepare_conditionals(str(reference), exaggeration=0.5)
          if engine.conds is None:
            raise SynthesisError('A local Chatterbox reference voice could not be prepared.')
          conditionals[voice] = engine.conds
        if conditionals['coach'] is conditionals['partner']:
          raise SynthesisError('The local model could not prepare separate coach and partner voices.')
        self._conditionals = conditionals
        self._device = device
        self._error = None
        self._model = engine
      except SynthesisError as error:
        self._error = str(error)
        raise
      except Exception as error:
        self._error = 'Chatterbox could not load its local model and voices. Run npm run speech:setup:chatterbox and restart speech.'
        raise SynthesisError(self._error) from error

  def health(self) -> dict:
    ready = self._model is not None
    return {
      'provider': 'chatterbox',
      'synthesisModel': 'Chatterbox Multilingual V3',
      **({'device': self._device} if self._device is not None else {}),
      'languages': list(SUPPORTED_LANGUAGES),
      'voices': dict(VOICE_LABELS) if ready else {},
      'ready': ready,
      'synthesis': ready,
      'conversationSynthesis': ready,
      'detail': self._error or (None if ready else 'Local Chatterbox speech is starting.'),
    }

  @staticmethod
  def _check_request(cancel_event: threading.Event | None, deadline: float) -> None:
    if cancel_event is not None and cancel_event.is_set():
      raise SynthesisCancelledError()
    if time.monotonic() >= deadline:
      raise SynthesisTimeoutError()

  def synthesize(
    self,
    text: str,
    voice: str = 'coach',
    language: str = 'en',
    cancel_event: threading.Event | None = None,
  ) -> bytes:
    if not isinstance(text, str) or not text.strip() or len(text) > MAX_TEXT_CHARACTERS:
      raise SynthesisError('Provide between 1 and 2400 characters to speak.', 400)
    if not isinstance(voice, str) or voice not in VOICE_LABELS:
      raise SynthesisError('Choose the coach or partner voice.', 400)
    if not isinstance(language, str) or language not in SUPPORTED_LANGUAGES:
      raise SynthesisError('Choose a supported Chatterbox speech language.', 400)
    if self._model is None:
      raise SynthesisError(self._error or 'Local Chatterbox speech is starting.')

    deadline = time.monotonic() + self.config.request_timeout_seconds
    self._check_request(cancel_event, deadline)
    while not self._lock.acquire(timeout=min(0.05, max(0, deadline - time.monotonic()))):
      self._check_request(cancel_event, deadline)
    try:
      self._check_request(cancel_event, deadline)
      # CJK text carries more speech tokens per character than spaced English.
      # Shorter segments keep those languages away from the model token cap.
      segment_limit = min(self.config.max_segment_characters, 80) if language in ('zh', 'ja') else self.config.max_segment_characters
      segments = split_speech_text(text, segment_limit)
      audio = io.BytesIO()
      with wave.open(audio, 'wb') as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(SAMPLE_RATE)
        for segment in segments:
          self._check_request(cancel_event, deadline)
          if not segment.strip():
            continue
          self._model.conds = self._conditionals[voice]
          waveform = self._model.generate(
            segment,
            language_id=language,
            exaggeration=0.5,
            # English reference voices should not impose an English accent on
            # another language; the official multilingual model supports CFG 0.
            cfg_weight=0.5 if language == 'en' else 0.0,
          )
          self._check_request(cancel_event, deadline)
          output.writeframes(_pcm_bytes(waveform))
      self._check_request(cancel_event, deadline)
      return audio.getvalue()
    except SynthesisError:
      raise
    except Exception as error:
      raise SynthesisError('Local Chatterbox speech could not be generated. Retry the passage.') from error
    finally:
      self._lock.release()
