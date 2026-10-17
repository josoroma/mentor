"""Fast service-boundary tests. No model download or neural inference required."""

import asyncio
import threading
import unittest
from unittest.mock import patch

from fastapi import HTTPException
from fastapi.testclient import TestClient
from chatterbox_synthesis import SynthesisError, SynthesisTimeoutError
import speech_server


class FakeSynthesizer:
  def __init__(self, provider='chatterbox'):
    self.provider = provider
    self.calls = []
    self.persona_calls = []

  def health(self):
    return {
      'provider': self.provider, 'synthesisModel': speech_server.NEURAL_MODELS[self.provider],
      'device': 'mps', 'languages': ['en', 'es'], 'synthesis': True,
      'conversationSynthesis': True, 'voices': {'coach': 'Alex', 'partner': 'Sam'},
      'detail': None,
      'personas': [
        {'id': persona, 'name': name, 'languages': ['en']}
        for persona, name in speech_server.PERSONA_NAMES.items()
      ] if self.provider == 'kokoro' else [],
    }

  def synthesize(self, text, voice, language, cancel_event=None, persona=None):
    self.calls.append((text, voice, language))
    if persona is not None:
      self.persona_calls.append(persona)
    return b'RIFFtest audio'


class SpeechServiceTests(unittest.TestCase):
  def setUp(self):
    self.engine = FakeSynthesizer()
    self.kokoro = FakeSynthesizer('kokoro')
    self.patches = [
      patch.object(speech_server, 'TTS_PROVIDER', 'chatterbox'),
      patch.dict(speech_server.synthesizers, {'chatterbox': self.engine, 'kokoro': self.kokoro}, clear=True),
      patch.dict(speech_server.synthesis_errors, {}, clear=True),
      patch.object(speech_server, 'model', object()),
      patch.object(speech_server, 'model_error', None),
      patch.object(speech_server, 'synthesis_slots', threading.BoundedSemaphore(3)),
      patch.dict(speech_server.persona_voices, {
        'alex': 'Samantha', 'sam': 'Daniel', 'jordan': 'Karen', 'riley': 'Moira',
      }, clear=True),
    ]
    for item in self.patches:
      item.start()
    # No lifespan entry: these tests deliberately use the injected local engine.
    self.client = TestClient(speech_server.app)

  def tearDown(self):
    self.client.close()
    for item in reversed(self.patches):
      item.stop()

  def test_english_default_and_explicit_spanish_preserve_voice(self):
    for payload, expected in [
      ({'text': '  Hello. '}, ('Hello.', 'coach', 'en')),
      ({'text': 'Hola.', 'voice': 'partner', 'language': 'es'}, ('Hola.', 'partner', 'es')),
    ]:
      response = self.client.post('/speech', json=payload)
      self.assertEqual(response.status_code, 200)
      self.assertEqual(response.headers['content-type'], 'audio/wav')
      self.assertEqual(response.headers['cache-control'], 'no-store')
      self.assertEqual(response.headers['x-mentor-speech-provider'], 'chatterbox')
      self.assertEqual(self.engine.calls[-1], expected)

  def test_invalid_synthesis_inputs_never_reach_model(self):
    for payload in [
      {'text': 'Hello.', 'language': 'unsupported'},
      {'text': 'Hello.', 'voice': 'arbitrary-reference.wav'},
      {'text': 'Hello.', 'audio_prompt_path': '/tmp/arbitrary.wav'},
      {'text': 'Hello.', 'provider': 'hosted'},
      {'text': 'Hello.', 'persona': '/tmp/arbitrary.wav'},
      {'text': 'x' * 2401},
    ]:
      self.assertEqual(self.client.post('/speech', json=payload).status_code, 422)
    self.assertEqual(self.client.post('/speech', json={'text': '  '}).status_code, 400)
    self.assertEqual(self.engine.calls, [])

  def test_explicit_chatterbox_persona_maps_to_the_correct_cached_reference(self):
    for persona, expected_voice in [('alex', 'coach'), ('sam', 'partner')]:
      response = self.client.post('/speech', json={
        'text': 'Hello.', 'voice': 'partner', 'provider': 'chatterbox', 'persona': persona,
      })
      self.assertEqual(response.status_code, 200)
      self.assertEqual(response.headers['x-mentor-speech-persona'], persona)
      self.assertEqual(self.engine.calls[-1], ('Hello.', expected_voice, 'en'))
    for persona in ('jordan', 'riley'):
      response = self.client.post('/speech', json={'text': 'Hello.', 'provider': 'chatterbox', 'persona': persona})
      self.assertEqual(response.status_code, 422)
    self.assertEqual(len(self.engine.calls), 2)

  def test_kokoro_persona_is_forwarded_without_replacing_legacy_voice(self):
    response = self.client.post('/speech', json={'text': 'Hello.', 'provider': 'kokoro', 'persona': 'riley'})
    self.assertEqual(response.status_code, 200)
    self.assertEqual(response.headers['x-mentor-speech-persona'], 'riley')
    self.assertEqual(self.kokoro.persona_calls, ['riley'])
    self.assertEqual(self.engine.calls, [])

  def test_macos_persona_uses_exact_installed_voice_and_never_falls_back(self):
    with patch.object(speech_server.shutil, 'which', return_value='/installed/tool'), \
        patch.object(speech_server, 'render_macos_audio', return_value=b'RIFFsystem') as render:
      response = self.client.post('/speech', json={'text': 'Hello.', 'provider': 'macos', 'persona': 'jordan'})
      self.assertEqual(response.status_code, 200)
      self.assertEqual(render.call_args.args[1], 'Karen')
      del speech_server.persona_voices['jordan']
      response = self.client.post('/speech', json={'text': 'Hello.', 'provider': 'macos', 'persona': 'jordan'})
      self.assertEqual(response.status_code, 422)
      self.assertEqual(render.call_count, 1)

  def test_health_reports_only_available_builtin_personas(self):
    with patch.dict(speech_server.voices, {'coach': 'Samantha', 'partner': 'Daniel'}, clear=True), \
        patch.object(speech_server.shutil, 'which', return_value='/installed/tool'):
      health = self.client.get('/health').json()
      self.assertEqual([item['id'] for item in health['providers']['macos']['personas']], ['alex', 'sam', 'jordan', 'riley'])
      self.assertEqual(health['providers']['chatterbox']['personas'], [
        {'id': 'alex', 'name': 'Alex', 'languages': ['en', 'es']},
        {'id': 'sam', 'name': 'Sam', 'languages': ['en', 'es']},
      ])
      del speech_server.persona_voices['riley']
      self.assertNotIn('riley', [item['id'] for item in speech_server.provider_health('macos')['personas']])

  def test_macos_extra_personas_require_distinct_installed_english_voices(self):
    listing = 'Samantha en_US # Hello\nDaniel en_GB # Hello\nKaren en_AU # Hello\nMoira en_IE # Hello\n'
    with patch.dict(speech_server.voices, {}, clear=True), patch.dict(speech_server.voice_errors, {}, clear=True), \
        patch.object(speech_server.subprocess, 'run') as process, \
        patch.object(speech_server, 'VOICE', 'Samantha'), patch.object(speech_server, 'PARTNER_VOICE', 'Daniel'):
      process.return_value.stdout = listing
      speech_server.load_voices()
      self.assertEqual(speech_server.persona_voices, {'alex': 'Samantha', 'sam': 'Daniel', 'jordan': 'Karen', 'riley': 'Moira'})
      process.return_value.stdout = listing.replace('Moira en_IE # Hello\n', '')
      speech_server.load_voices()
      self.assertNotIn('riley', speech_server.persona_voices)
      with patch.object(speech_server, 'VOICE', 'Karen'):
        speech_server.load_voices()
        self.assertEqual(speech_server.persona_voices['alex'], 'Karen')
        self.assertNotIn('jordan', speech_server.persona_voices)

  def test_health_keeps_recognition_and_synthesis_independent(self):
    with patch.object(speech_server, 'model', None):
      health = self.client.get('/health').json()
      self.assertFalse(health['available'])
      self.assertFalse(health['recognition'])
      self.assertTrue(health['synthesis'])
      self.assertEqual(health['synthesisModel'], 'Chatterbox Multilingual V3')
      self.assertEqual(health['model'], speech_server.MODEL_PATH.name)
      self.assertEqual(health['languages'], ['en', 'es'])
      self.assertEqual(set(health['providers']), {'macos', 'chatterbox', 'kokoro'})
      self.assertTrue(health['providers']['kokoro']['synthesis'])

  def test_failed_chatterbox_does_not_switch_to_macos(self):
    with patch.dict(speech_server.synthesizers, {'kokoro': self.kokoro}, clear=True), patch.object(speech_server, 'synthesize_macos') as macos:
      response = self.client.post('/speech', json={'text': 'Hello.'})
      self.assertEqual(response.status_code, 503)
      macos.assert_not_called()
      self.assertEqual(self.kokoro.calls, [])

  def test_each_requested_provider_is_selected_without_changing_default(self):
    with patch.object(speech_server, 'synthesize_macos', return_value=b'RIFFsystem') as macos:
      for provider in ('macos', 'kokoro', 'chatterbox'):
        response = self.client.post('/speech', json={'text': 'Hello.', 'voice': 'partner', 'provider': provider})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers['x-mentor-speech-provider'], provider)
      macos.assert_called_once()
      self.assertEqual(self.engine.calls, [('Hello.', 'partner', 'en')])
      self.assertEqual(self.kokoro.calls, [('Hello.', 'partner', 'en')])
      self.assertEqual(self.client.get('/health').json()['provider'], 'chatterbox')

  def test_request_can_use_ready_kokoro_when_default_is_unavailable(self):
    with patch.dict(speech_server.synthesizers, {'kokoro': self.kokoro}, clear=True):
      health = self.client.get('/health').json()
      self.assertFalse(health['available'])
      self.assertTrue(health['recognition'])
      self.assertTrue(health['providers']['kokoro']['synthesis'])
      self.assertEqual(self.client.post('/speech', json={'text': 'Hello.', 'provider': 'kokoro'}).status_code, 200)
      self.assertEqual(self.client.post('/speech', json={'text': 'Hello.'}).status_code, 503)

  def test_system_speech_rejects_unsupported_language_without_substitution(self):
    with patch.object(speech_server, 'synthesize_macos') as macos:
      response = self.client.post('/speech', json={'text': 'Hola.', 'language': 'es', 'provider': 'macos'})
      self.assertEqual(response.status_code, 422)
      macos.assert_not_called()
      self.assertEqual(self.engine.calls, [])
      self.assertEqual(self.kokoro.calls, [])

  def test_startup_warms_model_before_exposing_it_as_ready(self):
    with patch.object(speech_server, 'create_neural_synthesizer') as factory, patch.object(speech_server, 'load_voices') as voice_loader:
      speech_server.load_synthesis()
      voice_loader.assert_called_once_with()
      self.assertEqual(factory.call_count, 2)
      self.assertEqual(factory.return_value.load.call_count, 2)
      self.assertEqual(factory.return_value.synthesize.call_count, 2)
      factory.return_value.synthesize.assert_called_with('Hello. Let us practice together.')
      self.assertIs(speech_server.synthesizers['chatterbox'], factory.return_value)
      self.assertIs(speech_server.synthesizers['kokoro'], factory.return_value)
    with patch.object(speech_server, 'create_neural_synthesizer') as factory, patch.object(speech_server, 'load_voices'):
      factory.return_value.synthesize.side_effect = SynthesisTimeoutError()
      speech_server.load_synthesis()
      self.assertEqual(speech_server.synthesizers, {})
      self.assertFalse(speech_server.health()['synthesis'])

  def test_startup_keeps_other_providers_when_one_model_fails(self):
    with patch.object(speech_server, 'create_neural_synthesizer') as factory, patch.object(speech_server, 'load_voices') as voice_loader:
      ready = factory.return_value
      def create(provider):
        if provider == 'kokoro':
          return ready
        raise RuntimeError('private path')
      factory.side_effect = create
      speech_server.load_synthesis()
      self.assertEqual(set(speech_server.synthesizers), {'kokoro'})
      self.assertEqual(set(speech_server.synthesis_errors), {'chatterbox'})
      self.assertNotIn('private', speech_server.synthesis_errors['chatterbox'])
      voice_loader.assert_called_once_with()

  def test_queue_is_bounded_before_model_work_starts(self):
    for _ in range(3):
      self.assertTrue(speech_server.synthesis_slots.acquire(blocking=False))
    response = self.client.post('/speech', json={'text': 'Hello.'})
    self.assertEqual(response.status_code, 429)
    self.assertEqual(self.engine.calls, [])
    for _ in range(3):
      speech_server.synthesis_slots.release()

  def test_provider_statuses_are_preserved_and_unexpected_errors_are_private(self):
    for error, status in [
      (SynthesisError('Choose a supported language.', 400), 400),
      (SynthesisTimeoutError(), 504),
      (RuntimeError('private prompt and /private/model/path'), 503),
    ]:
      with patch.object(self.engine, 'synthesize', side_effect=error):
        response = self.client.post('/speech', json={'text': 'Hello.'})
      self.assertEqual(response.status_code, status)
      self.assertNotIn('private', response.text)

  def test_disconnect_and_timeout_cancel_work_and_release_capacity(self):
    for disconnected, expected_status in [(True, 499), (False, 504)]:
      observed = threading.Event()
      started = threading.Event()
      class FakeRequest:
        async def is_disconnected(self):
          return disconnected and started.is_set()

      def cancellable(_text, _voice, _language, cancel_event=None):
        started.set()
        self.assertTrue(cancel_event.wait(timeout=2))
        observed.set()
        return b'RIFFlate audio'

      async def run():
        with self.assertRaises(HTTPException) as caught:
          await speech_server.speech(speech_server.SpeechRequest(text='Hello.'), FakeRequest())
        self.assertEqual(caught.exception.status_code, expected_status)
        for _ in range(50):
          if observed.is_set():
            break
          await asyncio.sleep(0.01)
        self.assertTrue(observed.is_set())
        await asyncio.sleep(0.01)

      with patch.object(self.engine, 'synthesize', side_effect=cancellable), patch.object(speech_server, 'SYNTHESIS_TIMEOUT', 0.12 if disconnected else 0.03):
        asyncio.run(run())
      for _ in range(3):
        self.assertTrue(speech_server.synthesis_slots.acquire(blocking=False))
      for _ in range(3):
        speech_server.synthesis_slots.release()


if __name__ == '__main__':
  unittest.main(verbosity=2)
