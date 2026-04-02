import * as vscode from 'vscode';
import { getSettings } from '../config';
import { APP_NAME, LOG_PREFIX, MODEL_VENDOR } from '../util/constants';
import { approximateMessageTokens, OpenAiCompatibleClient } from './openAiCompatibleClient';
import { approximateTokenCount } from './protocol';

export class LocalAiModelProvider implements vscode.LanguageModelChatProvider<vscode.LanguageModelChatInformation> {
  private readonly onDidChangeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeLanguageModelChatInformation = this.onDidChangeEmitter.event;

  private cachedModels: vscode.LanguageModelChatInformation[] | undefined;

  constructor(
    private readonly client: OpenAiCompatibleClient,
    private readonly output: vscode.OutputChannel,
  ) {}

  refresh(): void {
    this.cachedModels = undefined;
    this.onDidChangeEmitter.fire();
  }

  async provideLanguageModelChatInformation(
    _options: vscode.PrepareLanguageModelChatModelOptions,
    token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelChatInformation[]> {
    if (this.cachedModels) {
      return this.cachedModels;
    }

    const settings = getSettings();
    let modelIds = [...settings.discoveredModels];

    if (!modelIds.length) {
      try {
        modelIds = await this.client.listModels(settings, token);
      } catch (error) {
        this.output.appendLine(`${LOG_PREFIX} model discovery failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    if (!modelIds.length) {
      modelIds = [settings.defaultChatModel || 'local-model'];
    }

    const deduped = [...new Set(modelIds.filter(Boolean))];
    this.cachedModels = deduped.map((modelId) => this.createModelInformation(modelId, settings));
    return this.cachedModels;
  }

  async provideLanguageModelChatResponse(
    model: vscode.LanguageModelChatInformation,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken,
  ): Promise<void> {
    await this.client.streamChat(
      {
        modelId: model.id,
        messages,
        tools: options.tools ?? [],
        toolMode: options.toolMode,
        modelOptions: options.modelOptions,
        settings: getSettings(),
      },
      {
        onText: (text) => progress.report(new vscode.LanguageModelTextPart(text)),
        onToolCall: (toolCall) => progress.report(new vscode.LanguageModelToolCallPart(toolCall.callId, toolCall.name, toolCall.input)),
      },
      token,
    );
  }

  async provideTokenCount(
    _model: vscode.LanguageModelChatInformation,
    text: string | vscode.LanguageModelChatRequestMessage,
    _token: vscode.CancellationToken,
  ): Promise<number> {
    if (typeof text === 'string') {
      return approximateTokenCount(text);
    }

    return approximateMessageTokens(text);
  }

  private createModelInformation(
    modelId: string,
    settings: ReturnType<typeof getSettings>,
  ): vscode.LanguageModelChatInformation {
    return {
      id: modelId,
      name: modelId,
      family: this.inferFamily(modelId),
      version: 'local',
      maxInputTokens: settings.maxInputTokens,
      maxOutputTokens: settings.maxOutputTokens,
      tooltip: `${modelId} via ${settings.baseUrl}`,
      detail: `${APP_NAME} (LM Studio / OpenAI-compatible)`,
      capabilities: {
        toolCalling: 16,
      },
    };
  }

  private inferFamily(modelId: string): string {
    const [family] = modelId.split(/[:/]/).filter(Boolean);
    return family || MODEL_VENDOR;
  }
}