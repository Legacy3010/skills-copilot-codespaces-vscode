import * as vscode from 'vscode';
import { ForgeCodeSettings } from '../config';
import { LOG_PREFIX } from '../util/constants';
import {
  MaterializedToolCall,
  OpenAIToolCallDelta,
  approximateTokenCount,
  coerceJsonObject,
  ensureSecureBaseUrl,
  materializeToolCalls,
  mergeToolCallDelta,
  stripCodeFences,
  trimToMaxChars,
} from './protocol';

interface OpenAIModelListResponse {
  data?: Array<{
    id?: string;
  }>;
}

interface OpenAIToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

interface OpenAIChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: OpenAIToolCall[];
}

interface OpenAIChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: string | null;
      tool_calls?: OpenAIToolCall[];
    };
  }>;
}

interface StreamCallbacks {
  onText(text: string): void;
  onToolCall(toolCall: MaterializedToolCall): void;
}

export interface ClientChatRequest {
  modelId: string;
  messages: readonly vscode.LanguageModelChatRequestMessage[];
  tools: readonly vscode.LanguageModelChatTool[];
  toolMode: vscode.LanguageModelChatToolMode;
  modelOptions?: { readonly [name: string]: unknown };
  settings: ForgeCodeSettings;
}

export interface CompletionRequest {
  languageId: string;
  modelId: string;
  prefix: string;
  prompt: string;
  settings: ForgeCodeSettings;
  suffix: string;
}

export class OpenAiCompatibleClient {
  constructor(private readonly output: vscode.OutputChannel) {}

  async listModels(settings: ForgeCodeSettings, token: vscode.CancellationToken): Promise<string[]> {
    const baseUrl = ensureSecureBaseUrl(settings.baseUrl, settings.allowRemoteEndpoints);
    const response = await this.fetchJson<OpenAIModelListResponse>(
      `${baseUrl}/models`,
      {
        method: 'GET',
        headers: this.buildHeaders(settings),
      },
      token,
    );

    return (response.data ?? [])
      .map((model) => model.id?.trim())
      .filter((modelId): modelId is string => Boolean(modelId));
  }

  async streamChat(
    request: ClientChatRequest,
    callbacks: StreamCallbacks,
    token: vscode.CancellationToken,
  ): Promise<void> {
    const baseUrl = ensureSecureBaseUrl(request.settings.baseUrl, request.settings.allowRemoteEndpoints);
    const response = await this.fetchResponse(
      `${baseUrl}/chat/completions`,
      {
        method: 'POST',
        headers: this.buildHeaders(request.settings),
        body: JSON.stringify({
          model: request.modelId,
          messages: this.toOpenAiMessages(request.messages),
          stream: true,
          temperature: this.resolveTemperature(request.settings, request.modelOptions),
          max_tokens: this.resolveMaxTokens(request.settings, request.modelOptions),
          tools: request.tools.length ? this.toOpenAiTools(request.tools) : undefined,
          tool_choice: this.resolveToolChoice(request.tools, request.toolMode),
        }),
      },
      token,
    );

    const contentType = response.headers.get('content-type') ?? '';
    if (!response.body || !contentType.includes('text/event-stream')) {
      const payload = await response.json() as OpenAIChatCompletionResponse;
      this.emitNonStreamingResponse(payload, callbacks);
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const toolCache = new Map<number, { index: number; id: string; name: string; argumentsText: string }>();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
      buffer = this.processSseBuffer(buffer, toolCache, callbacks);
      if (done) {
        break;
      }
    }

    for (const toolCall of materializeToolCalls(toolCache)) {
      callbacks.onToolCall(toolCall);
    }
  }

  async completeCode(request: CompletionRequest, token: vscode.CancellationToken): Promise<string> {
    const baseUrl = ensureSecureBaseUrl(request.settings.baseUrl, request.settings.allowRemoteEndpoints);
    const payload = await this.fetchJson<OpenAIChatCompletionResponse>(
      `${baseUrl}/chat/completions`,
      {
        method: 'POST',
        headers: this.buildHeaders(request.settings),
        body: JSON.stringify({
          model: request.modelId,
          temperature: this.resolveTemperature(request.settings),
          max_tokens: Math.min(512, request.settings.maxOutputTokens),
          messages: [
            {
              role: 'system',
              content: 'You are a precise code completion engine. Return only the text that should be inserted at the cursor. Do not wrap the answer in Markdown or explanation.',
            },
            {
              role: 'user',
              content: trimToMaxChars([
                `Language: ${request.languageId}`,
                request.prompt,
                'Prefix:',
                request.prefix,
                '<cursor>',
                'Suffix:',
                request.suffix,
              ].join('\n'), request.settings.inlineCompletions.maxPrefixChars + request.settings.inlineCompletions.maxSuffixChars + 1024),
            },
          ],
        }),
      },
      token,
    );

    const text = payload.choices?.[0]?.message?.content ?? '';
    return stripCodeFences(text).replace(/\r/g, '');
  }

  private buildHeaders(settings: ForgeCodeSettings): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (settings.apiKey) {
      headers.Authorization = `Bearer ${settings.apiKey}`;
    }

    return headers;
  }

  private async fetchJson<T>(url: string, init: RequestInit, token: vscode.CancellationToken): Promise<T> {
    const response = await this.fetchResponse(url, init, token);
    return await response.json() as T;
  }

  private async fetchResponse(url: string, init: RequestInit, token: vscode.CancellationToken): Promise<Response> {
    const controller = new AbortController();
    const disposable = token.onCancellationRequested(() => controller.abort());
    try {
      const response = await fetch(url, {
        ...init,
        signal: controller.signal,
      });

      if (!response.ok) {
        const body = await response.text();
        throw new Error(`Local model request failed (${response.status} ${response.statusText}): ${body}`);
      }

      return response;
    } catch (error) {
      this.output.appendLine(`${LOG_PREFIX} request failure for ${url}: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    } finally {
      disposable.dispose();
    }
  }

  private emitNonStreamingResponse(payload: OpenAIChatCompletionResponse, callbacks: StreamCallbacks): void {
    const message = payload.choices?.[0]?.message;
    const text = message?.content ?? '';
    if (text) {
      callbacks.onText(text);
    }

    for (const toolCall of message?.tool_calls ?? []) {
      callbacks.onToolCall({
        callId: toolCall.id,
        name: toolCall.function.name,
        input: coerceJsonObject(toolCall.function.arguments),
      });
    }
  }

  private processSseBuffer(
    input: string,
    toolCache: Map<number, { index: number; id: string; name: string; argumentsText: string }>,
    callbacks: StreamCallbacks,
  ): string {
    const normalized = input.replace(/\r\n/g, '\n');
    let buffer = normalized;

    while (true) {
      const boundaryIndex = buffer.indexOf('\n\n');
      if (boundaryIndex === -1) {
        break;
      }

      const rawEvent = buffer.slice(0, boundaryIndex).trim();
      buffer = buffer.slice(boundaryIndex + 2);
      if (!rawEvent) {
        continue;
      }

      const payload = rawEvent
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim())
        .join('');

      if (!payload || payload === '[DONE]') {
        continue;
      }

      const parsed = JSON.parse(payload) as {
        choices?: Array<{
          delta?: {
            content?: string;
            tool_calls?: OpenAIToolCallDelta[];
          };
        }>;
      };

      for (const choice of parsed.choices ?? []) {
        const delta = choice.delta;
        if (!delta) {
          continue;
        }

        if (delta.content) {
          callbacks.onText(delta.content);
        }

        for (const toolCall of delta.tool_calls ?? []) {
          mergeToolCallDelta(toolCache, toolCall);
        }
      }
    }

    return buffer;
  }

  private resolveTemperature(
    settings: ForgeCodeSettings,
    modelOptions?: { readonly [name: string]: unknown },
  ): number {
    const override = typeof modelOptions?.temperature === 'number' ? modelOptions.temperature : undefined;
    return Math.min(2, Math.max(0, override ?? settings.temperature));
  }

  private resolveMaxTokens(
    settings: ForgeCodeSettings,
    modelOptions?: { readonly [name: string]: unknown },
  ): number {
    const override = typeof modelOptions?.maxOutputTokens === 'number'
      ? modelOptions.maxOutputTokens
      : typeof modelOptions?.max_tokens === 'number'
        ? modelOptions.max_tokens
        : undefined;
    return Math.min(settings.maxOutputTokens, Math.max(128, override ?? settings.maxOutputTokens));
  }

  private resolveToolChoice(
    tools: readonly vscode.LanguageModelChatTool[],
    toolMode: vscode.LanguageModelChatToolMode,
  ): 'auto' | 'required' | { type: 'function'; function: { name: string } } | undefined {
    if (!tools.length) {
      return undefined;
    }

    if (toolMode === vscode.LanguageModelChatToolMode.Required) {
      if (tools.length === 1) {
        return {
          type: 'function',
          function: {
            name: tools[0].name,
          },
        };
      }

      return 'required';
    }

    return 'auto';
  }

  private toOpenAiTools(tools: readonly vscode.LanguageModelChatTool[]): Array<{
    type: 'function';
    function: {
      name: string;
      description: string;
      parameters: object;
    };
  }> {
    return tools.map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema ?? { type: 'object', properties: {} },
      },
    }));
  }

  private toOpenAiMessages(messages: readonly vscode.LanguageModelChatRequestMessage[]): OpenAIChatMessage[] {
    const converted: OpenAIChatMessage[] = [];

    for (const message of messages) {
      const textParts: string[] = [];
      const assistantToolCalls: OpenAIToolCall[] = [];
      const userToolResults: Array<{ callId: string; content: string }> = [];

      for (const part of message.content) {
        if (part instanceof vscode.LanguageModelTextPart) {
          textParts.push(part.value);
        } else if (part instanceof vscode.LanguageModelToolCallPart) {
          assistantToolCalls.push({
            id: part.callId,
            type: 'function',
            function: {
              name: part.name,
              arguments: JSON.stringify(part.input),
            },
          });
        } else if (part instanceof vscode.LanguageModelToolResultPart) {
          const toolText = part.content
            .filter((contentPart): contentPart is vscode.LanguageModelTextPart => contentPart instanceof vscode.LanguageModelTextPart)
            .map((contentPart) => contentPart.value)
            .join('\n');

          userToolResults.push({
            callId: part.callId,
            content: toolText || '[tool result omitted]',
          });
        }
      }

      const combinedText = textParts.join('\n').trim();

      if (message.role === vscode.LanguageModelChatMessageRole.Assistant) {
        if (assistantToolCalls.length) {
          converted.push({
            role: 'assistant',
            content: combinedText || null,
            tool_calls: assistantToolCalls,
            name: message.name,
          });
        } else if (combinedText) {
          converted.push({
            role: 'assistant',
            content: combinedText,
            name: message.name,
          });
        }
      } else {
        if (combinedText) {
          converted.push({
            role: 'user',
            content: combinedText,
            name: message.name,
          });
        }

        for (const toolResult of userToolResults) {
          converted.push({
            role: 'tool',
            tool_call_id: toolResult.callId,
            content: trimToMaxChars(toolResult.content, 12000),
          });
        }
      }
    }

    return converted;
  }
}

export function serializeRequestMessage(message: vscode.LanguageModelChatRequestMessage): string {
  const parts = message.content.map((part) => {
    if (part instanceof vscode.LanguageModelTextPart) {
      return part.value;
    }

    if (part instanceof vscode.LanguageModelToolCallPart) {
      return `${part.name}(${JSON.stringify(part.input)})`;
    }

    if (part instanceof vscode.LanguageModelToolResultPart) {
      return part.content
        .filter((contentPart): contentPart is vscode.LanguageModelTextPart => contentPart instanceof vscode.LanguageModelTextPart)
        .map((contentPart) => contentPart.value)
        .join('\n');
    }

    return '';
  });

  return `${message.role}:${parts.join('\n')}`;
}

export function approximateMessageTokens(message: vscode.LanguageModelChatRequestMessage): number {
  return approximateTokenCount(serializeRequestMessage(message));
}