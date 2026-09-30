# fast-jev-compaction-opencode

Verbatim session compaction for [opencode](https://opencode.ai), using a local model, built on top of
[`tamaratran/fast-jev-compaction`](https://github.com/tamaratran/fast-jev-compaction).

The upstream project is a Claude Code plugin plus an npm library. Instead of asking an LLM to
summarize the old turns, it sends the whole history to a probabilistic judge and lets that judge
delete the tool calls and tool results that are no longer needed. Text messages are never
rewritten, so a file path, an exact error message, or a constraint survives compaction.

This repo wires the same engine into opencode, with three differences:

| | upstream (Claude Code) | here (opencode) |
|---|---|---|
| trigger | `session.compact` hook, also automatic at a context threshold | on demand: `/jev-compact` or the `jev_compact` tool |
| judge | Jev over the network (TypeSafe, needs `TYPESAFE_API_KEY`) | any OpenAI-compatible endpoint, LM Studio by default |
| write-back | Claude Code replaces the history | opencode: `session.revert` plus re-injection of the tail |

The library is used as published. No fork, no patch. All the adaptation lives in one file,
`plugin/jev-compact.ts`.

## How it works

### The judge pass

`fast-jev-compaction` builds a state from the conversation and asks questions about it:

1. Every `tool_use` is paired with its `tool_result` via `tool_use_id`. Calls in the first message
   and in the newest `preserveRecentMessages` messages are pinned and never touched.
2. The state is the full conversation, oldest first, with each tool result replaced by a short note
   (`ok, 4213 chars (omitted)`). Tool inputs and texts are included in full.
3. If the state exceeds `maxStateTokens` (25k by default) it is shrunk in stages, each one applied
   only if the previous was not enough: tool inputs truncated to 1000, then 200, then 60 characters;
   long texts abridged head+tail; old non-pinned messages collapsed to `[… N chars omitted …]`; old
   calls reduced to one line each (`t12 Read file_path=src/a.ts → ok 480ch`). If it still does not
   fit, compaction throws. Token counts are estimated from characters, there is no tokenizer.
4. Every non-pinned call gets two probability questions: `call_tN` (does knowing this call was made,
   with its input, still matter) and `result_tN` (are the result contents still needed, given that
   re-running the tool would not produce them again).
5. Questions are split across as many requests as needed so state plus questions stay under
   `maxRequestTokens` (30k, just under the 32k context of the judge). The full state is resent with
   every request, requests run concurrently, answers are merged.
6. Each answer is compared to `keepThreshold` (0.5): result above the threshold keeps call and
   result; otherwise call above the threshold keeps the call and truncates the result to its first
   `truncateHeadChars` (300) characters plus a note; otherwise both are removed.
7. The message list is rebuilt. Messages that lose all their content are dropped, and untouched
   messages come back as the same objects, which is what lets the caller work out what changed.

Judge errors, malformed answers, a missing key, or a history that will not fit all throw. The caller
decides the fallback: upstream falls back to Claude Code's built-in summary, here nothing is changed.

### Getting the result back into an opencode session

opencode has no endpoint for replacing stored messages. The session API gives you read
(`session.messages`), prompt (`session.prompt`, with `noReply: true` to inject context without
triggering a response), and `session.revert`, which rolls the session back to a given message and
discards everything after it. There is no message delete or upsert, in 1.18.30 or in the public SDK.

So the compacted list cannot simply replace the history. The only thing available is to truncate at
one point and rewrite what comes after. The plugin does that as follows:

* untouched messages come back from the library as the same objects, so `indexOf` against the
  original array gives the set of surviving indices for free;
* `dropped` is the complement. If it is empty there is nothing to do;
* `cut = max(dropped) + 1`, the last message that changed;
* `session.revert(all[cut].info.id)` discards that message and everything after it. Everything before
  it stays in the database with its role, tool parts and timestamps intact;
* the tail (surviving messages whose original index is `>= cut`) is re-injected with
  `session.prompt({ noReply: true })`, one message per run of consecutive same-role messages, each
  marked `<!-- jev-compact:user -->` or `<!-- jev-compact:assistant -->`.

Cutting at the last modified message rather than the first is what keeps the damage small. A first
version cut at the first non-pinned message and re-injected everything after it, which flattened the
structure of every later message including the ones the judge never touched. With the current cut,
the untouched prefix survives as real messages, and the tool calls that were removed are almost
always in the older part of the history anyway.

What you lose: the re-injected tail is plain text. Tool parts come back as
`[tool X] {"input"}` plus their output. The content is intact, the structure is not. Fixing that
needs a message upsert in the opencode SDK, which does not exist yet.

### The local judge

The library knows nothing about opencode or LM Studio. It talks the Jev protocol through a single
interface:

```ts
interface JevAsker {
  ask(state: JevState, questions: JevQuestions): Promise<JevResponse>
}
```

The state is the fitted conversation, the questions are the `noul` questions to answer, and the
response is `{ answers: { call_t1: { noul: 0.93 }, result_t1: { noul: 0.10 } } }`, one probability
between 0 and 1 per question. The official `JevClient` is one implementation of that interface and
talks to TypeSafe. The one in this repo is another implementation that talks OpenAI-compatible:

* `POST http://127.0.0.1:1234/v1/chat/completions` (LM Studio, load the `LM Studio API` from
  Developer → API Usage), model `rizzo-flow` by default;
* system prompt asks for a JSON object mapping each question name to the probability that the
  statement is true, `temperature: 0`;
* the raw JSON is pulled out with a `\{[\s\S]*\}` regex and mapped to `{ noul: Number(p) }`.

Because the contract is just "one number per question", the `compact()` algorithm and its threshold
logic are the upstream ones, unchanged. That is why the whole adapter is about 140 lines instead of
a fork.

No API key, no network calls. Endpoint and model are overridable through `JEV_LMSTUDIO_URL` and
`JEV_LMSTUDIO_MODEL`.

### Why it is on demand

opencode already compacts automatically (`compaction.auto`, `compaction.tail_turns`). The point
here is to pick per session: run the built-in `/compact` when a summary is fine, run `/jev-compact`
when literal fidelity matters. So the plugin does not touch `compaction` and does not hook
`experimental.session.compacting`. It registers a tool and a command and does nothing until called.
It also rewrites history, which is not something to run unattended.

## Install

Requirements: opencode 1.18 or newer, Node 18+, and an OpenAI-compatible endpoint (LM Studio,
Ollama, vLLM, llama.cpp, …).

### Copy the files

```sh
# global, recommended
mkdir -p ~/.config/opencode/plugin ~/.config/opencode/command
cp plugin/jev-compact.ts   ~/.config/opencode/plugin/
cp command/jev-compact.md  ~/.config/opencode/command/

# or per project
mkdir -p .opencode/plugin .opencode/command
cp plugin/jev-compact.ts   .opencode/plugin/
cp command/jev-compact.md  .opencode/command/
```

opencode auto-loads every `*.ts` in `plugin/` or `plugins/`, no `opencode.json` entry needed.

### Install the dependency

opencode runs `bun install` at startup against the `package.json` in the config directory. Without
that file the import does not resolve.

```sh
cd ~/.config/opencode                # or the project root
npm pkg set dependencies.fast-jev-compaction="^0.4.1"
npm pkg set dependencies.@opencode-ai/plugin="^1.14.38"
npm install
```

### Point it at your model

The defaults already work with LM Studio. For anything else:

```sh
export JEV_LMSTUDIO_URL="http://127.0.0.1:1234/v1/chat/completions"
export JEV_LMSTUDIO_MODEL="qwen2.5-14b-instruct"
```

Or edit the two constants at the top of `plugin/jev-compact.ts`.

### Restart and run

opencode does not reload plugins, so quit and reopen it.

```
/jev-compact                    # preserveRecentMessages 0, minReduction 0.25
/jev-compact 4                  # pin the last 4 messages
```

Or just ask the agent to use the `jev_compact` tool. The tool prints messages and characters
before/after, reduction percentage, calls kept/truncated/removed, request count, elapsed ms, and how
many messages were re-injected as text.

If something goes wrong after the revert: `client.session.unrevert({ path: { id: sessionID } })`.

## Options

| Tool arg | default | meaning |
|---|---|---|
| `preserveRecentMessages` | `0` | newest N messages are pinned and never touched |
| `minReduction` | `0.25` | below this reduction, nothing is changed |

Inherited from the library (`CompactOptions`), editable in the `compact()` call: `goal` (defaults to
the last 3 user prompts), `keepThreshold` (0.5), `maxStateTokens` (25k), `maxRequestTokens` (30k),
`truncateHeadChars` (300).

## What differs from upstream

`src/` of `fast-jev-compaction` is untouched. The adapter only uses public exports: `compact`,
`reductionRatio`, and the types `JevAsker`, `JevState`, `JevQuestions`, `Message`.

Compared to `hooks/fast-jev.ts`, the Claude Code adapter:

1. no `session.compact` hook, just a tool and a command;
2. `JevClient` swapped for the local OpenAI-compatible `JevAsker`, so `compactMessages` and
   `TYPESAFE_API_KEY` are not used;
3. transcript conversion from `client.session.messages()`: each opencode `ToolPart` already holds
   both the call (`state.input`) and the result (`state.output` or `state.error.output`), so it
   becomes one `ToolUse` with `tool_use_id = part.callID` and no separate `toolResult`;
4. write-back through `session.revert` plus `session.prompt({ noReply: true })` on the tail;
5. message identity from step 7 of the judge pass is used to compute `dropped` and `cut`;
6. the fallbacks are the "change nothing" cases instead of the built-in summary: history shorter than
   4 messages, judge failure, reduction below the threshold, no call removed, or savings limited to
   the tail.

## Known limits

* The re-injected tail is text, tool parts do not survive the rewrite.
* No JSON schema is sent to the model, so a non-JSON reply fails the compaction (and changes
  nothing). `response_format: { type: "json_schema" }` would remove this.
* A local model is weaker than Jev at probabilistic judgement. Raise `keepThreshold` if it is too
  permissive, lower it if it is too cautious.
* Token sizes are character estimates inherited from upstream, `maxStateTokens` is not exact.
* The revert discards messages, and with them anything that referenced them by id.

## License

Adapter code: MIT, like the original project ([`LICENSE`](./LICENSE), © tamaratran).
`fast-jev-compaction` itself is installed as an npm dependency under its own license.
