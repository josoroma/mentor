"""Kokoro provider behavior without loading neural weights or downloading files."""

import io
import os
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import wave
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
from pathlib import Path
from unittest.mock import Mock, patch

import numpy as np

import kokoro_synthesis as speech


class FakeEngine:
  def __init__(self):
    self.calls = []
    self.phonemized = []
    self.on_generate = None
    self.on_phonemize = None
    self.voices = {preset: object() for presets in speech.PERSONA_PRESETS.values() for preset in presets.values()}

  def phonemize(self, text, language):
    self.phonemized.append((text, language))
    return self.on_phonemize(text) if self.on_phonemize else text

  def generate(self, phonemes, preset):
    self.calls.append((phonemes, preset))
    if self.on_generate:
      return self.on_generate(phonemes, preset)
    gain = -1 if preset in ('am_michael', 'em_alex') else 1
    return np.array([-0.7, 0.1, 0.7], dtype=np.float32) * gain


class KokoroSynthesisTests(unittest.TestCase):
  def setUp(self):
    temporary = tempfile.TemporaryDirectory(prefix='mentor-fake-kokoro-')
    self.addCleanup(temporary.cleanup)
    self.directory = Path(temporary.name)
    for name in speech.MODEL_FILES:
      (self.directory / name).write_bytes(b'fake; never loaded')
    self.config = speech.KokoroConfig(model_path=self.directory)
    self.engine = FakeEngine()
    loader = patch.object(speech, '_load_engine', return_value=self.engine)
    self.loader = loader.start()
    self.addCleanup(loader.stop)
    environment = patch.dict(os.environ, {})
    environment.start()
    self.addCleanup(environment.stop)
    self.provider = speech.KokoroSynthesis(self.config)

  def load(self):
    self.provider.load()
    return self.provider

  def assert_error(self, status, call):
    with self.assertRaises(speech.SynthesisError) as caught:
      call()
    self.assertEqual(caught.exception.status_code, status)
    return caught.exception

  def test_import_does_not_load_neural_or_phonemizer_dependencies(self):
    command = (
      f'import sys; sys.path.insert(0, {str(Path(__file__).parent)!r}); '
      'import kokoro_synthesis; '
      'assert not any(name in sys.modules for name in ("onnxruntime", "numpy", "torch", "phonemizer"))'
    )
    result = subprocess.run([sys.executable, '-S', '-c', command], capture_output=True, text=True, timeout=10)
    self.assertEqual(result.returncode, 0, result.stderr)

  def test_load_once_with_local_paths_and_accurate_health(self):
    self.assertFalse(self.provider.health()['ready'])
    self.load()
    self.provider.load()
    self.loader.assert_called_once_with(self.directory, 4)
    self.assertEqual(os.environ['HF_HUB_OFFLINE'], '1')
    self.assertEqual(os.environ['TRANSFORMERS_OFFLINE'], '1')
    health = self.provider.health()
    self.assertTrue(health['conversationSynthesis'])
    self.assertEqual(health['languages'], ['en', 'es'])
    self.assertEqual(health['provider'], 'kokoro')
    self.assertNotEqual(health['voices']['coach'], health['voices']['partner'])

  def test_missing_assets_fail_without_loading_or_downloading(self):
    (self.directory / speech.MODEL_FILES[0]).unlink()
    self.assert_error(503, self.provider.load)
    self.loader.assert_not_called()
    self.assertFalse(self.provider.health()['synthesis'])
    self.assertIn('speech:setup:kokoro', self.provider.health()['detail'])

  def test_load_error_is_safe_and_not_marked_ready(self):
    self.loader.side_effect = RuntimeError('/secret/local/path')
    error = self.assert_error(503, self.provider.load)
    self.assertNotIn('/secret', str(error))
    self.assertFalse(self.provider.health()['ready'])

  def test_rejects_invalid_runtime_configuration(self):
    for config in [
      replace(self.config, request_timeout_seconds=float('nan')),
      replace(self.config, request_timeout_seconds=0),
      replace(self.config, max_segment_characters=500),
      replace(self.config, cpu_threads=0),
      replace(self.config, cpu_threads=True),
    ]:
      self.assert_error(503, speech.KokoroSynthesis(config).load)
    self.loader.assert_not_called()

  def test_english_and_spanish_use_distinct_native_preset_voices(self):
    self.load()
    samples = []
    for language in ('en', 'es'):
      for voice in ('coach', 'partner'):
        result = self.provider.synthesize('A clear update.', voice=voice, language=language)
        with wave.open(io.BytesIO(result), 'rb') as audio:
          self.assertEqual((audio.getframerate(), audio.getnchannels(), audio.getsampwidth()), (24000, 1, 2))
          self.assertEqual(audio.getnframes(), 3)
          samples.append(audio.readframes(3))
    self.assertNotEqual(samples[0], samples[1])
    self.assertEqual([call[1] for call in self.engine.calls], ['af_heart', 'am_michael', 'ef_dora', 'em_alex'])
    self.assertEqual([call[1] for call in self.engine.phonemized], ['en', 'en', 'es', 'es'])

  def test_personas_report_only_installed_languages_and_use_exact_presets(self):
    self.load()
    personas = self.provider.health()['personas']
    self.assertEqual(personas, [
      {'id': 'alex', 'name': 'Alex', 'languages': ['en', 'es']},
      {'id': 'sam', 'name': 'Sam', 'languages': ['en', 'es']},
      {'id': 'jordan', 'name': 'Jordan', 'languages': ['en']},
      {'id': 'riley', 'name': 'Riley', 'languages': ['en']},
    ])
    for persona in ('alex', 'sam', 'jordan', 'riley'):
      self.provider.synthesize('A clear update.', voice='partner', persona=persona)
    self.assertEqual([call[1] for call in self.engine.calls], ['af_heart', 'am_michael', 'af_bella', 'bm_george'])

  def test_unavailable_or_unsupported_persona_never_substitutes_another_voice(self):
    self.load()
    for persona in ('arbitrary.wav', '', 42):
      self.assert_error(422, lambda: self.provider.synthesize('Hello.', persona=persona))
    self.assert_error(422, lambda: self.provider.synthesize('Hola.', persona='riley', language='es'))
    del self.engine.voices['af_bella']
    self.assertNotIn('jordan', [item['id'] for item in self.provider.health()['personas']])
    self.assert_error(422, lambda: self.provider.synthesize('Hello.', persona='jordan'))
    self.assertEqual(self.engine.calls, [])

  def test_one_persona_remains_stable_across_all_chunks(self):
    self.load()
    self.provider.synthesize('A clear update for the team. ' * 20, persona='riley')
    self.assertGreater(len(self.engine.calls), 1)
    self.assertEqual({preset for _, preset in self.engine.calls}, {'bm_george'})

  def test_long_text_and_expanded_phonemes_are_all_preserved_in_bounded_segments(self):
    self.load()
    text = 'Explain the API clearly. ' * 90
    self.provider.synthesize(text)
    self.assertEqual(''.join(call[0] for call in self.engine.phonemized), text.strip())
    self.assertTrue(all(len(call[0]) <= 180 for call in self.engine.calls))
    self.engine.calls.clear()
    expanded = 'abcdef' * 120
    self.engine.on_phonemize = lambda text: expanded
    self.provider.synthesize('1234567890')
    self.assertEqual(''.join(call[0] for call in self.engine.calls), expanded)
    self.assertTrue(all(len(call[0]) <= 180 for call in self.engine.calls))

  def test_invalid_requests_fail_before_engine_work(self):
    self.load()
    for text in ('', '   ', 'a' * 2401, None):
      self.assert_error(400, lambda: self.provider.synthesize(text))
    self.assert_error(400, lambda: self.provider.synthesize('Hello', voice='unknown'))
    self.assert_error(422, lambda: self.provider.synthesize('Hello', language='ja'))
    self.assertEqual(self.engine.calls, [])

  def test_empty_pronunciation_does_not_return_a_successful_empty_wav(self):
    self.load()
    self.engine.on_phonemize = lambda text: ''
    self.assert_error(400, lambda: self.provider.synthesize('🦋'))

  def test_cancellation_before_work_and_between_segments(self):
    self.load()
    cancel = threading.Event()
    cancel.set()
    self.assert_error(499, lambda: self.provider.synthesize('Hello', cancel_event=cancel))
    self.assertEqual(self.engine.calls, [])
    cancel.clear()
    def cancel_generation(text, preset):
      cancel.set()
      return np.zeros(3)
    self.engine.on_generate = cancel_generation
    self.assert_error(499, lambda: self.provider.synthesize('A clear sentence. ' * 40, cancel_event=cancel))
    self.assertEqual(len(self.engine.calls), 1)
    self.assertFalse(self.provider._lock.locked())

  def test_waiting_request_can_be_cancelled_without_touching_engine(self):
    self.load()
    cancel = threading.Event()
    self.provider._lock.acquire()
    try:
      with ThreadPoolExecutor(max_workers=1) as executor:
        future = executor.submit(self.provider.synthesize, 'Hello', cancel_event=cancel)
        cancel.set()
        self.assert_error(499, lambda: future.result(timeout=1))
    finally:
      self.provider._lock.release()
    self.assertEqual(self.engine.calls, [])

  def test_deadline_includes_waiting_for_the_engine(self):
    self.provider = speech.KokoroSynthesis(replace(self.config, request_timeout_seconds=0.02))
    self.load()
    self.provider._lock.acquire()
    try:
      self.assert_error(504, lambda: self.provider.synthesize('Hello'))
    finally:
      self.provider._lock.release()
    self.assertEqual(self.engine.calls, [])

  def test_deadline_after_inference_does_not_return_late_audio(self):
    self.provider = speech.KokoroSynthesis(replace(self.config, request_timeout_seconds=0.01))
    self.load()
    def slow_generation(text, preset):
      time.sleep(0.02)
      return np.zeros(3)
    self.engine.on_generate = slow_generation
    self.assert_error(504, lambda: self.provider.synthesize('Hello'))
    self.assertFalse(self.provider._lock.locked())

  def test_invalid_audio_and_engine_failure_are_safe_and_release_lock(self):
    self.load()
    for waveform in (np.array([float('nan')]), np.zeros((2, 4)), np.array([])):
      self.engine.on_generate = lambda text, preset: waveform
      self.assert_error(503, lambda: self.provider.synthesize('Hello'))
      self.assertFalse(self.provider._lock.locked())
    self.engine.on_generate = Mock(side_effect=RuntimeError('private learner text'))
    error = self.assert_error(503, lambda: self.provider.synthesize('Hello'))
    self.assertNotIn('private learner', str(error))

  def test_parallel_voices_are_serialized(self):
    self.load()
    active = 0
    maximum = 0
    def generate(text, preset):
      nonlocal active, maximum
      active += 1
      maximum = max(maximum, active)
      time.sleep(0.01)
      active -= 1
      return np.zeros(3)
    self.engine.on_generate = generate
    with ThreadPoolExecutor(max_workers=2) as executor:
      a = executor.submit(self.provider.synthesize, 'First.', voice='coach')
      b = executor.submit(self.provider.synthesize, 'Second.', voice='partner')
      a.result(timeout=2)
      b.result(timeout=2)
    self.assertEqual(maximum, 1)

  def test_onnx_contract_pads_tokens_and_selects_the_matching_voice_vector(self):
    engine = speech._OnnxEngine.__new__(speech._OnnxEngine)
    engine.session = Mock()
    engine.session.run.return_value = [np.array([0.1])]
    engine.vocab = {'a': 43, 'b': 44}
    styles = np.zeros((510, 1, 256), dtype=np.float32)
    styles[1] = 0.5
    engine.voices = {'af_heart': styles}
    engine.generate('ab', 'af_heart')
    inputs = engine.session.run.call_args.args[1]
    np.testing.assert_array_equal(inputs['tokens'], [[0, 43, 44, 0]])
    self.assertEqual(inputs['tokens'].dtype, np.int64)
    np.testing.assert_array_equal(inputs['style'], np.full((1, 256), 0.5))
    self.assert_error(503, lambda: engine.generate('a' * 511, 'af_heart'))


if __name__ == '__main__':
  unittest.main()
