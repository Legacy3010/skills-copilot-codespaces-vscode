# ForgeCode Blueprint

## Mission

Build a production-grade, local-first coding agent for VS Code that can use LM Studio models through standard editor surfaces instead of relying on a custom append-only memory runtime.

The system should:

* work inside the VS Code model picker and chat UI,
* support agent-style tool calling,
* keep context bounded and task-specific,
* write and validate code safely,
* remain extensible for additional local model backends.

## Product Pillars

### 1. Provider-First Integration

The model backend should be contributed as a real VS Code language model provider.

* Models appear in the picker.
* Requests flow through VS Code APIs instead of an external prompt shim.
* The same provider powers chat, tool use, and completions.

### 2. Explicit Context Assembly

Context must be generated from the active workspace state, not replayed from historical files.

* Cap prompt size.
* Prefer file search and targeted reads over global memory dumps.
* Make context freshness more important than context volume.

### 3. Tool-Mediated Execution

The agent should act through narrow, inspectable tools.

* Read tools for search and inspection.
* Write tools for controlled mutation.
* Execution tools for validation and build steps.
* Confirmation gates on anything with side effects.

### 4. Local-First UX

The experience should work for users who want local models rather than a hosted Copilot-only path.

* Default to LM Studio's OpenAI-compatible server.
* Keep the transport generic enough for other compatible backends.
* Preserve fast local iteration with `F5`, watch mode, and model refresh commands.
* Default to localhost-only endpoints and opt-in command execution.

## Runtime Architecture

### Provider

Handles model discovery, request translation, SSE parsing, and tool-call reconstruction.

### Participant

Runs the coding agent loop inside a sticky `@local` chat participant.

### Tools

Expose the workspace in a narrow, auditable way.

### Completions

Use the same endpoint to provide code continuations in the editor.

### Context Service

Builds bounded editor and workspace summaries on demand.

## Anti-Goals

* Do not require Roo log replay for normal operation.
* Do not force all prior tasks into prompt context.
* Do not hide side effects behind unconfirmed tool calls.
* Do not couple the architecture to a single hosted vendor.

## Migration Stance

The `ai_coder/` directory stays in the repository as legacy material and a historical benchmark. It is not the primary runtime contract anymore.

## Near-Term Roadmap

1. Complete the TypeScript extension scaffold and provider integration.
1. Harden the tool loop and inline completion quality.
1. Add extension-host integration tests.
1. Add a dedicated Ollama transport adapter where OpenAI compatibility is insufficient.
1. Add richer diff-oriented editing tools and workspace validation recipes.
