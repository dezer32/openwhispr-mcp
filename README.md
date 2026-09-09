# openwhispr-mcp

A local [MCP](https://modelcontextprotocol.io) server that exposes the data of the
[OpenWhispr](https://openwhispr.com) desktop app — notes, folders, meeting transcripts, dictation
history and the custom dictionary — to any MCP client, so an agent can read them without hand-rolled
`curl` calls.

It talks to the app's **CLI bridge**: a loopback-only HTTP endpoint the app itself publishes. Nothing
is read straight from the SQLite file, because the app keeps recent writes in the WAL and grows its
schema with unversioned `ALTER TABLE` chains.

## Requirements

- macOS with the OpenWhispr app **running** (the bridge only exists while the app is up).
- Node.js 20.3+ (`AbortSignal.any`, which every bridge call uses, landed in 20.3.0).

## Install

Nothing to clone: `npx` fetches the package and runs it.

```bash
claude mcp add --scope user openwhispr -- npx -y openwhispr-mcp
```

`-y` is not optional — without it npx asks for confirmation the first time, and an MCP client is
not there to answer. Check the install without a client:

```bash
npx -y openwhispr-mcp --version
```

Any other MCP client takes the same command and args:

```json
{
  "mcpServers": {
    "openwhispr": {
      "command": "npx",
      "args": ["-y", "openwhispr-mcp"]
    }
  }
}
```

### Pinning

A bare `npx -y openwhispr-mcp` resolves `latest` through the registry on every launch, so each
client session starts with a network round-trip. Pinning an exact version lets npx reuse what it
already downloaded:

```bash
claude mcp add --scope user openwhispr -- npx -y openwhispr-mcp@0.1.0
```

A global install takes npx out of the launch path altogether:

```bash
npm install -g openwhispr-mcp
claude mcp add --scope user openwhispr -- openwhispr-mcp
```

### From source

```bash
git clone https://github.com/dezer32/openwhispr-mcp.git
cd openwhispr-mcp
npm install   # `prepare` builds dist/ as part of the install
claude mcp add --scope user openwhispr -- node "$PWD/dist/index.js"
```

The repository also ships a `.mcp.json` for debugging inside this checkout.

## How it finds the app

On every tool call the server re-reads `~/.openwhispr/cli-bridge.json`, the handshake file the app
writes (mode 0600) with the bridge's port and bearer token. **Both are regenerated on every app
restart**, so nothing is cached between calls; within a single call the pair is pinned so parallel
reads cannot be stitched together from two different app instances.

If the app is not running, the file is absent and every tool answers with `kind: "bridge_not_running"`.

### Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `OPENWHISPR_BRIDGE_CONFIG` | `~/.openwhispr/cli-bridge.json` | Alternate handshake file |
| `OPENWHISPR_MCP_DEBUG` | off | Echo raw upstream error text back to the agent |
| `OPENWHISPR_MCP_TIMEOUT_MS` | `20000` | Per-request timeout |
| `OPENWHISPR_MCP_MAX_RESPONSE_BYTES` | `67108864` | Response byte cap |
| `OPENWHISPR_MCP_MAX_RESULT_CHARS` | `400000` | Cap on a tool's JSON result |

## Tools

| Tool | Kind | What it does |
|---|---|---|
| `health` | read | Check that the local OpenWhispr app is running and its CLI bridge is reachable. Returns the bridge host and port, the handshake file path and the app version. Call this first when another tool fails with bridge_not_running, bridge_unreachable or unauthorized — the port and token change on every app restart. |
| `list_notes` | read | List notes newest first (by updated_at), filtered by note_type and/or folder_id. Returns summaries only — no note body, no transcript. Pages come from one snapshot: pass next_cursor back verbatim, keeping the same filters. A cursor that outlived its snapshot fails with snapshot_expired; list again without a cursor. |
| `get_note` | read | Read one note by id: title, folder, timestamps and the full content body. The transcript is never included — it reaches 240 KB — so a meeting note reports transcript_segment_count and a hint pointing at get_note_transcript. Set include_enhanced to also receive the AI-cleaned version of the text. |
| `search_notes` | read | Full-text (FTS5 prefix AND) search over note titles, bodies and AI-enhanced text. Every word becomes a required prefix term, so all of them must appear. There is no semantic search and no relevance score. Returns note summaries with matched_in and a snippet; use list_notes to browse and get_note for a full body. |
| `get_note_transcript` | read | Read a note's transcript. format=segments pages diarized segments with times relative to the recording start (offset/limit, speaker/source filters); format=text renders "[mm:ss] speaker: …" lines; format=speakers gives per-speaker totals only — use it first on long recordings. A note with no transcript returns an empty result, not an error. |
| `create_note` | write | Create a note in the local OpenWhispr app. Without folder_id the app files it into its own default folder — see the notice field in the reply. note_type is fixed at creation: update_note cannot change it. Returns the stored note. |
| `update_note` | write | Change a note's title, content or folder in the local OpenWhispr app. note_type, transcript and enhanced_content are deliberately not writable. Rewriting content leaves any existing enhanced_content in place and the app keeps treating it as current; the reply warns when that happens. |
| `delete_note` | **destructive** | Delete a note from the local OpenWhispr app. There is no confirmation step and no undo on this path, so confirm with the user before calling it. The bridge answers 204 without saying whether the id existed. |
| `list_folders` | read | List the note folders of the local OpenWhispr app, with their ids, names and default flags. Use it to find the folder_id that list_notes, create_note and update_note take. The bridge returns every folder at once — there is no limit and no paging here. |
| `create_folder` | write | Create a note folder in the local OpenWhispr app. Names must be unique: a duplicate comes back as folder_name_conflict listing the folders that exist. Creating a folder is the only folder change the bridge allows. |
| `list_transcriptions` | read | List the OpenWhispr dictation history (newest first): text, provider, model, status and audio duration. These rows are NOT note transcripts and cannot be linked to a note — use get_note_transcript for those. Discarded and deleted dictations are invisible here. |
| `get_transcription` | read | Read one dictation from the history by id, with its full text, provider, model, status and any error. Ids come from list_transcriptions. A dictation is not linked to any note — use get_note_transcript for a note transcript. |
| `list_dictionary` | read | List the custom dictionary of the local OpenWhispr app — the words the transcriber is told to spell a particular way (product names, jargon, names of people). Returns the words themselves plus the shape the app stored them in. |
| `update_dictionary` | write | Add or remove words in the custom dictionary of the local OpenWhispr app. Words are trimmed and de-duplicated, and case is significant. Returns what was sent plus the dictionary as it reads back afterwards. |
| `get_usage` | read | Summarise what is stored in the local OpenWhispr app: how many notes, folders, transcriptions and dictionary words there are, split by type, folder and month, with word, character and audio totals. Counts come from a capped read, and the reply lists exactly what it cannot see. |

## Response conventions

Every tool answers with one JSON object in a single text block.

- Data lives under a name for what it is: `note`, `notes`, `folder`, `folders`, `transcription`,
  `transcriptions`, `segments`, `speakers`, `words`.
- `notice` and any `*_note` field are prose for the reader — caveats about what the reply can and
  cannot mean. They are never data.
- `folder_names_unavailable: true` (with a `folder_names_note`) appears on any reply whose folder
  listing failed during the call. Every `folder_name` in that reply is then `null` because the name
  could not be read — not because the note is unfiled. `folder_id` is still trustworthy.
- Failures come back as `isError` with `{"error": {"kind", "message", "hint", "details"}}`, where
  `kind` is a stable machine-readable string (`bridge_not_running`, `not_found`, `folder_not_found`,
  `snapshot_expired`, …). A malformed *argument* is rejected by the MCP SDK before the server sees
  it, and arrives as a plain `MCP error -32602: Input validation error: …` message instead.

## What this server deliberately does not do

- **No transcription or audio deletion.** The bridge exposes `DELETE /v1/transcriptions/:id` and
  `DELETE /v1/transcriptions/:id/audio`; both are intentionally left unexposed — an agent should not
  be able to destroy dictation audio.
- **No writes to `transcript`, `enhanced_content`, `participants`, `diarization_enabled` or
  `expected_speaker_count`.** `notes.transcript` is a TEXT column: writing a plain string to it
  silently degrades a JSON transcript of hundreds of diarized segments into flat text, irreversibly.
- **No `note_type` changes.** The app's update whitelist does not accept the column.
- **No semantic search.** The app has one (Qdrant sidecar + local ONNX embeddings, hybrid FTS5 +
  vector via RRF), but only over internal IPC. `search_notes` is FTS5 only.
- **No subscription/plan data.** Usage and plan live in the cloud API; the app computes no local
  statistics, so `get_usage` aggregates on this side and reports `plan.available: false`.

## Known limits you should read before trusting output

- **Lists are capped, not paginated, upstream.** The bridge's `has_more`/`next_cursor` are hardcoded
  to `false`/`null`. `list_notes` therefore pages out of a **snapshot** taken by one read; within the
  snapshot paging is exact, and a saturated read is reported as `complete: false`.
- **Soft-deleted and `discarded` dictations are invisible** to the bridge, so "0 transcriptions" does
  not mean "no dictations happened".
- **`notes` and `transcriptions` are unrelated streams** — no foreign key, no `note_id`. A meeting's
  transcript lives in `notes.transcript`; `transcriptions` is dictation history.
- **All timestamps are UTC** without a zone suffix in the source; this server normalises them to
  `...Z` ISO strings.
- **`get_usage` is not a consistent snapshot**: its four reads see four different moments.
- **`list_notes` paging is snapshot paging.** `has_more` describes pages of the snapshot, not notes
  in the app. Pages 2..N are served from memory and never touch the bridge, so a cursor call is not
  a liveness check. If the first read saturated the 500-row upstream cap, every page of that
  snapshot says `complete: false` — a cursor is still issued, because paging *inside* the snapshot
  is exact; what it never does is point past the last row it actually read, so `next_cursor` turns
  `null` at the end of the snapshot instead of handing you an empty page.
- **`format: "text"` merges consecutive segments into one line** while the speaker is the same, the
  `source` (mic/system) is the same, the start-to-start gap is under 30 seconds and the line stays
  under 2000 characters. All three thresholds are guesses — the app exposes no diarization gap data
  — so the reply carries them as `merge_gap_seconds`, `merge_max_chars` and `merge_note`, and the
  number of rendered lines is not the number of turns.
- **Editing `content` leaves any `enhanced_content` stale.** The app tracks freshness with a content
  hash this server cannot compute, so `update_note` returns a warning instead.

## Development

```bash
npm test          # builds first (pretest), then unit + tool tests against an in-process fake bridge
npm run typecheck
npm run build
```

`npm test` runs `npm run build` first: the stdout-hygiene test drives the real `dist/index.js` in a
child process, so on a fresh clone the tests would otherwise fail on a missing build.

## Release

`dist/` is not in git, so the tarball is built by `prepare`, and `prepublishOnly` refuses to
publish a tree that does not typecheck or whose tests fail.

```bash
npm version patch          # bump package.json
# then bump SERVER_VERSION in src/server.ts to match — clients read that one,
# and tests/contract/packaging.test.ts fails until the two agree
npm publish --dry-run      # inspect the file list
npm publish
```

The smoke test runs against the **real** app and is opt-in and read-only:

```bash
OPENWHISPR_LIVE=1 npm test -- smoke
```

## License

MIT
