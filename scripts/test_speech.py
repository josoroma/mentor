"""Local integration tests; requires speech:setup but no running server."""

import io
import os
import unittest
import wave
from unittest.mock import patch

from fastapi.testclient import TestClient
# This suite explicitly verifies the retained macOS provider.
os.environ['MENTOR_TTS_PROVIDER'] = 'macos'
import speech_server
from speech_server import app, load_voices, resolve_installed_voice


class SpeechIntegrationTests(unittest.TestCase):
  @classmethod
  def setUpClass(cls):
    # Neural providers are tested separately; this real ASR round trip must not
    # allocate a second copy of either resident neural model.
    cls.neural_patch = patch.object(speech_server, 'load_neural_synthesis')
    cls.default_patch = patch.object(speech_server, 'TTS_PROVIDER', 'macos')
    cls.neural_patch.start()
    cls.default_patch.start()
    cls.client = TestClient(app)
    cls.client.__enter__()

  @classmethod
  def tearDownClass(cls):
    cls.client.__exit__(None, None, None)
    cls.default_patch.stop()
    cls.neural_patch.stop()

  def test_health_reports_loaded_local_model(self):
    status = self.client.get('/health').json()
    self.assertTrue(status['recognition'])
    self.assertTrue(status['synthesis'])
    self.assertTrue(status['conversationSynthesis'])
    self.assertNotEqual(status['voices']['coach'], status['voices']['partner'])

  def test_two_installed_voices_produce_distinct_nonempty_pcm(self):
    samples = []
    for voice in ('coach', 'partner'):
      response = self.client.post('/speech', json={'text': 'A clear example makes your story easier to follow.', 'voice': voice})
      self.assertEqual(response.status_code, 200)
      self.assertEqual(response.headers['cache-control'], 'no-store')
      with wave.open(io.BytesIO(response.content), 'rb') as recording:
        self.assertEqual(recording.getframerate(), 22050)
        self.assertGreater(recording.getnframes(), 22050)
        samples.append(recording.readframes(recording.getnframes()))
    self.assertNotEqual(samples[0], samples[1])

  def test_arbitrary_voice_names_are_rejected(self):
    for voice in ('Daniel', 'missing', 'Samantha; touch /tmp/mentor-invalid', None):
      self.assertEqual(self.client.post('/speech', json={'text': 'Hello.', 'voice': voice}).status_code, 422)

  def test_missing_partner_is_reported_without_using_coach(self):
    with patch.dict(speech_server.voices, {'coach': 'Samantha'}, clear=True):
      response = self.client.post('/speech', json={'text': 'Hello.', 'voice': 'partner'})
      self.assertEqual(response.status_code, 503)
      self.assertIn('voice', response.json()['detail'])

  def test_installed_voice_names_resolve_only_unique_english_aliases(self):
    self.assertEqual(resolve_installed_voice('Samantha', {'Samantha (English (US))'}), 'Samantha (English (US))')
    for name in ('Missing', 'Samantha; say hello'):
      with self.assertRaises(ValueError):
        resolve_installed_voice(name, {'Samantha (English (US))'})
    with self.assertRaises(ValueError):
      resolve_installed_voice('Sam', {'Sam (English (US))', 'Sam (English (UK))'})

  def test_same_configured_voice_does_not_silently_make_two_identical_speakers(self):
    with patch.dict(speech_server.voices, {}, clear=True), patch.dict(speech_server.voice_errors, {}, clear=True):
      with patch.object(speech_server, 'VOICE', 'Samantha'), patch.object(speech_server, 'PARTNER_VOICE', 'Samantha'):
        load_voices()
        self.assertIn('coach', speech_server.voices)
        self.assertNotIn('partner', speech_server.voices)
        self.assertIn('different', speech_server.voice_errors['partner'])

  def test_synthesis_and_recognition_round_trip(self):
    audio = self.client.post('/speech', json={'text': 'Yesterday I fixed the login bug. Today I will request a code review.'})
    self.assertEqual(audio.status_code, 200)
    self.assertTrue(audio.content.startswith(b'RIFF'))
    result = self.client.post('/transcribe', files={'audio': ('turn.wav', audio.content, 'audio/wav')})
    self.assertEqual(result.status_code, 200)
    self.assertIn('login', result.json()['text'].lower())
    self.assertIn('code review', result.json()['text'].lower())

  def test_silence_does_not_create_a_hallucinated_turn(self):
    buffer = io.BytesIO()
    with wave.open(buffer, 'wb') as recording:
      recording.setnchannels(1)
      recording.setsampwidth(2)
      recording.setframerate(16000)
      recording.writeframes(b'\x00\x00' * 16000)
    result = self.client.post('/transcribe', files={'audio': ('silence.wav', buffer.getvalue(), 'audio/wav')})
    self.assertEqual(result.json()['text'], '')

  def test_invalid_audio_is_rejected(self):
    result = self.client.post('/transcribe', files={'audio': ('bad.wav', b'not audio', 'audio/wav')})
    self.assertEqual(result.status_code, 422)

  def test_empty_speech_is_rejected(self):
    self.assertEqual(self.client.post('/speech', json={'text': '   '}).status_code, 400)


if __name__ == '__main__':
  unittest.main(verbosity=2)
