"""Fixed display identities; model and file selection stays server-controlled."""

PERSONA_NAMES = {'alex': 'Alex', 'sam': 'Sam', 'jordan': 'Jordan', 'riley': 'Riley'}
LEGACY_PERSONAS = {'coach': 'alex', 'partner': 'sam'}


def persona_metadata(persona: str, languages: list[str]) -> dict:
  return {'id': persona, 'name': PERSONA_NAMES[persona], 'languages': list(languages)}
