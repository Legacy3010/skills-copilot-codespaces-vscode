# ForgeCode Architecture

## Overview

ForgeCode is a VS Code extension that replaces the repository’s original Roo runtime as the primary execution path. The design goal is local-first coding assistance that feels closer to modern VS Code agents while avoiding Roo’s main failure mode: unbounded, append-only context growth.

The extension centers on five runtime surfaces:

1. A custom language model provider that exposes LM Studio models to the VS Code model picker.
1. A sticky chat participant named `@local` that can plan, implement, review, and explain.
1. A bounded workspace context service that summarizes the active editor and representative files instead of replaying historical logs.
1. A set of language model tools for read, write, search, and optional shell execution.
1. An inline completion provider that reuses the same endpoint.

## Runtime modules

### Provider layer

`src/provider/localAiModelProvider.ts` registers the `forgecode-agent` vendor with VS Code.

- Discovers models from `/v1/models`.
- Falls back to configured model IDs if discovery fails.
- Streams text and tool calls from `/v1/chat/completions`.
- Enforces localhost-only endpoints by default and requires `https` for remote endpoints.
- Declares tool-calling capability so ForgeCode models can participate in agent-style workflows.

`src/provider/openAiCompatibleClient.ts` contains the transport logic.

- Converts VS Code chat messages into OpenAI-compatible request payloads.
- Reconstructs streamed tool calls from SSE deltas.
- Handles inline completion requests against the same endpoint.
- Applies the same endpoint validation rules for discovery, chat, and completions.

### Agent layer

`src/chat/localAgentParticipant.ts` creates the `@local` participant.

- `plan`, `review`, and `explain` use read-only tools.
- `implement` enables file mutation tools, and shell execution only works when the user has explicitly enabled it in settings.
- The participant loops over tool calls until the model returns a final answer or the configured tool-round cap is reached.

This agent loop is explicit and bounded. It does not rehydrate append-only logs or checkpoint files into every prompt.

### Context layer

`src/context/workspaceContext.ts` builds a bounded workspace snapshot.

- Includes workspace folder names instead of absolute paths.
- Includes the active editor excerpt with line numbers.
- Includes a sample of open text documents.
- Includes a capped file inventory from the workspace.

The snapshot is trimmed to `forgeCode.maxContextCharacters`, which is the main guardrail missing from Roo.

### Tool layer

`src/tools/workspaceTools.ts` registers the tools made available to the chat model.

- `listWorkspaceFiles`
- `searchWorkspace`
- `readFile`
- `writeFile`
- `replaceInFile`
- `runTerminalCommand`

Mutation and command tools require confirmation before they run. Additional hardening now includes:

- workspace trust enforcement for writes and command execution
- symlink and junction escape checks before file access
- binary and oversized-file rejection for reads and searches
- secret-reduced terminal environments
- command execution disabled by default through `forgeCode.allowCommandExecution`

### Completion layer

`src/completion/inlineCompletionProvider.ts` provides inline completions from the same endpoint.

- Uses bounded prefix and suffix windows.
- Avoids Markdown and prose in the completion response.
- Skips low-signal languages such as plain text and markdown by default.

## Request flow

1. VS Code activates the extension and registers the provider, participant, tools, and completions.
1. The user selects a ForgeCode model or invokes `@local`.
1. The participant builds a fresh workspace snapshot for the current task.
1. The model responds with text and optional tool calls.
1. Tool calls are executed through VS Code’s language model tool API, and results are fed back into the same request loop.
1. The interaction ends when the model stops requesting tools or the tool-round limit is reached.

## Security posture

ForgeCode is hardened by default, but it is not absolutely secure in the literal sense. The extension reduces risk by constraining endpoint trust, keeping secrets out of plain settings, trimming context, enforcing workspace boundaries, and disabling shell execution until the user opts in. It still operates as a tool-capable coding agent, so user review and workspace trust remain part of the security model.

## Why this supersedes Roo

Roo’s prototype architecture stored mission, plans, context logs, checkpoints, and task history in append-only files and then encouraged those files to become prompt context. That design is easy to audit but degrades rapidly for coding tasks because prompt cost and irrelevance rise together.

ForgeCode changes the control model in three ways:

1. Context is assembled on demand from the active workspace state, not from historic logs.
1. Tool use is first-class, so the model can fetch only the files it needs.
1. Prompt size is bounded through explicit file, excerpt, and character limits.

## Development and validation

- Build: `corepack pnpm compile`
- Watch: `corepack pnpm watch`
- Test: `corepack pnpm test`
- Extension debug host: `F5`

The current unit tests focus on protocol reconstruction and prompt helpers. Additional integration coverage should be added around tool execution and model discovery once the extension host test harness is introduced.

## Legacy components

The `ai_coder/` tree is intentionally retained.

- `ai_coder/roo_task_runner.py` remains the deterministic prototype runner.
- `ai_coder/copilot_skills/gemini_mcp_server.py` remains the legacy Gemini bridge.
- Roo rules and append-only task artifacts remain useful for migration history and architectural comparison.

These files are no longer the production runtime.
