import * as vscode from 'vscode';
import { getSettings } from '../config';
import { WorkspaceContextService } from '../context/workspaceContext';
import { APP_NAME, CHAT_PARTICIPANT_ID, LOG_PREFIX, MODEL_VENDOR, TOOL_TAGS } from '../util/constants';

export function registerLocalAgentParticipant(
  context: vscode.ExtensionContext,
  workspaceContext: WorkspaceContextService,
  output: vscode.OutputChannel,
): void {
  const handler: vscode.ChatRequestHandler = async (request, chatContext, stream, token) => {
    const model = await selectModel(request.model);
    if (!model) {
      stream.markdown(`No ${APP_NAME} model is available. Start LM Studio, enable its local server, and refresh the provider.`);
      return;
    }

    const tools = selectTools(request.command);
    const workspaceSnapshot = await workspaceContext.buildSnapshot(token);
    const messages = buildInitialMessages(request, chatContext, workspaceSnapshot);
    const maxToolRounds = getSettings().maxToolRounds;

    for (let round = 0; round < maxToolRounds; round += 1) {
      const response = await model.sendRequest(
        messages,
        {
          justification: 'Execute a ForgeCode chat request.',
          tools,
        },
        token,
      );

      let text = '';
      const toolCalls: vscode.LanguageModelToolCallPart[] = [];
      for await (const part of response.stream) {
        if (part instanceof vscode.LanguageModelTextPart) {
          text += part.value;
          stream.markdown(part.value);
        } else if (part instanceof vscode.LanguageModelToolCallPart) {
          toolCalls.push(part);
        }
      }

      if (!toolCalls.length) {
        return {
          metadata: {
            modelId: model.id,
            toolRounds: round,
          },
        };
      }

      const assistantParts: Array<vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart> = [];
      if (text) {
        assistantParts.push(new vscode.LanguageModelTextPart(text));
      }
      assistantParts.push(...toolCalls);
      messages.push(vscode.LanguageModelChatMessage.Assistant(assistantParts));

      const toolResults: vscode.LanguageModelToolResultPart[] = [];
      for (const toolCall of toolCalls) {
        const toolResult = await vscode.lm.invokeTool(
          toolCall.name,
          {
            input: toolCall.input,
            toolInvocationToken: request.toolInvocationToken,
          },
          token,
        );
        toolResults.push(new vscode.LanguageModelToolResultPart(toolCall.callId, toolResult.content));
      }
      messages.push(vscode.LanguageModelChatMessage.User(toolResults));
    }

    output.appendLine(`${LOG_PREFIX} tool round limit reached for chat participant request.`);
    stream.markdown(`\n\nStopped after reaching the ${APP_NAME} tool round limit. Tighten the request or inspect the prior tool results and try again.`);
    return {
      metadata: {
        truncated: true,
      },
    };
  };

  const participant = vscode.chat.createChatParticipant(CHAT_PARTICIPANT_ID, handler);
  participant.iconPath = new vscode.ThemeIcon('hubot');
  context.subscriptions.push(participant);
}

function selectTools(command: string | undefined): vscode.LanguageModelToolInformation[] {
  const baseTools = vscode.lm.tools.filter((tool) => tool.tags.includes(TOOL_TAGS.root));
  if (!command || command === 'implement') {
    return baseTools;
  }

  return baseTools.filter((tool) => !tool.tags.includes(TOOL_TAGS.write) && !tool.tags.includes(TOOL_TAGS.exec));
}

function buildInitialMessages(
  request: vscode.ChatRequest,
  context: vscode.ChatContext,
  workspaceSnapshot: string,
): vscode.LanguageModelChatMessage[] {
  const messages: vscode.LanguageModelChatMessage[] = [
    vscode.LanguageModelChatMessage.User([
      new vscode.LanguageModelTextPart(buildInstructionBlock(request.command, workspaceSnapshot)),
    ]),
  ];

  for (const turn of context.history.slice(-6)) {
    if (turn instanceof vscode.ChatRequestTurn) {
      messages.push(vscode.LanguageModelChatMessage.User(turn.prompt));
    } else if (turn instanceof vscode.ChatResponseTurn) {
      const responseText = turn.response
        .map((part) => part instanceof vscode.ChatResponseMarkdownPart ? part.value.value : '')
        .join('')
        .trim();

      if (responseText) {
        messages.push(vscode.LanguageModelChatMessage.Assistant(responseText));
      }
    }
  }

  messages.push(vscode.LanguageModelChatMessage.User(request.prompt));
  return messages;
}

function buildInstructionBlock(command: string | undefined, workspaceSnapshot: string): string {
  const operatingMode = command ?? 'implement';
  const commandSpecificGuidance = command === 'review'
    ? 'Primary goal: find bugs, regressions, missing validation, and test gaps. Findings first, short summary second.'
    : command === 'plan'
      ? 'Primary goal: create a concise implementation plan. Do not propose edits until you have inspected the relevant files.'
      : command === 'explain'
        ? 'Primary goal: explain code and architecture clearly, using tools only when they add needed context.'
        : 'Primary goal: solve the task end to end. Prefer small, direct changes and verify the result with tools when useful.';

  return [
    `You are ${APP_NAME} running in ${operatingMode} mode.`,
    'Operate like a pragmatic senior engineer.',
    'Keep prompts lean. Read only the files you need. Do not rely on append-only memory.',
    'Prefer tools for file reads, search, targeted edits, and validation.',
    commandSpecificGuidance,
    '',
    'Current workspace snapshot:',
    workspaceSnapshot,
  ].join('\n');
}

async function selectModel(currentModel: vscode.LanguageModelChat): Promise<vscode.LanguageModelChat | undefined> {
  if (currentModel.vendor === MODEL_VENDOR) {
    return currentModel;
  }

  const settings = getSettings();
  if (settings.defaultChatModel) {
    const matching = await vscode.lm.selectChatModels({
      vendor: MODEL_VENDOR,
      id: settings.defaultChatModel,
    });
    if (matching.length) {
      return matching[0];
    }
  }

  const fallback = await vscode.lm.selectChatModels({ vendor: MODEL_VENDOR });
  return fallback[0];
}