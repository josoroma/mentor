"""Verify speech environment selection without loading models or binding ports."""

import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


SCRIPT = Path(__file__).with_name('start-speech.sh')


class SpeechLauncherTests(unittest.TestCase):
  def setUp(self):
    self.temporary = tempfile.TemporaryDirectory(prefix='mentor launcher ')
    self.root = Path(self.temporary.name)
    self.environment = {
      key: value for key, value in os.environ.items()
      if not key.startswith('MENTOR_')
    }
    self.environment['MENTOR_MODELS_DIR'] = str(self.root)

  def tearDown(self):
    self.temporary.cleanup()

  def install_fake_runtime(self, name):
    directory = self.root / '.venvs' / name
    binary = directory / 'bin' / 'python'
    binary.parent.mkdir(parents=True)
    binary.write_text(
      f'#!{sys.executable}\n'
      'import json, os, sys\n'
      'print(json.dumps({"runtime": sys.argv[0], "args": sys.argv[1:], '
      '"provider": os.getenv("MENTOR_TTS_PROVIDER"), '
      '"offline": os.getenv("HF_HUB_OFFLINE"), '
      '"kokoro": os.getenv("MENTOR_KOKORO_MODEL")}))\n',
    )
    binary.chmod(0o700)
    return directory

  def run_launcher(self, **overrides):
    return subprocess.run(
      ['bash', str(SCRIPT)], env={**self.environment, **overrides},
      capture_output=True, text=True, timeout=5,
    )

  def test_every_default_uses_installed_shared_neural_environment(self):
    self.install_fake_runtime('mentor-speech')
    neural = self.install_fake_runtime('mentor-chatterbox')
    for provider in ('macos', 'kokoro', 'chatterbox'):
      result = self.run_launcher(MENTOR_TTS_PROVIDER=provider)
      self.assertEqual(result.returncode, 0, result.stderr)
      body = json.loads(result.stdout)
      self.assertEqual(body['runtime'], str(neural / 'bin' / 'python'))
      self.assertEqual(body['provider'], provider)
      self.assertEqual(body['offline'], '1')
      self.assertEqual(body['kokoro'], str(self.root / 'kokoro-82m'))
      self.assertEqual(body['args'][-4:], ['--host', '127.0.0.1', '--port', '8765'])

  def test_unconfigured_provider_uses_balanced_kokoro_in_shared_runtime(self):
    self.install_fake_runtime('mentor-speech')
    neural = self.install_fake_runtime('mentor-chatterbox')
    result = self.run_launcher()
    self.assertEqual(result.returncode, 0, result.stderr)
    body = json.loads(result.stdout)
    self.assertEqual(body['provider'], 'kokoro')
    self.assertEqual(body['runtime'], str(neural / 'bin' / 'python'))

  def test_default_setup_installs_kokoro_into_the_runtime_used_at_launch(self):
    template = self.install_fake_runtime('template') / 'bin' / 'python'
    fake_bin = self.root / 'tools'
    fake_bin.mkdir()
    fake_uv = fake_bin / 'uv'
    fake_uv.write_text(
      f'#!{sys.executable}\n'
      'import json, os, pathlib, shutil, sys\n'
      'with open(os.environ["SETUP_LOG"], "a") as log:\n'
      '  log.write(json.dumps(sys.argv[1:]) + "\\n")\n'
      'if sys.argv[1] == "venv":\n'
      '  target = pathlib.Path(sys.argv[-1]) / "bin" / "python"\n'
      '  target.parent.mkdir(parents=True)\n'
      '  shutil.copyfile(os.environ["RUNTIME_TEMPLATE"], target)\n'
      '  target.chmod(0o700)\n',
    )
    fake_uv.chmod(0o700)
    log = self.root / 'setup.jsonl'
    result = subprocess.run(
      ['bash', str(SCRIPT.with_name('setup-speech.sh'))],
      env={
        **self.environment,
        'PATH': f'{fake_bin}{os.pathsep}{self.environment["PATH"]}',
        'RUNTIME_TEMPLATE': str(template),
        'SETUP_LOG': str(log),
      },
      capture_output=True, text=True, timeout=5,
    )
    self.assertEqual(result.returncode, 0, result.stderr)
    installs = [json.loads(line) for line in log.read_text().splitlines()]
    neural = self.root / '.venvs' / 'mentor-chatterbox' / 'bin' / 'python'
    self.assertIn([
      'pip', 'install', '--python', str(neural), '-r',
      str(SCRIPT.with_name('kokoro-requirements.txt')),
    ], installs)
    launched = self.run_launcher()
    self.assertEqual(launched.returncode, 0, launched.stderr)
    body = json.loads(launched.stdout)
    self.assertEqual(body['provider'], 'kokoro')
    self.assertEqual(body['runtime'], str(neural))

  def test_recognition_only_environment_can_launch_system_speech(self):
    original = self.install_fake_runtime('mentor-speech')
    result = self.run_launcher(MENTOR_TTS_PROVIDER='macos')
    self.assertEqual(result.returncode, 0, result.stderr)
    self.assertEqual(json.loads(result.stdout)['runtime'], str(original / 'bin' / 'python'))

  def test_explicit_runtime_and_port_remain_configurable(self):
    self.install_fake_runtime('mentor-chatterbox')
    custom = self.install_fake_runtime('custom')
    result = self.run_launcher(MENTOR_SPEECH_VENV=str(custom), MENTOR_SPEECH_PORT='9876')
    self.assertEqual(result.returncode, 0, result.stderr)
    body = json.loads(result.stdout)
    self.assertEqual(body['runtime'], str(custom / 'bin' / 'python'))
    self.assertEqual(body['args'][-1], '9876')

  def test_invalid_provider_and_missing_runtime_fail_before_launch(self):
    result = self.run_launcher(MENTOR_TTS_PROVIDER='hosted')
    self.assertNotEqual(result.returncode, 0)
    self.assertIn('must be', result.stderr)
    result = self.run_launcher()
    self.assertNotEqual(result.returncode, 0)
    self.assertIn('speech:setup', result.stderr)


if __name__ == '__main__':
  unittest.main(verbosity=2)
