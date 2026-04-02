import * as vscode from 'vscode';
import { getSettings, storeApiKey, updateBaseUrl } from './config';
import { WorkspaceContextService } from './context/workspaceContext';
import { LocalAiModelProvider } from './provider/localAiModelProvider';
import { APP_NAME, COMMANDS, LOG_PREFIX, MODEL_VENDOR } from './util/constants';

export function registerCommands(
  context: vscode.ExtensionContext,
  modelProvider: LocalAiModelProvider,
  workspaceContext: WorkspaceContextService,
  output: vscode.OutputChannel,
): void {
  context.subscriptions.push(vscode.commands.registerCommand(COMMANDS.refreshModels, async () => {
    modelProvider.refresh();
    vscode.window.showInformationMessage(`${APP_NAME} model list refreshed.`);
  }));

  context.subscriptions.push(vscode.commands.registerCommand(COMMANDS.configureEndpoint, async () => {
    const current = getSettings().baseUrl;
    const next = await vscode.window.showInputBox({
      prompt: 'Enter the OpenAI-compatible endpoint URL',
      placeHolder: 'http://127.0.0.1:1234/v1',
      value: current,
      ignoreFocusOut: true,
    });
    if (!next) {
      return;
    }

    await updateBaseUrl(next);
    modelProvider.refresh();
    vscode.window.showInformationMessage(`${APP_NAME} endpoint updated to ${next}.`);
  }));

  context.subscriptions.push(vscode.commands.registerCommand(COMMANDS.configureApiKey, async () => {
    const next = await vscode.window.showInputBox({
      prompt: 'Enter the optional bearer token for the configured endpoint. Leave blank to clear it.',
      password: true,
      ignoreFocusOut: true,
    });

    if (next === undefined) {
      return;
    }

    await storeApiKey(next);
    modelProvider.refresh();
    vscode.window.showInformationMessage(next.trim() ? `${APP_NAME} API key stored in VS Code secret storage.` : `${APP_NAME} API key cleared.`);
  }));

  context.subscriptions.push(vscode.commands.registerCommand(COMMANDS.explainSelection, async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showWarningMessage(`Open a text editor before asking ${APP_NAME} to explain a selection.`);
      return;
    }

    const model = await selectModel();
    if (!model) {
      vscode.window.showWarningMessage(`No ${APP_NAME} model is available. Start LM Studio and refresh the provider.`);
      return;
    }

    const selectionText = editor.document.getText(editor.selection).trim() || editor.document.lineAt(editor.selection.active.line).text;
    const contextText = workspaceContext.getActiveSelectionContext() ?? selectionText;

    try {
      const response = await model.sendRequest([
        vscode.LanguageModelChatMessage.User('Explain the selected code for a teammate. Focus on intent, control flow, data flow, and risky edges. Be concise.'),
        vscode.LanguageModelChatMessage.User(contextText),
      ], {
        justification: 'Explain the active editor selection.',
      });

      let outputText = '';
      for await (const chunk of response.text) {
        outputText += chunk;
      }

      const document = await vscode.workspace.openTextDocument({
        language: 'markdown',
        content: [
          `# ${APP_NAME} Explanation`,
          '',
          `File: ${vscode.workspace.asRelativePath(editor.document.uri, false)}`,
          '',
          outputText.trim(),
        ].join('\n'),
      });
      await vscode.window.showTextDocument(document, { preview: false });
    } catch (error) {
      output.appendLine(`${LOG_PREFIX} explain selection failed: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  }));
}

async function selectModel(): Promise<vscode.LanguageModelChat | undefined> {
  const settings = getSettings();
  if (settings.defaultChatModel) {
    const exact = await vscode.lm.selectChatModels({
      vendor: MODEL_VENDOR,
      id: settings.defaultChatModel,
    });
    if (exact.length) {
      return exact[0];
    }
  }

  const all = await vscode.lm.selectChatModels({ vendor: MODEL_VENDOR });
  return all[0];
}