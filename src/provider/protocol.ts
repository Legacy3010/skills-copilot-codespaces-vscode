import { DEFAULT_LOCAL_BASE_URL } from '../util/constants';

export interface OpenAIToolCallDelta {
  index: number;
  id?: string;
  function?: {
    name?: string;
    arguments?: string;
  };
}

export interface PendingToolCall {
  index: number;
  id: string;
  name: string;
  argumentsText: string;
}

export interface MaterializedToolCall {
  callId: string;
  name: string;
  input: Record<string, unknown>;
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

export function normalizeBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '');
  if (!trimmed) {
    return DEFAULT_LOCAL_BASE_URL;
  }

  if (trimmed.endsWith('/v1')) {
    return trimmed;
  }

  return `${trimmed}/v1`;
}

export function ensureSecureBaseUrl(baseUrl: string, allowRemoteEndpoints: boolean): string {
  const normalized = normalizeBaseUrl(baseUrl);
  let parsed: URL;

  try {
    parsed = new URL(normalized);
  } catch {
    throw new Error(`Invalid model endpoint URL: ${baseUrl}`);
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('Model endpoint must use http or https.');
  }

  if (parsed.username || parsed.password) {
    throw new Error('Do not embed credentials in the model endpoint URL. Store secrets separately.');
  }

  const isLoopback = LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase()) || parsed.hostname.toLowerCase().endsWith('.localhost');
  if (!allowRemoteEndpoints && !isLoopback) {
    throw new Error('Remote endpoints are disabled. Point ForgeCode at localhost or enable forgeCode.allowRemoteEndpoints.');
  }

  if (allowRemoteEndpoints && !isLoopback && parsed.protocol !== 'https:') {
    throw new Error('Remote endpoints must use https.');
  }

  return normalized;
}

export function approximateTokenCount(value: string): number {
  if (!value) {
    return 1;
  }

  return Math.max(1, Math.ceil(value.length / 4));
}

export function mergeToolCallDelta(cache: Map<number, PendingToolCall>, delta: OpenAIToolCallDelta): void {
  const existing = cache.get(delta.index);
  const next: PendingToolCall = {
    index: delta.index,
    id: delta.id ?? existing?.id ?? `tool-${delta.index}`,
    name: delta.function?.name ?? existing?.name ?? 'unknown_tool',
    argumentsText: `${existing?.argumentsText ?? ''}${delta.function?.arguments ?? ''}`,
  };
  cache.set(delta.index, next);
}

export function materializeToolCalls(cache: Map<number, PendingToolCall>): MaterializedToolCall[] {
  return [...cache.values()]
    .sort((left, right) => left.index - right.index)
    .map((toolCall) => ({
      callId: toolCall.id,
      name: toolCall.name,
      input: coerceJsonObject(toolCall.argumentsText),
    }));
}

export function coerceJsonObject(source: string): Record<string, unknown> {
  const trimmed = source.trim();
  if (!trimmed) {
    return {};
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }

    return { value: parsed };
  } catch {
    return { raw: trimmed };
  }
}

export function trimToMaxChars(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }

  const tailLength = Math.max(256, Math.floor(maxChars * 0.2));
  const headLength = Math.max(256, maxChars - tailLength - 18);
  return `${text.slice(0, headLength)}\n...<trimmed>...\n${text.slice(-tailLength)}`;
}

export function stripCodeFences(text: string): string {
  const trimmed = text.trim();
  const fenceMatch = trimmed.match(/^```[a-zA-Z0-9_-]*\n([\s\S]*?)\n```$/);
  if (fenceMatch) {
    return fenceMatch[1];
  }

  return trimmed;
}