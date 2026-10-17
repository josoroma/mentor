"""Checksum enforcement and safe, repeatable local model installation."""

import hashlib
import importlib.util
import io
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


spec = importlib.util.spec_from_file_location('mentor_kokoro_setup', Path(__file__).with_name('setup-kokoro.py'))
setup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(setup)


class KokoroSetupTests(unittest.TestCase):
  def test_exact_verified_assets_are_reused_without_network(self):
    payload = b'pinned model bytes'
    digest = hashlib.sha256(payload).hexdigest()
    with tempfile.TemporaryDirectory() as directory:
      root = Path(directory)
      with patch.object(setup, 'MODEL_PATH', root), \
          patch.object(setup.urllib.request, 'urlopen', return_value=io.BytesIO(payload)) as network:
        setup.stage_asset('model.onnx', 'https://example.invalid/model', digest)
        setup.stage_asset('model.onnx', 'https://example.invalid/model', digest)
      network.assert_called_once()
      self.assertEqual((root / 'model.onnx').read_bytes(), payload)

  def test_checksum_failure_preserves_existing_asset_and_removes_temporary_file(self):
    with tempfile.TemporaryDirectory() as directory:
      root = Path(directory)
      target = root / 'model.onnx'
      target.write_bytes(b'previous model')
      with patch.object(setup, 'MODEL_PATH', root), \
          patch.object(setup.urllib.request, 'urlopen', return_value=io.BytesIO(b'corrupted')):
        with self.assertRaisesRegex(ValueError, 'checksum'):
          setup.stage_asset('model.onnx', 'https://example.invalid/model', '0' * 64)
      self.assertEqual(target.read_bytes(), b'previous model')
      self.assertEqual(list(root.iterdir()), [target])

  def test_failed_download_does_not_install_partial_model(self):
    with tempfile.TemporaryDirectory() as directory:
      root = Path(directory)
      with patch.object(setup, 'MODEL_PATH', root), \
          patch.object(setup.urllib.request, 'urlopen', side_effect=OSError('interrupted')):
        with self.assertRaises(OSError):
          setup.stage_asset('model.onnx', 'https://example.invalid/model', '0' * 64)
      self.assertEqual(list(root.iterdir()), [])

  def test_model_assets_have_fixed_digests_and_vocabulary_revision(self):
    self.assertEqual(len(setup.MODEL_REVISION), 40)
    self.assertEqual({asset[0] for asset in setup.ASSETS}, {'kokoro-v1.0.onnx', 'voices-v1.0.bin', 'config.json'})
    for name, url, digest in setup.ASSETS:
      self.assertEqual(len(digest), 64)
      self.assertTrue(url.startswith('https://'))
      self.assertIn(setup.MODEL_REVISION if name == 'config.json' else 'model-files-v1.0', url)

  def test_existing_whisper_is_not_redownloaded(self):
    with tempfile.TemporaryDirectory() as directory:
      root = Path(directory)
      (root / 'model.bin').write_bytes(b'existing recognition')
      with patch.object(setup, 'WHISPER_PATH', root), patch.object(setup, 'stage_asset') as stage, \
          patch('huggingface_hub.snapshot_download') as download:
        setup.stage_models()
      self.assertEqual(stage.call_count, 3)
      download.assert_not_called()

  def test_missing_whisper_uses_the_same_pinned_revision_as_speech_setup(self):
    with tempfile.TemporaryDirectory() as directory:
      with patch.object(setup, 'WHISPER_PATH', Path(directory)), patch.object(setup, 'stage_asset'), \
          patch('huggingface_hub.snapshot_download') as download:
        setup.stage_models()
      self.assertEqual(download.call_args.kwargs['revision'], '3d3d5dee26484f91867d81cb899cfcf72b96be6c')
      self.assertEqual(download.call_args.kwargs['repo_id'], 'Systran/faster-whisper-base.en')


if __name__ == '__main__':
  unittest.main()
