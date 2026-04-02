import * as vscode from 'vscode';
import { getSettings } from '../config';
import { OpenAiCompatibleClient } from '../provider/openAiCompatibleClient';
import { stripCodeFences } from '../provider/protocol';
import { LOG_PREFIX } from '../util/constants';

export function registerInlineCompletionProvider(
  context: vscode.ExtensionContext,
  client: OpenAiCompatibleClient,
  output: vscode.OutputChannel,
): void {
  const provider: vscode.InlineCompletionItemProvider = {
    async provideInlineCompletionItems(document, position, inlineContext, token) {
      const settings = getSettings();
      if (!settings.inlineCompletions.enabled) {
        return;
      }

      if (document.uri.scheme !== 'file' && document.uri.scheme !== 'untitled') {
        return;
      }

      if (inlineContext.selectedCompletionInfo) {
        return;
      }

      if (['markdown', 'plaintext', 'log'].includes(document.languageId)) {
        return;
      }

      const fullText = document.getText();
      const offset = document.offsetAt(position);
      const prefix = fullText.slice(Math.max(0, offset - settings.inlineCompletions.maxPrefixChars), offset);
      const suffix = fullText.slice(offset, Math.min(fullText.length, offset + settings.inlineCompletions.maxSuffixChars));

      if (inlineContext.triggerKind === vscode.InlineCompletionTriggerKind.Automatic && prefix.trim().length < settings.inlineCompletions.minPromptCharacters) {
        return;
      }

      const modelId = settings.defaultCompletionModel || settings.defaultChatModel;
      if (!modelId) {
        return;
      }

      try {
        const completion = await client.completeCode(
          {
            languageId: document.languageId,
            modelId,
            prefix,
            suffix,
            settings,
            prompt: 'Continue the file at the cursor. Preserve the existing style, indentation, and surrounding API surface.',
          },
          token,
        );

        const cleaned = cleanupCompletion(completion, prefix);
        if (!cleaned.trim()) {
          return;
        }

        return new vscode.InlineCompletionList([
          new vscode.InlineCompletionItem(cleaned, new vscode.Range(position, position)),
        ]);
      } catch (error) {
        output.appendLine(`${LOG_PREFIX} inline completion failed: ${error instanceof Error ? error.message : String(error)}`);
        return;
      }
    },
  };

  context.subscriptions.push(vscode.languages.registerInlineCompletionItemProvider({ pattern: '**' }, provider));
}

function cleanupCompletion(text: string, prefix: string): string {
  let cleaned = stripCodeFences(text).replace(/<cursor>/g, '').replace(/\r/g, '');
  const prefixTail = prefix.slice(-160);
  if (prefixTail && cleaned.startsWith(prefixTail)) {
    cleaned = cleaned.slice(prefixTail.length);
  }

  return cleaned;
}