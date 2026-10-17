"""Offline Kokoro-82M synthesis with CPU ONNX inference and preset voices.

The pinned v1.0 export follows the kokoro-onnx model contract: padded int64
tokens, one float32 style vector selected by phoneme length, and float32 speed.
Using ONNX Runtime directly keeps Chatterbox's NumPy 1 environment compatible;
the newer convenience wrapper requires NumPy 2. No runtime downloads occur.
"""

import io
import json
import logging
import math
import os
import threading
import time
import wave
from dataclasses import dataclass, field
from pathlib import Path

from chatterbox_synthesis import (
  MAX_TEXT_CHARACTERS,
  SAMPLE_RATE,
  SynthesisCancelledError,
  SynthesisError,
  SynthesisTimeoutError,
  _pcm_bytes,
  split_speech_text,
)
from speech_personas import LEGACY_PERSONAS, PERSONA_NAMES, persona_metadata


MODEL_FILES = ('kokoro-v1.0.onnx', 'voices-v1.0.bin', 'config.json')
LANGUAGES = {'en': 'en-us', 'es': 'es'}
PERSONA_PRESETS = {
  'alex': {'en': 'af_heart', 'es': 'ef_dora'},
  'sam': {'en': 'am_michael', 'es': 'em_alex'},
  'jordan': {'en': 'af_bella'},
  'riley': {'en': 'bm_george'},
}
VOICE_LABELS = {'coach': 'Alex · Kokoro', 'partner': 'Sam · Kokoro'}
MAX_PHONEMES = 180


@dataclass(frozen=True)
class KokoroConfig:
  model_path: Path = field(default_factory=lambda: Path.home() / 'Models' / 'kokoro-82m')
  request_timeout_seconds: float = 45
  max_segment_characters: int = 180
  cpu_threads: int = 4

  @classmethod
  def from_env(cls):
    default = Path.home() / 'Models' / 'kokoro-82m'
    return cls(model_path=Path(os.getenv('MENTOR_KOKORO_MODEL', str(default))).expanduser())


class _OnnxEngine:
  def __init__(self, model_path: Path, cpu_threads: int):
    import ctypes

    import espeakng_loader
    import numpy as np
    import onnxruntime as ort
    from phonemizer.backend import EspeakBackend
    from phonemizer.backend.espeak.wrapper import EspeakWrapper

    ort.disable_telemetry_events()
    options = ort.SessionOptions()
    options.intra_op_num_threads = cpu_threads
    options.inter_op_num_threads = 1
    options.log_severity_level = 3
    self.session = ort.InferenceSession(
      str(model_path / MODEL_FILES[0]), sess_options=options,
      providers=['CPUExecutionProvider'],
    )
    inputs = {item.name: item.type for item in self.session.get_inputs()}
    if inputs != {'tokens': 'tensor(int64)', 'style': 'tensor(float)', 'speed': 'tensor(float)'}:
      raise SynthesisError('The local Kokoro model has an incompatible input format. Run Kokoro setup again.')
    with (model_path / 'config.json').open(encoding='utf-8') as source:
      vocabulary = json.load(source).get('vocab')
    if not isinstance(vocabulary, dict) or not vocabulary or any(
      not isinstance(character, str) or len(character) != 1
      or type(token) is not int or not 1 <= token < 178
      for character, token in vocabulary.items()
    ):
      raise SynthesisError('The local Kokoro vocabulary is invalid. Run Kokoro setup again.')
    self.vocab = vocabulary
    self.voices = {}
    # NPZ loads arrays only; never unpickle model-provided Python objects.
    with np.load(model_path / 'voices-v1.0.bin', allow_pickle=False) as voices:
      for persona, presets in PERSONA_PRESETS.items():
        for name in presets.values():
          # The original two voices are required; extra personas are offered
          # only when their verified preset vectors are actually installed.
          if name not in voices and persona not in ('alex', 'sam'):
            continue
          value = np.asarray(voices[name], dtype=np.float32)
          if value.shape != (510, 1, 256) or not np.isfinite(value).all():
            raise SynthesisError('A local Kokoro preset voice is invalid. Run Kokoro setup again.')
          self.voices[name] = value

    library_path = espeakng_loader.get_library_path()
    data_path = espeakng_loader.get_data_path()
    if not Path(library_path).is_file() or not Path(data_path).is_dir():
      raise SynthesisError('Kokoro local pronunciation files are missing. Run Kokoro setup again.')
    ctypes.cdll.LoadLibrary(library_path)
    EspeakWrapper.set_library(library_path)
    EspeakWrapper.set_data_path(data_path)
    logger = logging.getLogger('mentor.kokoro.phonemizer')
    logger.setLevel(logging.ERROR)
    self.phonemizers = {
      language: EspeakBackend(
        code, preserve_punctuation=True, with_stress=True,
        language_switch='remove-flags', logger=logger,
      )
      for language, code in LANGUAGES.items()
    }

  def phonemize(self, text: str, language: str) -> str:
    phonemes = self.phonemizers[language].phonemize([text.strip()], strip=True)[0]
    return ''.join(character for character in phonemes if character in self.vocab)

  def generate(self, phonemes: str, preset: str):
    import numpy as np

    tokens = [self.vocab[character] for character in phonemes]
    if not 1 <= len(tokens) <= MAX_PHONEMES:
      raise SynthesisError('Kokoro received an invalid pronunciation segment.')
    return self.session.run(None, {
      'tokens': np.asarray([[0, *tokens, 0]], dtype=np.int64),
      'style': self.voices[preset][len(tokens) - 1],
      'speed': np.asarray([1.0], dtype=np.float32),
    })[0]


def _load_engine(model_path: Path, cpu_threads: int):
  return _OnnxEngine(model_path, cpu_threads)


class KokoroSynthesis:
  def __init__(self, config: KokoroConfig | None = None):
    self.config = config or KokoroConfig.from_env()
    self._engine = None
    self._error = None
    # eSpeak uses process-global state. Serializing phonemization and inference
    # also avoids oversubscribing the CPU when homepage speech is prefetched.
    self._lock = threading.Lock()

  def load(self) -> None:
    with self._lock:
      if self._engine is not None:
        return
      try:
        os.environ['HF_HUB_OFFLINE'] = '1'
        os.environ['TRANSFORMERS_OFFLINE'] = '1'
        os.environ['HF_HUB_DISABLE_TELEMETRY'] = '1'
        if not math.isfinite(self.config.request_timeout_seconds) or self.config.request_timeout_seconds <= 0:
          raise SynthesisError('The local speech timeout must be positive and finite.')
        if not 16 <= self.config.max_segment_characters <= 180:
          raise SynthesisError('Local speech segments must contain between 16 and 180 characters.')
        if type(self.config.cpu_threads) is not int or not 1 <= self.config.cpu_threads <= 8:
          raise SynthesisError('Kokoro requires between one and eight CPU threads.')
        model_path = self.config.model_path.expanduser()
        if any(not (model_path / name).is_file() for name in MODEL_FILES):
          raise SynthesisError('Kokoro model files are missing. Run npm run speech:setup:kokoro and restart speech.')
        self._engine = _load_engine(model_path, self.config.cpu_threads)
        self._error = None
      except SynthesisError as error:
        self._error = str(error)
        raise
      except Exception as error:
        self._error = 'Kokoro could not load its local model and voices. Run npm run speech:setup:kokoro and restart speech.'
        raise SynthesisError(self._error) from error

  def health(self) -> dict:
    ready = self._engine is not None
    return {
      'provider': 'kokoro',
      'synthesisModel': 'Kokoro-82M',
      'device': 'cpu',
      'languages': list(LANGUAGES),
      'voices': dict(VOICE_LABELS) if ready else {},
      'personas': [
        persona_metadata(persona, languages)
        for persona, presets in PERSONA_PRESETS.items()
        if ready and (languages := [language for language, preset in presets.items() if preset in self._engine.voices])
      ],
      'ready': ready,
      'synthesis': ready,
      'conversationSynthesis': ready,
      'detail': self._error or (None if ready else 'Local Kokoro speech is starting.'),
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
    persona: str | None = None,
  ) -> bytes:
    if not isinstance(text, str) or not text.strip() or len(text) > MAX_TEXT_CHARACTERS:
      raise SynthesisError('Provide between 1 and 2400 characters to speak.', 400)
    if not isinstance(voice, str) or voice not in VOICE_LABELS:
      raise SynthesisError('Choose the coach or partner voice.', 400)
    if not isinstance(language, str) or language not in LANGUAGES:
      raise SynthesisError('Kokoro supports English and Spanish. Choose another voice engine for this language.', 422)
    if self._engine is None:
      raise SynthesisError(self._error or 'Local Kokoro speech is starting.')
    selected_persona = LEGACY_PERSONAS[voice] if persona is None else persona
    if not isinstance(selected_persona, str) or selected_persona not in PERSONA_NAMES:
      raise SynthesisError('Choose an available built-in voice persona.', 422)
    preset = PERSONA_PRESETS[selected_persona].get(language)
    if preset is None or preset not in self._engine.voices:
      raise SynthesisError('This Kokoro voice persona is unavailable for the selected language.', 422)
    deadline = time.monotonic() + self.config.request_timeout_seconds
    self._check_request(cancel_event, deadline)
    while not self._lock.acquire(timeout=min(0.05, max(0, deadline - time.monotonic()))):
      self._check_request(cancel_event, deadline)
    try:
      audio = io.BytesIO()
      frames_written = 0
      with wave.open(audio, 'wb') as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(SAMPLE_RATE)
        for text_segment in split_speech_text(text, self.config.max_segment_characters):
          self._check_request(cancel_event, deadline)
          phonemes = self._engine.phonemize(text_segment, language)
          # Numbers and abbreviations can expand beyond the original text's
          # length. Bound phonemes too, and preserve every segment rather than
          # letting an upstream engine truncate at its 510-token context cap.
          for segment in split_speech_text(phonemes, MAX_PHONEMES):
            if not segment.strip():
              continue
            self._check_request(cancel_event, deadline)
            waveform = self._engine.generate(segment, preset)
            self._check_request(cancel_event, deadline)
            pcm = _pcm_bytes(waveform)
            output.writeframes(pcm)
            frames_written += len(pcm) // 2
      self._check_request(cancel_event, deadline)
      if not frames_written:
        raise SynthesisError('This passage contains no words Kokoro can pronounce.', 400)
      return audio.getvalue()
    except SynthesisError:
      raise
    except Exception as error:
      raise SynthesisError('Local Kokoro speech could not be generated. Retry the passage.') from error
    finally:
      self._lock.release()
