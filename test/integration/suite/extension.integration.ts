import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { getSettings } from '../../../src/config';
import { COMMANDS, MODEL_VENDOR, TOOL_NAMES } from '../../../src/util/constants';

const EXTENSION_ID = 'vibecode.forgecode-agent';

suite('ForgeCode Extension Host', function () {
  this.timeout(60000);

  let priorAllowCommandExecution: boolean | undefined;
  let priorAllowRemoteEndpoints: boolean | undefined;
  let priorBaseUrl: string | undefined;
  let priorDiscoveredModels: readonly string[] | undefined;

  suiteSetup(async () => {
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension, `Extension ${EXTENSION_ID} should be available in the test host.`);
    await extension.activate();

    const config = vscode.workspace.getConfiguration('forgeCode');
    priorAllowCommandExecution = config.inspect<boolean>('allowCommandExecution')?.workspaceValue;
    priorAllowRemoteEndpoints = config.inspect<boolean>('allowRemoteEndpoints')?.workspaceValue;
    priorBaseUrl = config.inspect<string>('baseUrl')?.workspaceValue;
    priorDiscoveredModels = config.inspect<string[]>('discoveredModels')?.workspaceValue;
    await config.update('discoveredModels', ['forgecode-test-model', 'forgecode-fallback-model'], vscode.ConfigurationTarget.Workspace);
    await vscode.commands.executeCommand(COMMANDS.refreshModels);
    await waitForModels();
  });

  suiteTeardown(async () => {
    const config = vscode.workspace.getConfiguration('forgeCode');
    await config.update('allowCommandExecution', priorAllowCommandExecution, vscode.ConfigurationTarget.Workspace);
    await config.update('allowRemoteEndpoints', priorAllowRemoteEndpoints, vscode.ConfigurationTarget.Workspace);
    await config.update('baseUrl', priorBaseUrl, vscode.ConfigurationTarget.Workspace);
    await config.update('discoveredModels', priorDiscoveredModels, vscode.ConfigurationTarget.Workspace);
  });

  test('registers expected ForgeCode commands', async () => {
    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes(COMMANDS.refreshModels));
    assert.ok(commands.includes(COMMANDS.configureEndpoint));
    assert.ok(commands.includes(COMMANDS.configureApiKey));
    assert.ok(commands.includes(COMMANDS.explainSelection));
  });

  test('discovers models from configured fallback settings', async () => {
    const models = await vscode.lm.selectChatModels({ vendor: MODEL_VENDOR });
    assert.ok(models.some((model) => model.id === 'forgecode-test-model'));
    assert.ok(models.some((model) => model.id === 'forgecode-fallback-model'));
  });

  test('executes read-only workspace tools', async () => {
    const filesResult = await vscode.lm.invokeTool(TOOL_NAMES.listWorkspaceFiles, {
      input: { glob: '**/*', maxResults: 20 },
      toolInvocationToken: undefined,
    });
    const filesText = flattenToolResult(filesResult);
    assert.match(filesText, /README\.md/);
    assert.match(filesText, /src[\\/]sample\.ts/);

    const readResult = await vscode.lm.invokeTool(TOOL_NAMES.readFile, {
      input: { path: 'src/sample.ts', startLine: 1, endLine: 3 },
      toolInvocationToken: undefined,
    });
    const readText = flattenToolResult(readResult);
    assert.match(readText, /src[\\/]sample\.ts/);
    assert.match(readText, /return `hello \$\{name\}`;/);

    const searchResult = await vscode.lm.invokeTool(TOOL_NAMES.searchWorkspace, {
      input: { query: 'hello', include: 'src/**/*.ts', maxResults: 5 },
      toolInvocationToken: undefined,
    });
    const searchText = flattenToolResult(searchResult);
    assert.match(searchText, /src[\\/]sample\.ts:2:/);
  });

  test('rejects terminal execution when command access is disabled', async () => {
    const config = vscode.workspace.getConfiguration('forgeCode');
    await config.update('allowCommandExecution', false, vscode.ConfigurationTarget.Workspace);

    await assert.rejects(
      async () => {
        await vscode.lm.invokeTool(TOOL_NAMES.runTerminalCommand, {
          input: { command: 'echo smoke-test' },
          toolInvocationToken: undefined,
        });
      },
      /Shell execution is disabled/,
    );
  });

  test('rejects insecure remote endpoints in workspace settings', async () => {
    const config = vscode.workspace.getConfiguration('forgeCode');
    await config.update('allowRemoteEndpoints', false, vscode.ConfigurationTarget.Workspace);
    await config.update('baseUrl', 'http://example.com/v1', vscode.ConfigurationTarget.Workspace);

    assert.throws(() => getSettings(), /Remote endpoints are disabled/);
  });
});

function flattenToolResult(result: vscode.LanguageModelToolResult): string {
  return result.content
    .filter((part): part is vscode.LanguageModelTextPart => part instanceof vscode.LanguageModelTextPart)
    .map((part) => part.value)
    .join('\n');
}

async function waitForModels(): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const models = await vscode.lm.selectChatModels({ vendor: MODEL_VENDOR });
    if (models.some((model) => model.id === 'forgecode-test-model')) {
      return;
    }

    await delay(250);
  }

  throw new Error('ForgeCode models were not discovered in time.');
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}