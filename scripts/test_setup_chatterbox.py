"""Pinned setup assets and non-destructive reference voice preparation."""

import importlib.util
import hashlib
import io
import os
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch


script_path = Path(__file__).resolve().parents[1] / 'scripts' / 'setup-chatterbox.py'
spec = importlib.util.spec_from_file_location('mentor_chatterbox_setup', script_path)
setup = importlib.util.module_from_spec(spec)
with patch.dict(os.environ, {
  'MENTOR_CHATTERBOX_MODEL': '/tmp/mentor-test-model',
  'MENTOR_WHISPER_MODEL': '/tmp/mentor-test-whisper',
}):
  spec.loader.exec_module(setup)


class ChatterboxSetupTests(unittest.TestCase):
  def test_segmenter_cache_is_checksum_verified_and_reused_without_network(self):
    archive = io.BytesIO()
    with zipfile.ZipFile(archive, 'w') as output:
      output.writestr('features.msgpack', b'fixed-test-segmenter')
    payload = archive.getvalue()
    with tempfile.TemporaryDirectory() as temporary:
      model = Path(temporary)
      with patch.object(setup, 'MODEL_PATH', model), \
          patch.object(setup, 'PKUSEG_SHA256', hashlib.sha256(payload).hexdigest()), \
          patch.object(setup.urllib.request, 'urlopen', return_value=io.BytesIO(payload)) as network:
        setup.stage_pkuseg()
        setup.stage_pkuseg()
      network.assert_called_once()
      self.assertEqual(
        (model / 'pkuseg' / 'spacy_ontonotes' / 'features.msgpack').read_bytes(),
        b'fixed-test-segmenter',
      )

  def test_segmenter_checksum_failure_does_not_install_an_unverified_archive(self):
    with tempfile.TemporaryDirectory() as temporary:
      model = Path(temporary)
      with patch.object(setup, 'MODEL_PATH', model), \
          patch.object(setup.urllib.request, 'urlopen', return_value=io.BytesIO(b'bad-archive')):
        with self.assertRaisesRegex(ValueError, 'checksum'):
          setup.stage_pkuseg()
      self.assertFalse((model / 'pkuseg' / 'spacy_ontonotes.zip').exists())

  def test_resolves_installed_short_or_locale_voice_names_and_rejects_ambiguity(self):
    self.assertEqual(setup.resolve_reference_voice('Samantha', {'Samantha'}), 'Samantha')
    self.assertEqual(
      setup.resolve_reference_voice('Samantha', {'Samantha (English (US))'}),
      'Samantha (English (US))',
    )
    with self.assertRaises(ValueError):
      setup.resolve_reference_voice('Missing', {'Samantha'})
    with self.assertRaises(ValueError):
      setup.resolve_reference_voice('Daniel', {'Daniel (English (US))', 'Daniel (English (UK))'})

  def test_stages_pinned_v3_files_and_offline_chinese_cache_without_redownloading_whisper(self):
    with tempfile.TemporaryDirectory() as temporary:
      root = Path(temporary)
      model = root / 'model'
      whisper = root / 'whisper'
      whisper.mkdir()
      (whisper / 'model.bin').write_bytes(b'existing-recognition-model')
      with patch.object(setup, 'MODEL_PATH', model), patch.object(setup, 'WHISPER_PATH', whisper), \
          patch.object(setup, 'snapshot_download') as snapshot, patch.object(setup, 'hf_hub_download') as file:
        setup.stage_models()
      snapshot.assert_called_once_with(
        repo_id='ResembleAI/chatterbox',
        revision=setup.MODEL_REVISION,
        local_dir=str(model),
        allow_patterns=setup.MODEL_FILES,
      )
      self.assertEqual(len(setup.MODEL_REVISION), 40)
      self.assertIn('t3_mtl23ls_v3.safetensors', setup.MODEL_FILES)
      self.assertNotIn('t3_mtl23ls_v2.safetensors', setup.MODEL_FILES)
      file.assert_called_once_with(
        repo_id='ResembleAI/chatterbox', filename='Cangjie5_TC.json',
        revision=setup.MODEL_REVISION, cache_dir=str(model),
      )
      self.assertEqual(
        (model / 'models--ResembleAI--chatterbox' / 'refs' / 'main').read_text(),
        setup.MODEL_REVISION,
      )
      self.assertEqual((whisper / 'model.bin').read_bytes(), b'existing-recognition-model')

  def test_standalone_setup_stages_missing_whisper_with_fixed_revision(self):
    with tempfile.TemporaryDirectory() as temporary:
      root = Path(temporary)
      with patch.object(setup, 'MODEL_PATH', root / 'model'), \
          patch.object(setup, 'WHISPER_PATH', root / 'missing-whisper'), \
          patch.object(setup, 'snapshot_download') as snapshot, patch.object(setup, 'hf_hub_download'):
        setup.stage_models()
      self.assertEqual(snapshot.call_count, 2)
      self.assertEqual(snapshot.call_args.kwargs['repo_id'], 'Systran/faster-whisper-base.en')
      self.assertEqual(len(snapshot.call_args.kwargs['revision']), 40)

  def test_never_replaces_an_existing_reference_or_runs_synthesis_for_it(self):
    with tempfile.TemporaryDirectory() as temporary:
      reference = Path(temporary) / 'reference.wav'
      reference.write_bytes(b'custom-local-reference')
      with patch.object(setup.subprocess, 'run') as run:
        setup.stage_reference_voice('Samantha (English (US))', reference)
      run.assert_not_called()
      self.assertEqual(reference.read_bytes(), b'custom-local-reference')

  def test_failed_conversion_leaves_no_partial_reference(self):
    with tempfile.TemporaryDirectory() as temporary:
      reference = Path(temporary) / 'voices' / 'coach.wav'
      with patch.object(setup.subprocess, 'run', side_effect=RuntimeError('Conversion failed')):
        with self.assertRaises(RuntimeError):
          setup.stage_reference_voice('Samantha (English (US))', reference)
      self.assertFalse(reference.exists())


if __name__ == '__main__':
  unittest.main()
