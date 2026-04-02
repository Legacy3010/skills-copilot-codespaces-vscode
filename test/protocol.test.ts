import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ensureSecureBaseUrl,
  materializeToolCalls,
  mergeToolCallDelta,
  normalizeBaseUrl,
  stripCodeFences,
  trimToMaxChars,
} from '../src/provider/protocol';

test('normalizeBaseUrl appends v1 when missing', () => {
  assert.equal(normalizeBaseUrl('http://127.0.0.1:1234'), 'http://127.0.0.1:1234/v1');
  assert.equal(normalizeBaseUrl('http://127.0.0.1:1234/v1'), 'http://127.0.0.1:1234/v1');
});

test('ensureSecureBaseUrl accepts localhost endpoints by default', () => {
  assert.equal(ensureSecureBaseUrl('http://127.0.0.1:1234', false), 'http://127.0.0.1:1234/v1');
  assert.equal(ensureSecureBaseUrl('http://localhost:11434/v1', false), 'http://localhost:11434/v1');
});

test('ensureSecureBaseUrl blocks insecure remote endpoints', () => {
  assert.throws(() => ensureSecureBaseUrl('http://example.com/v1', false), /Remote endpoints are disabled/);
  assert.throws(() => ensureSecureBaseUrl('http://example.com/v1', true), /must use https/);
  assert.equal(ensureSecureBaseUrl('https://example.com/v1', true), 'https://example.com/v1');
});

test('mergeToolCallDelta reconstructs streamed tool arguments', () => {
  const cache = new Map<number, { index: number; id: string; name: string; argumentsText: string }>();
  mergeToolCallDelta(cache, { index: 0, id: 'call-1', function: { name: 'read_file', arguments: '{"path":' } });
  mergeToolCallDelta(cache, { index: 0, function: { arguments: '"README.md"}' } });
  assert.deepEqual(materializeToolCalls(cache), [
    {
      callId: 'call-1',
      name: 'read_file',
      input: { path: 'README.md' },
    },
  ]);
});

test('stripCodeFences removes fenced wrappers', () => {
  assert.equal(stripCodeFences('```ts\nconst value = 1;\n```'), 'const value = 1;');
});

test('trimToMaxChars keeps head and tail context', () => {
  const input = 'a'.repeat(500) + 'middle' + 'b'.repeat(500);
  const trimmed = trimToMaxChars(input, 200);
  assert.ok(trimmed.startsWith('a'));
  assert.ok(trimmed.includes('...<trimmed>...'));
  assert.ok(trimmed.endsWith('b'.repeat(40)));
});