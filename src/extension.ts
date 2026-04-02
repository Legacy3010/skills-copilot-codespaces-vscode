import * as vscode from 'vscode';
import { initializeSettings } from './config';
import { registerLocalAgentParticipant } from './chat/localAgentParticipant';
import { registerCommands } from './commands';
import { registerInlineCompletionProvider } from './completion/inlineCompletionProvider';
import { WorkspaceContextService } from './context/workspaceContext';
import { LocalAiModelProvider } from './provider/localAiModelProvider';
import { OpenAiCompatibleClient } from './provider/openAiCompatibleClient';
import { registerWorkspaceTools } from './tools/workspaceTools';
import { APP_NAME, EXTENSION_SECTION, LOG_PREFIX, MODEL_VENDOR } from './util/constants';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  await initializeSettings(context);

  const output = vscode.window.createOutputChannel(APP_NAME);
  const client = new OpenAiCompatibleClient(output);
  const modelProvider = new LocalAiModelProvider(client, output);
  const workspaceContext = new WorkspaceContextService(output);

  context.subscriptions.push(output);
  context.subscriptions.push(vscode.lm.registerLanguageModelChatProvider(MODEL_VENDOR, modelProvider));

  registerWorkspaceTools(context, output);
  registerLocalAgentParticipant(context, workspaceContext, output);
  registerInlineCompletionProvider(context, client, output);
  registerCommands(context, modelProvider, workspaceContext, output);

  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((event) => {
    if (event.affectsConfiguration(EXTENSION_SECTION)) {
      modelProvider.refresh();
    }
  }));

  output.appendLine(`${LOG_PREFIX} extension activated.`);
}

export function deactivate(): void {}