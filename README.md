# ForgeCode

This repository now targets a production-oriented VS Code extension named ForgeCode. The new runtime is local-first: it exposes LM Studio models through the VS Code model picker, provides a chat participant with tool calling, and adds inline code completions without depending on Roo’s append-only memory flow.

The old Roo prototype remains in `ai_coder/` as legacy reference material. It is no longer the primary architecture.

## What the extension does

- Registers a custom language model provider for LM Studio or any OpenAI-compatible endpoint.
- Exposes those models in the VS Code chat model picker under the `ForgeCode` vendor.
- Adds a sticky `@local` chat participant with `plan`, `implement`, `review`, and `explain` commands.
- Registers workspace tools for file listing, search, file reads, controlled file writes, string replacement, and optional shell execution.
- Provides inline code completions backed by the same endpoint.
- Replaces Roo’s unbounded memory accumulation with explicit workspace snapshots and bounded prompt budgets.

## Quick start

1. Start LM Studio and enable its local server.
1. From the repository root, run `corepack pnpm install`.
1. Build the extension with `corepack pnpm compile`.
1. Press `F5` in VS Code to launch an Extension Development Host.
1. Open the chat model picker, manage models, and enable the `ForgeCode` provider.
1. Use `@local` in chat or select a ForgeCode model directly.

The default endpoint is `http://127.0.0.1:1234/v1`, which matches LM Studio’s OpenAI-compatible server.

## Security defaults

- ForgeCode accepts only localhost endpoints unless `forgeCode.allowRemoteEndpoints` is enabled.
- Remote endpoints must use `https`.
- API keys are stored in VS Code secret storage through `ForgeCode: Configure API Key` instead of plain settings.
- Shell execution is disabled by default and requires both workspace trust and `forgeCode.allowCommandExecution = true`.
- Read and search tools skip oversized or binary files.
- Write and replace tools refuse paths that escape the workspace through symlinks or junctions.

These controls harden the extension, but they do not create an absolute security guarantee. Any tool-capable coding agent still needs user review and sensible trust boundaries.

## Key settings

- `forgeCode.baseUrl`: endpoint URL.
- `forgeCode.allowRemoteEndpoints`: permit non-localhost endpoints.
- `forgeCode.allowCommandExecution`: permit shell execution after confirmation.
- `forgeCode.defaultChatModel`: preferred chat model ID.
- `forgeCode.defaultCompletionModel`: preferred inline completion model ID.
- `forgeCode.maxContextCharacters`: workspace prompt budget.
- `forgeCode.maxReadFileBytes`: per-file read and edit limit.
- `forgeCode.maxSearchFileBytes`: per-file search limit.
- `forgeCode.maxCommandOutputCharacters`: maximum shell output returned to the model.
- `forgeCode.maxToolRounds`: cap for agent tool loops.
- `forgeCode.inlineCompletions.enabled`: toggle completions on or off.

## Development workflow

- `corepack pnpm compile`: build once.
- `corepack pnpm watch`: incremental compile for extension debugging.
- `corepack pnpm test`: run the TypeScript unit tests.
- `ForgeCode: Refresh Models`: force model rediscovery after changing the endpoint or loading a new model in LM Studio.
- `ForgeCode: Configure Endpoint`: update the configured endpoint without hand-editing settings.
- `ForgeCode: Configure API Key`: store or clear the optional bearer token in secret storage.

## Repository layout

- `src/`: extension runtime.
- `test/`: unit tests for pure protocol logic.
- `.vscode/`: launch and watch tasks for extension development.
- `ai_coder/`: legacy Roo prototype, task runner, and Gemini bridge retained for reference and migration history.

## Legacy note

Roo’s file-backed task runner and append-only logs are intentionally preserved, but they are not the production path anymore. ForgeCode is built around explicit context selection, bounded prompts, tool-mediated workspace access, and standard VS Code AI surfaces.
