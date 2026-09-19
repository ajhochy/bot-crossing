# Codex session graph investigation

## Safety boundary

The adapter reads Codex data under `CODEX_HOME` and never writes to it. Investigation used table
schemas, aggregate counts, record types and lifecycle markers only. It did not print transcript
messages, titles, prompts or tool output. Tests use temporary synthetic SQLite databases and
rollouts.

## Sources and reconciliation

Codex has two useful local sources:

- `state_<n>.sqlite` provides thread metadata and `thread_spawn_edges(parent_thread_id,
  child_thread_id, status)`.
- `sessions/YYYY/MM/DD/rollout-*.jsonl` provides lifecycle records and covers sessions that SQLite
  has not indexed yet. Its `session_meta` also carries `parent_thread_id` for a worker.

The previous adapter filtered SQLite children before unioning every rollout. On the inspected
installation, all 397 child rows also had rollouts, so all 397 returned as ordinary top-level
conversations. Seven edges were nested below another child, which requires recursive graph handling.

The adapter now returns every real session exactly once as a flat node. `parentId` is a globally
prefixed Codex ID. A missing parent keeps that ID and sets `orphaned: true`. A cycle loses one
deterministically chosen edge and reports `relationshipError: 'cycle'`, so recursive consumers
terminate. An archived parent remains in the graph and its children keep their relationship; view
code can apply one subtree visibility policy without promoting children into duplicate conversations.

Codex also records worker identity as `agent_nickname` and `agent_role` columns in SQLite. The same
fields appear in rollout-only `session_meta`, either directly on the payload or under
`source.subagent.thread_spawn`. The adapter exposes them as `agentNickname` and `agentRole`. An
explicit thread title, indexed thread name, or prompt-derived title keeps priority; only an otherwise
untitled worker falls back to the concise `nickname · role` metadata label. On the inspected data,
all 397 workers had a nickname, 76 had a role, and 97 previously untitled workers gained a metadata
label without reading message bodies.

## Activity evidence

A fixed 64 KiB tail was insufficient. During investigation, the active parent and three active
workers had their newest `task_started` marker near the beginning of 1.2-1.9 MB rollouts, followed by
individual JSONL records larger than the tail. The adapter therefore reported all four as quiet.
The spawn-edge `status` column was not a safe replacement: many old `open` edges had a later
`task_complete` marker.

Lifecycle discovery now scans complete lines backward until it finds the newest marker. A bounded
JSON scanner retains structure and short keys and values while replacing oversized string bodies
with a one-character placeholder. This matters because `task_complete` itself can exceed 64 KiB
when its `last_agent_message` is large. The structurally parsed record must still be an `event_msg` whose
payload has a recognized lifecycle type; lifecycle-looking words inside a message are ignored.

The cache records the start of the trailing partial line. A growing rollout parses only newly
completed records, but retries that partial line from its start on the next poll. A completion split
across two polls becomes authoritative only after its newline arrives. Until then the prior marker
remains authoritative. Parsing memory is bounded by a 64 KiB JSON skeleton and 2 KiB per retained
string, independent of the record's full size.

The public state is explicit:

- `activity: 'running'`, `running: true` for a recent `task_started`.
- `activity: 'quiet'`, `running: false` for `task_complete` or `turn_aborted`.
- `activity: 'unknown'`, `running: null` when evidence is absent or a start is stale.

Codex exposes no focus history here, so `unread` is `null`. Bot Crossing may establish read/unread
relative to its own viewed timestamp, but the adapter does not invent Codex focus evidence.

## Navigation evidence

The installed Codex CLI was found on the user's PATH. Its local help accepts
`codex resume [SESSION_ID]`, and the adapter preserves the exact session UUID and recorded cwd in
`ref` and the terminal command. This verifies the invocation shape; an end-to-end resumed terminal
was not opened during the read-only investigation. `BOT_CROSSING_CODEX_CLI` is an explicit
executable override; an explicit empty value disables fallback discovery so no-CLI tests are
hermetic.

The installed Codex app's task navigation API successfully selected a current worker by UUID and
then restored its parent task. That proves the app can navigate by UUID through its own API, but the
adapter cannot call that API. LaunchServices accepted the existing `codex://threads/<uuid>` URL,
which only proves that the scheme has a handler; it does not prove that the app selected the requested
task. Computer-use inspection of the Codex app was unavailable because that surface is
safety-blocked. Scanned threads therefore mark the desktop capability unavailable and unverified.
The server returns `appUnavailableReason` instead of reporting a successful desktop open. Exact CLI
resume is the available action when the CLI is installed.

## Sanitized live evidence

After the change, a read-only live scan returned 1,283 unique sessions: 886 roots, 397 attached
children, no orphans, 4 running, 1,216 quiet, and 63 unknown. All 1,283 unread values were unknown.
Cold discovery took about 1.34 seconds; the immediately repeated cached scan took about 0.28 seconds.
These are one-machine observations, not performance guarantees.

## Automated coverage

`test/codex-graph.test.mjs` covers nested children, rollout-only orphans, archived parents, cycles,
indexed and rollout-only worker identity, title precedence, oversized records, incremental
completion, incomplete trailing lines, stale and absent evidence, unknown unread state, exact
cwd/session refs, and navigation capability reporting. Existing harness and HTTP opening tests cover
the generated deep link and exact `codex resume <uuid>` argv.
