"""Fast provider tests using a fake engine, without Torch or downloaded models."""

import io
import os
import subprocess
import sys
import tempfile
import threading
import unittest
import wave
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

import numpy as np

import chatterbox_synthesis as speech


load_engine = speech._load_engine


class FakeEngine:
  sr = 24000

  def __init__(self):
    self.conds = None
    self.prepared = []
    self.calls = []
    self.on_generate = None

  def prepare_conditionals(self, reference, exaggeration):
    self.conds = {'voice': Path(reference).stem, 'exaggeration': exaggeration}
    self.prepared.append((reference, self.conds))

  def generate(self, text, **options):
    conditioning = self.conds
    self.calls.append((text, conditioning, options))
    if self.on_generate is not None:
      return self.on_generate(text, conditioning, options)
    # Treat this as the final, already-watermarked engine output. The wrapper
    # must preserve the samples except for the required PCM16 quantization.
    gain = 1 if conditioning['voice'] == 'coach' else -1
    return np.array([[-0.75, -0.1, 0, 0.1, 0.75]], dtype=np.float32) * gain


def write_reference(path: Path, sample: int):
  path.parent.mkdir(parents=True, exist_ok=True)
  with wave.open(str(path), 'wb') as output:
    output.setnchannels(1)
    output.setsampwidth(2)
    output.setframerate(8000)
    output.writeframes(sample.to_bytes(2, 'little', signed=True) * 24000)


class ChatterboxSynthesisTests(unittest.TestCase):
  def setUp(self):
    temporary = tempfile.TemporaryDirectory(prefix='mentor-fake-chatterbox-')
    self.addCleanup(temporary.cleanup)
    self.directory = Path(temporary.name)
    for filename in (*speech.REQUIRED_MODEL_FILES, *speech.REQUIRED_TOKENIZER_FILES):
      asset = self.directory / filename
      asset.parent.mkdir(parents=True, exist_ok=True)
      asset.write_bytes(b'fake model; never loaded')
    write_reference(self.directory / 'voices' / 'coach.wav', 100)
    write_reference(self.directory / 'voices' / 'partner.wav', 200)
    self.config = speech.ChatterboxConfig(model_path=self.directory)
    self.engine = FakeEngine()
    self.loader = patch.object(speech, '_load_engine', return_value=self.engine).start()
    self.resolver = patch.object(speech, '_resolve_device', return_value='mps').start()
    self.environment = patch.dict(os.environ, {}).start()
    self.addCleanup(patch.stopall)
    self.provider = speech.ChatterboxSynthesis(self.config)

  def load(self):
    self.provider.load()
    return self.provider

  def assert_error(self, status, call):
    with self.assertRaises(speech.SynthesisError) as caught:
      call()
    self.assertEqual(caught.exception.status_code, status)
    return caught.exception

  def test_module_import_does_not_load_heavy_dependencies(self):
    command = (
      'import sys; '
      f'sys.path.insert(0, {str(Path(__file__).parent)!r}); '
      'import chatterbox_synthesis; '
      'assert not any(name in sys.modules for name in ("torch", "chatterbox", "numpy"))'
    )
    result = subprocess.run([sys.executable, '-S', '-c', command], capture_output=True, text=True, timeout=10)
    self.assertEqual(result.returncode, 0, result.stderr)

  def test_load_is_offline_once_and_prepares_two_cached_voices(self):
    os.environ['HF_HUB_OFFLINE'] = '0'
    os.environ['TRANSFORMERS_OFFLINE'] = '0'
    self.assertFalse(self.provider.health()['ready'])
    self.load()
    self.provider.load()
    self.loader.assert_called_once_with(self.directory, 'mps')
    self.assertEqual(os.environ['HF_HUB_OFFLINE'], '1')
    self.assertEqual(os.environ['TRANSFORMERS_OFFLINE'], '1')
    self.assertEqual(os.environ['HF_HUB_DISABLE_TELEMETRY'], '1')
    self.assertEqual(os.environ['PKUSEG_HOME'], str(self.directory / 'pkuseg'))
    self.assertEqual(len(self.engine.prepared), 2)
    self.assertIsNot(self.engine.prepared[0][1], self.engine.prepared[1][1])
    health = self.provider.health()
    self.assertTrue(health['ready'])
    self.assertTrue(health['synthesis'])
    self.assertTrue(health['conversationSynthesis'])
    self.assertEqual(health['device'], 'mps')
    self.assertEqual(len(health['languages']), 23)
    self.assertNotEqual(health['voices']['coach'], health['voices']['partner'])
    self.assertNotIn(str(self.directory), str(health))

  def test_engine_loader_uses_local_v3_only(self):
    # Inject only the official package boundary; no real model is imported.
    with patch.dict(sys.modules, {'chatterbox': SimpleNamespace(), 'chatterbox.mtl_tts': SimpleNamespace(ChatterboxMultilingualTTS=SimpleNamespace(from_local=Mock(return_value=self.engine)))}):
      result = load_engine(self.directory, 'mps')
      self.assertIs(result, self.engine)
      sys.modules['chatterbox.mtl_tts'].ChatterboxMultilingualTTS.from_local.assert_called_once_with(str(self.directory), device='mps', t3_model='v3')

  def test_configuration_reads_only_trusted_environment_paths(self):
    with patch.dict(os.environ, {
      'MENTOR_CHATTERBOX_MODEL': str(self.directory),
      'MENTOR_CHATTERBOX_DEVICE': 'cpu',
      'MENTOR_CHATTERBOX_COACH_REFERENCE': str(self.directory / 'voices' / 'coach.wav'),
      'MENTOR_CHATTERBOX_PARTNER_REFERENCE': str(self.directory / 'voices' / 'partner.wav'),
    }):
      config = speech.ChatterboxConfig.from_env()
    self.assertEqual(config.model_path, self.directory)
    self.assertEqual(config.device, 'cpu')
    self.assertEqual(config.coach_reference.name, 'coach.wav')
    self.assertEqual(config.partner_reference.name, 'partner.wav')

  def test_failed_load_is_safe_and_never_reports_synthesis_ready(self):
    self.loader.side_effect = RuntimeError(f'private detail {self.directory}')
    error = self.assert_error(503, self.provider.load)
    self.assertNotIn(str(self.directory), str(error))
    self.assertFalse(self.provider.health()['ready'])
    self.assertEqual(self.provider.health()['voices'], {})
    self.assertNotIn('device', self.provider.health())
    self.assert_error(503, lambda: self.provider.synthesize('Hello.'))
    self.assertEqual(self.engine.calls, [])

  def test_missing_assets_and_identical_references_fail_before_engine_load(self):
    missing = self.directory / speech.REQUIRED_MODEL_FILES[0]
    missing.unlink()
    self.assert_error(503, self.provider.load)
    self.loader.assert_not_called()
    missing.write_bytes(b'fake')
    same = self.directory / 'voices' / 'coach.wav'
    self.provider = speech.ChatterboxSynthesis(replace(self.config, partner_reference=same))
    self.assert_error(503, self.provider.load)
    self.loader.assert_not_called()
    (self.directory / 'voices' / 'partner.wav').write_bytes(same.read_bytes())
    self.provider = speech.ChatterboxSynthesis(self.config)
    self.assert_error(503, self.provider.load)
    self.loader.assert_not_called()

  def test_missing_offline_tokenizer_cache_fails_before_dependency_import(self):
    for name in speech.REQUIRED_TOKENIZER_FILES:
      asset = self.directory / name
      original = asset.read_bytes()
      asset.unlink()
      try:
        self.assert_error(503, self.provider.load)
        self.loader.assert_not_called()
      finally:
        asset.write_bytes(original)

  def test_reference_audio_must_be_valid_pcm_and_useful_duration(self):
    reference = self.directory / 'voices' / 'partner.wav'
    reference.write_bytes(b'invalid wave')
    self.assert_error(503, self.provider.load)
    with wave.open(str(reference), 'wb') as output:
      output.setnchannels(1)
      output.setsampwidth(2)
      output.setframerate(8000)
      output.writeframes(b'\0\0' * 100)
    self.assert_error(503, self.provider.load)
    self.loader.assert_not_called()

  def test_wrong_model_sample_rate_and_shared_conditioning_fail_safely(self):
    self.engine.sr = 22050
    self.assert_error(503, self.provider.load)
    self.engine.sr = 24000
    shared = {'voice': 'same'}
    def prepare(_path, exaggeration):
      self.engine.conds = shared
    self.engine.prepare_conditionals = prepare
    self.assert_error(503, self.provider.load)
    self.assertFalse(self.provider.health()['ready'])

  def test_invalid_input_never_reaches_generation(self):
    self.load()
    for text in ('', ' \n ', 'x' * 2401, None, 4):
      self.assert_error(400, lambda: self.provider.synthesize(text))
    for voice in ('unknown', '/tmp/voice.wav', {}, None):
      self.assert_error(400, lambda: self.provider.synthesize('Hello.', voice=voice))
    for language in ('unknown', 'EN', {}, None):
      self.assert_error(400, lambda: self.provider.synthesize('Hello.', language=language))
    self.assertEqual(self.engine.calls, [])

  def test_unloaded_provider_does_not_load_models_during_a_request(self):
    self.assert_error(503, lambda: self.provider.synthesize('Hello.'))
    self.loader.assert_not_called()

  def test_distinct_voices_keep_conditioning_and_final_watermarked_samples(self):
    self.load()
    outputs = [self.provider.synthesize('Hello.', voice) for voice in ('coach', 'partner', 'coach')]
    self.assertNotEqual(outputs[0], outputs[1])
    self.assertEqual(outputs[0], outputs[2])
    self.assertEqual(len(self.engine.prepared), 2)
    self.assertEqual([call[1]['voice'] for call in self.engine.calls], ['coach', 'partner', 'coach'])
    with wave.open(io.BytesIO(outputs[0]), 'rb') as audio:
      self.assertEqual((audio.getframerate(), audio.getnchannels(), audio.getsampwidth()), (24000, 1, 2))
      samples = np.frombuffer(audio.readframes(audio.getnframes()), dtype='<i2')
      self.assertEqual(samples.tolist(), [-24575, -3277, 0, 3277, 24575])
    self.assertNotIn('audio_prompt_path', self.engine.calls[0][2])

  def test_all_supported_languages_pass_explicit_language_to_engine(self):
    self.load()
    for language in speech.SUPPORTED_LANGUAGES:
      self.provider.synthesize('A short example.', language=language)
      self.assertEqual(self.engine.calls[-1][2]['language_id'], language)
      self.assertEqual(self.engine.calls[-1][2]['cfg_weight'], 0.5 if language == 'en' else 0.0)

  def test_long_text_is_complete_and_segments_are_bounded(self):
    self.load()
    original = ('This first sentence explains the problem. The next one explains a useful solution! ' * 35)[:2400]
    self.provider.synthesize(original)
    pieces = [call[0] for call in self.engine.calls]
    self.assertEqual(''.join(pieces), original.strip())
    self.assertTrue(all(len(piece) <= 180 for piece in pieces))
    self.assertGreater(len(pieces), 1)
    self.engine.calls.clear()
    original = '这是完整的故事。' * 100
    self.provider.synthesize(original, language='zh')
    self.assertEqual(''.join(call[0] for call in self.engine.calls), original)
    self.assertTrue(all(len(call[0]) <= 80 for call in self.engine.calls))

  def test_concurrent_calls_serialize_and_never_mix_voice_conditioning(self):
    self.load()
    entered = threading.Event()
    release = threading.Event()
    def generate(_text, conditioning, _options):
      if conditioning['voice'] == 'coach':
        entered.set()
        if not release.wait(2):
          raise RuntimeError('test coordination timeout')
      self.assertIs(self.engine.conds, conditioning)
      return np.ones((1, 10), dtype=np.float32) * 0.1
    self.engine.on_generate = generate
    with ThreadPoolExecutor(max_workers=2) as executor:
      first = executor.submit(self.provider.synthesize, 'Coach speaking.', 'coach')
      self.assertTrue(entered.wait(2))
      second = executor.submit(self.provider.synthesize, 'Partner speaking.', 'partner')
      try:
        self.assertEqual(len(self.engine.calls), 1)
      finally:
        release.set()
      first.result(timeout=2)
      second.result(timeout=2)
    self.assertEqual([call[1]['voice'] for call in self.engine.calls], ['coach', 'partner'])

  def test_cancelled_queued_request_never_generates(self):
    self.load()
    cancellation = threading.Event()
    self.provider._lock.acquire()
    try:
      with ThreadPoolExecutor(max_workers=1) as executor:
        pending = executor.submit(self.provider.synthesize, 'Queued passage.', cancel_event=cancellation)
        cancellation.set()
        self.assert_error(499, lambda: pending.result(timeout=1))
      self.assertEqual(self.engine.calls, [])
    finally:
      self.provider._lock.release()
    self.provider.synthesize('The next request still works.')

  def test_cancellation_between_segments_returns_no_partial_audio(self):
    self.load()
    cancellation = threading.Event()
    def generate(_text, _conditioning, _options):
      cancellation.set()
      return np.ones((1, 10), dtype=np.float32) * 0.1
    self.engine.on_generate = generate
    self.assert_error(499, lambda: self.provider.synthesize('A complete sentence. ' * 40, cancel_event=cancellation))
    self.assertEqual(len(self.engine.calls), 1)
    self.assertFalse(self.provider._lock.locked())

  def test_request_deadline_includes_time_waiting_for_the_lock(self):
    self.provider = speech.ChatterboxSynthesis(replace(self.config, request_timeout_seconds=0.01))
    self.load()
    self.provider._lock.acquire()
    try:
      self.assert_error(504, lambda: self.provider.synthesize('Waiting too long.'))
      self.assertEqual(self.engine.calls, [])
    finally:
      self.provider._lock.release()

  def test_request_deadline_checked_after_engine_returns(self):
    self.load()
    clock = [10.0]
    def generate(_text, _conditioning, _options):
      clock[0] += 46
      return np.ones((1, 10), dtype=np.float32) * 0.1
    self.engine.on_generate = generate
    with patch.object(speech.time, 'monotonic', side_effect=lambda: clock[0]):
      self.assert_error(504, lambda: self.provider.synthesize('This output is late.'))
    self.assertFalse(self.provider._lock.locked())

  def test_generation_failure_keeps_private_text_out_of_public_errors(self):
    self.load()
    private = 'My private learner story.'
    def generate(_text, _conditioning, _options):
      raise RuntimeError(f'{private} {self.directory}')
    self.engine.on_generate = generate
    error = self.assert_error(503, lambda: self.provider.synthesize(private))
    self.assertNotIn(private, str(error))
    self.assertNotIn(str(self.directory), str(error))
    self.assertTrue(self.provider.health()['ready'])
    self.assertFalse(self.provider._lock.locked())

  def test_malformed_audio_is_rejected_without_partial_output(self):
    self.load()
    for output in (np.array([]), np.array([np.nan]), np.array([np.inf]), np.zeros((2, 10)), np.array(['bad']), np.array([1j])):
      self.engine.on_generate = lambda *_args: output
      self.assert_error(503, lambda: self.provider.synthesize('Hello.'))
      self.assertFalse(self.provider._lock.locked())


class SpeechSplittingTests(unittest.TestCase):
  def test_preserves_complete_text_for_sentences_words_cjk_and_long_tokens(self):
    for text in (
      '  One sentence.\nA second one! A third question?\n\nAnd its answer.  ',
      'word ' * 100,
      'x' * 1000,
      '先说明情况。然后解释原因！最后给出结果？' * 50,
      'A. ' + ' ' * 200 + 'Next thought.',
    ):
      with self.subTest(text=text[:30]):
        segments = speech.split_speech_text(text, 40)
        self.assertEqual(''.join(segments), text.strip())
        self.assertTrue(all(0 < len(segment) <= 40 for segment in segments))

  def test_prefers_complete_sentences_and_handles_empty_text(self):
    self.assertEqual(speech.split_speech_text('One sentence. A second sentence. A third sentence.', 35), ['One sentence. A second sentence. ', 'A third sentence.'])
    self.assertEqual(speech.split_speech_text('  '), [])
    with self.assertRaises(ValueError):
      speech.split_speech_text('Hello.', 0)


class DeviceSelectionTests(unittest.TestCase):
  def test_auto_prefers_mps_and_explicit_unavailable_mps_fails(self):
    available = Mock(return_value=True)
    fake_torch = SimpleNamespace(backends=SimpleNamespace(mps=SimpleNamespace(is_available=available)))
    with patch.dict(sys.modules, {'torch': fake_torch}):
      self.assertEqual(speech._resolve_device('auto'), 'mps')
      self.assertEqual(speech._resolve_device('cpu'), 'cpu')
      available.return_value = False
      self.assertEqual(speech._resolve_device('auto'), 'cpu')
      with self.assertRaises(speech.SynthesisError):
        speech._resolve_device('mps')
      with self.assertRaises(speech.SynthesisError):
        speech._resolve_device('cuda')


if __name__ == '__main__':
  unittest.main(verbosity=2)
