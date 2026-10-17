# Learning storage

Mentor automatically records ongoing sessions in IndexedDB (`mentor-learning`, `sessions`) and the configured local Supabase database. A localStorage recovery copy is updated with each snapshot. Remote hosted Supabase remains opt-in.

## Local Docker database

With Docker and the Supabase CLI installed:

```bash
npm run db:start
```

This starts the isolated `mentor` project defined in `config.toml`, applies pending migrations without resetting existing records, enables anonymous authentication, and writes the local public URL/key into the ignored `.env.local`. Scenario seeds are loaded when the local database is first created. It does not modify other Supabase projects. `npm run dev:local` performs this setup before launching the app and audio services. Existing hosted Supabase environment settings are preserved.

- API: http://127.0.0.1:54321
- PostgreSQL: port 54322
- Studio: http://127.0.0.1:54323

Use `npm run db:stop` to stop Mentor’s database and retain its Docker volume. Do not use reset or no-backup options to stop a normal session. Restart Next.js if you configured the database after starting the app.

## Automatic records

`learning_sessions.session` is validated JSONB containing:

- Original `messages` with stable turn IDs and timestamps.
- `pendingTranscript` for the currently recognized but unfinished learner turn.
- `improvements` paired by `messageId`, with exact `original`, `improved`, `updatedAt`, and `isFinal` fields.
- Session `status` (`in-progress` or `completed`), elapsed duration, role, scenario, proficiency, and eventual feedback.

The existing JSONB schema supports these fields without a destructive migration. Autosave coalesces updates approximately every 750 ms and serializes writes. Stale draft writes cannot replace completed sessions or final corrections. Network failures retain on-device records, retry with backoff, and display an explicit retry control. Closing a session flushes its final recognition and improvements; a failed final save leaves the studio open. Closing a browser tab cannot guarantee an outstanding network request completes, so the recovery cache is merged on the next visit.

Interrupted sessions are reviewable in history. Their duration is not counted as completed practice. Corrections may lag speech; unfinished or unavailable improvements are not represented as completed model output. No raw audio is stored.

## Backup and reset

The Backup and reset menu exports the learner's profile, session history, original and improved transcripts, feedback, custom conversation plans, bookmarked scenarios, and scenario configuration as JSON. Database exports read every owned session using cursor pagination, including histories beyond the normal 1,000-record refresh window. Invalid database records or failed reads stop the export instead of silently producing a partial backup. Export only reads an existing authentication session and never creates an identity.

The `reset_learning_data()` RPC deletes the authenticated learner's `learning_sessions`, `learning_profiles`, `scenario_bookmarks`, and `explore_sessions` (including cascading messages, artifacts, and revisions) together in one transaction. It has no user-ID argument, uses `auth.uid()` and existing RLS with security-invoker permissions, and is executable only by authenticated callers. A failed delete rolls back all affected tables. Shared `scenario_configs` and the authentication identity remain intact; other learners' rows are unaffected. Device records are only cleared after the database confirms a successful reset when database records are included.

Apply pending migrations to an already-running local database with `supabase migration up --local`; `npm run db:start` also does this automatically. This operation never runs a database reset. Hosted projects must also receive `202610150002_reset_learning.sql` before the reset feature can clear their learning records.

## Hosted Supabase

1. Create a project and enable **Authentication → Providers → Anonymous Sign-Ins**.
2. Apply all files in `migrations/` in filename order, then `seed.sql`.
3. Set `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` in `.env.local` using public project credentials, then restart Next.js. Never expose a service-role key to the browser.
4. Uncheck **Keep my learning data on this device** in Learning profile.

This preference only governs hosted uploads. A configured loopback Supabase instance is on the same device and saves automatically. Returning to on-device mode stops future hosted uploads; it does not delete earlier remote records.

All profile/session rows are protected by RLS checking `auth.uid()`. Another anonymous learner cannot read or overwrite them. Scenario configuration is curated and read-only to browser clients. Anonymous identities belong to the browser that created them; cross-device login and account recovery are not implemented. Clearing authentication storage loses access to the corresponding identity. Administrators can delete an auth user to cascade-delete its learning records.

## Saved scenarios

`scenario_bookmarks` stores each learner’s complete scenario snapshot, original English level, save/update timestamps, and saved status. Row-level security restricts rows to their owner. Removed bookmarks retain a tombstone so delayed sync or an older backup cannot restore them accidentally. The app reads database records in bounded pages and displays nine saved scenarios per page. A local recovery copy keeps bookmarks available when Supabase disconnects; retry sync from the Saved panel. Hosted synchronization respects the learner’s privacy preference.

## Explore learning studio

Migration `202610150004_explore.sql` adds authenticated `explore_sessions`, `explore_messages`, `explore_artifacts`, and `explore_artifact_revisions`. Composite foreign keys include the owner and session, so a reference cannot cross learner or exploration boundaries. Artifact snapshots reference immutable current revisions; revisions retain their source prompt and restoration ancestry. Declarative rendering content and learning state are validated with Zod before writes and on reads.

API routes verify bearer tokens with Supabase `getUser` using the public key. RLS restricts all reads to the authenticated owner. Browsers can create, rename, and delete their own sessions; only ownership-checked transactional RPCs can write prompts, artifacts, and revisions. Those RPCs use `SECURITY DEFINER`, an empty search path, an explicit `auth.uid()` check, and owner-qualified queries throughout. They accept no caller-supplied owner. Direct edits to prompts, revision contents, current revision pointers, or session turn counters are denied.

Turn RPCs claim a session with its expected version and idempotent request ID and save the prompt before inference. Migration `202610160006_explore_discussion_only.sql` permits creation of the first artifact only. Following chat turns atomically save an explanation and a trace to the selected artifact’s existing revision; they cannot create another artifact, revise content, or reset saved interaction state. A missing selection uses the final artifact in the canonical creation-time/identifier ordering, matching the reopened workspace. Existing multi-artifact sessions and historical revisions remain readable, and explicit restoration of an earlier revision remains available. Failed generation leaves a retryable message. An abandoned pending turn can be recovered after three minutes. Concurrent or stale mutations return HTTP 409. Restoring an earlier artifact creates a new revision with a traced restoration prompt; unrelated artifacts remain unchanged.

The exploration library uses database pagination (12 per page), literal title search, artifact-kind filtering, and stable `updated_at DESC, id DESC` ordering. Conversation history loads 20 messages at a time using sequence cursors; revision history uses revision-number cursors. Export reads a consistent complete Explore snapshot in one database statement, including histories beyond the display limits. Existing version 1 backups remain compatible; new backups contain optional Explore data. Imports validate every relationship and merge transactionally without overwriting newer artifact revisions or conflicting immutable history.

Migration `202610160007_explore_practice_state.sql` supports 120 bounded learning-state fields, including original drafts and improved versions for all 40 practice examples. The state API accepts bodies up to 1 MiB, counting actual UTF-8 bytes. Database validation matches the Zod field, string, and array limits; saves preserve artifact contents, revision history, and the session turn version. The read-only artifact RPC returns only the authenticated owner’s artifact for local correction generation. Originals and corrections remain in saved state when reopening or exporting/restoring a backup.

Run the opt-in isolated database verification against the running local stack:

```sh
MENTOR_EXPLORE_DB_TEST=1 npx vitest run tests/explore-database.test.ts
```

It requires local Supabase and the app on `http://127.0.0.1:3000` (`MENTOR_TEST_URL` can select another loopback URL). It creates temporary anonymous identities and removes only those identities afterward. It covers ownership, concurrent turns, failure recovery, idempotency, direct-write denial, immutable revisions, state persistence, restoration, pagination, literal search, backups, and cascading reset/deletion. It also saves all 40 example originals and corrections over HTTP with maximum-length multibyte strings and checks reopening and backup restoration. Ordinary `npm test` skips this service-dependent check.
