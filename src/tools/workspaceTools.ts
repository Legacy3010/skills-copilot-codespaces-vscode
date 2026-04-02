import { spawn } from 'node:child_process';
import { lstat, realpath } from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { getSettings } from '../config';
import { trimToMaxChars } from '../provider/protocol';
import { APP_NAME, LOG_PREFIX, TOOL_NAMES } from '../util/constants';

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const EXCLUDE_GLOB = '**/{.git,node_modules,out,dist,__pycache__,.venv}/**';
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/;
const COMMAND_ENV_ALLOWLIST = process.platform === 'win32'
  ? ['APPDATA', 'ComSpec', 'HOMEDRIVE', 'HOMEPATH', 'LOCALAPPDATA', 'NUMBER_OF_PROCESSORS', 'OS', 'Path', 'PATHEXT', 'ProgramData', 'ProgramFiles', 'ProgramFiles(x86)', 'SystemDrive', 'SystemRoot', 'TEMP', 'TMP', 'USERPROFILE', 'windir']
  : ['HOME', 'LANG', 'LC_ALL', 'PATH', 'SHELL', 'TERM', 'TMPDIR', 'USER'];

export function registerWorkspaceTools(
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel,
): void {
  context.subscriptions.push(vscode.lm.registerTool(TOOL_NAMES.listWorkspaceFiles, new ListWorkspaceFilesTool()));
  context.subscriptions.push(vscode.lm.registerTool(TOOL_NAMES.searchWorkspace, new SearchWorkspaceTool()));
  context.subscriptions.push(vscode.lm.registerTool(TOOL_NAMES.readFile, new ReadFileTool()));
  context.subscriptions.push(vscode.lm.registerTool(TOOL_NAMES.writeFile, new WriteFileTool()));
  context.subscriptions.push(vscode.lm.registerTool(TOOL_NAMES.replaceInFile, new ReplaceInFileTool()));
  context.subscriptions.push(vscode.lm.registerTool(TOOL_NAMES.runTerminalCommand, new RunTerminalCommandTool(output)));
}

interface ListWorkspaceFilesInput {
  glob?: string;
  maxResults?: number;
}

interface SearchWorkspaceInput {
  include?: string;
  isRegExp?: boolean;
  maxResults?: number;
  query: string;
}

interface ReadFileInput {
  endLine?: number;
  path: string;
  startLine?: number;
}

interface WriteFileInput {
  content: string;
  path: string;
}

interface ReplaceInFileInput {
  newText: string;
  oldText: string;
  path: string;
}

interface RunTerminalCommandInput {
  command: string;
  cwd?: string;
  timeoutMs?: number;
}

class ListWorkspaceFilesTool implements vscode.LanguageModelTool<ListWorkspaceFilesInput> {
  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<ListWorkspaceFilesInput>,
    token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    const files = await vscode.workspace.findFiles(
      options.input.glob || '**/*',
      EXCLUDE_GLOB,
      Math.max(1, Math.min(500, options.input.maxResults ?? 100)),
      token,
    );

    const relativePaths = files.map((file) => vscode.workspace.asRelativePath(file, false));
    return toToolResult(relativePaths.length ? relativePaths.join('\n') : 'No files matched the request.');
  }
}

class SearchWorkspaceTool implements vscode.LanguageModelTool<SearchWorkspaceInput> {
  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<SearchWorkspaceInput>,
    token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    const settings = getSettings();
    const matches: string[] = [];
    const maxResults = Math.max(1, Math.min(200, options.input.maxResults ?? 50));

    const query = options.input.isRegExp
      ? new RegExp(options.input.query, 'i')
      : undefined;
    const files = await vscode.workspace.findFiles(
      options.input.include || '**/*',
      EXCLUDE_GLOB,
      200,
      token,
    );

    for (const file of files) {
      if (matches.length >= maxResults) {
        break;
      }

      const content = await tryReadWorkspaceText(file, settings.maxSearchFileBytes);
      if (!content) {
        continue;
      }

      const lines = content.split(/\r?\n/);
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        const matched = query ? query.test(line) : line.toLowerCase().includes(options.input.query.toLowerCase());
        if (!matched) {
          continue;
        }

        matches.push(`${vscode.workspace.asRelativePath(file, false)}:${index + 1}: ${line.trim()}`);
        if (matches.length >= maxResults) {
          break;
        }
      }
    }

    return toToolResult(matches.length ? matches.join('\n') : 'No matches found.');
  }
}

class ReadFileTool implements vscode.LanguageModelTool<ReadFileInput> {
  async invoke(options: vscode.LanguageModelToolInvocationOptions<ReadFileInput>): Promise<vscode.LanguageModelToolResult> {
    const settings = getSettings();
    const uri = await resolveWorkspaceUri(options.input.path);
    const content = await readWorkspaceText(uri, settings.maxReadFileBytes);
    const lines = content.split(/\r?\n/);
    const startLine = Math.max(1, options.input.startLine ?? 1);
    const endLine = Math.min(lines.length, options.input.endLine ?? lines.length);
    const excerpt = lines
      .slice(startLine - 1, endLine)
      .map((line, index) => `${String(startLine + index).padStart(4, ' ')} | ${line}`)
      .join('\n');

    return toToolResult(`${vscode.workspace.asRelativePath(uri, false)}\n${excerpt}`.trim());
  }
}

class WriteFileTool implements vscode.LanguageModelTool<WriteFileInput> {
  prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<WriteFileInput>): vscode.PreparedToolInvocation {
    return {
      invocationMessage: `Writing ${options.input.path}`,
      confirmationMessages: {
        title: `Allow ${APP_NAME} to write a file?`,
        message: `Create or overwrite ${options.input.path}?`,
      },
    };
  }

  async invoke(options: vscode.LanguageModelToolInvocationOptions<WriteFileInput>): Promise<vscode.LanguageModelToolResult> {
    assertTrustedWorkspace('write files');
    const uri = await resolveWorkspaceUri(options.input.path);
    await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(uri.fsPath)));
    await vscode.workspace.fs.writeFile(uri, textEncoder.encode(options.input.content));
    return toToolResult(`Wrote ${vscode.workspace.asRelativePath(uri, false)} (${options.input.content.length} characters).`);
  }
}

class ReplaceInFileTool implements vscode.LanguageModelTool<ReplaceInFileInput> {
  prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<ReplaceInFileInput>): vscode.PreparedToolInvocation {
    return {
      invocationMessage: `Editing ${options.input.path}`,
      confirmationMessages: {
        title: `Allow ${APP_NAME} to edit a file?`,
        message: `Replace text in ${options.input.path}?`,
      },
    };
  }

  async invoke(options: vscode.LanguageModelToolInvocationOptions<ReplaceInFileInput>): Promise<vscode.LanguageModelToolResult> {
    const settings = getSettings();
    assertTrustedWorkspace('edit files');
    const uri = await resolveWorkspaceUri(options.input.path);
    const current = await readWorkspaceText(uri, settings.maxReadFileBytes);
    const occurrences = current.split(options.input.oldText).length - 1;
    if (occurrences !== 1) {
      return toToolResult(`Replacement aborted. Expected exactly one match for oldText, found ${occurrences}.`);
    }

    const updated = current.replace(options.input.oldText, options.input.newText);
    await vscode.workspace.fs.writeFile(uri, textEncoder.encode(updated));
    return toToolResult(`Updated ${vscode.workspace.asRelativePath(uri, false)}.`);
  }
}

class RunTerminalCommandTool implements vscode.LanguageModelTool<RunTerminalCommandInput> {
  constructor(private readonly output: vscode.OutputChannel) {}

  prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<RunTerminalCommandInput>): vscode.PreparedToolInvocation {
    return {
      invocationMessage: `Running ${options.input.command}`,
      confirmationMessages: {
        title: `Allow ${APP_NAME} to run a shell command?`,
        message: `Run this command?\n\n${options.input.command}`,
      },
    };
  }

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<RunTerminalCommandInput>,
    token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    const settings = getSettings();
    assertTrustedWorkspace('run shell commands');
    if (!settings.allowCommandExecution) {
      throw new Error(`Shell execution is disabled. Enable forgeCode.allowCommandExecution to allow ${APP_NAME} terminal access.`);
    }

    const command = options.input.command.trim();
    if (!command) {
      throw new Error('Command cannot be empty.');
    }
    if (command.length > 2000 || CONTROL_CHARACTER_PATTERN.test(command)) {
      throw new Error('Command contains unsupported control characters or is too long.');
    }

    const cwd = options.input.cwd ? (await resolveWorkspaceUri(options.input.cwd)).fsPath : (await getWorkspaceRoot()).uri.fsPath;
    const timeoutMs = Math.max(1000, Math.min(300000, options.input.timeoutMs ?? 120000));
    const shell = process.platform === 'win32' ? (process.env.ComSpec ?? 'cmd.exe') : (process.env.SHELL ?? '/bin/sh');
    const shellArgs = process.platform === 'win32'
      ? ['/d', '/s', '/c', command]
      : ['-lc', command];

    const result = await new Promise<string>((resolve, reject) => {
      const child = spawn(shell, shellArgs, {
        cwd,
        env: buildCommandEnvironment(),
        windowsHide: true,
      });

      let stdout = '';
      let stderr = '';
      let completed = false;
      const timer = setTimeout(() => {
        if (!completed) {
          child.kill();
          reject(new Error(`Command timed out after ${timeoutMs}ms.`));
        }
      }, timeoutMs);

      const cancelDisposable = token.onCancellationRequested(() => {
        child.kill();
      });

      child.stdout.on('data', (chunk: Buffer | string) => {
        stdout += chunk.toString();
      });
      child.stderr.on('data', (chunk: Buffer | string) => {
        stderr += chunk.toString();
      });
      child.on('error', (error) => {
        clearTimeout(timer);
        cancelDisposable.dispose();
        reject(error);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        cancelDisposable.dispose();
        completed = true;
        const toolOutput = trimToMaxChars([
          `cwd: ${cwd}`,
          `exitCode: ${code ?? -1}`,
          stdout.trim() ? `stdout:\n${stdout.trim()}` : 'stdout: <empty>',
          stderr.trim() ? `stderr:\n${stderr.trim()}` : 'stderr: <empty>',
        ].join('\n\n'), settings.maxCommandOutputCharacters);
        resolve(toolOutput);
      });
    });

    this.output.appendLine(`${LOG_PREFIX} terminal command completed: ${command}`);
    return toToolResult(result);
  }
}

function toToolResult(text: string): vscode.LanguageModelToolResult {
  return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(text)]);
}

async function getWorkspaceRoot(): Promise<vscode.WorkspaceFolder> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    throw new Error(`Open a workspace folder before using ${APP_NAME} tools.`);
  }

  return folder;
}

async function resolveWorkspaceUri(inputPath: string): Promise<vscode.Uri> {
  const root = await getWorkspaceRoot();
  const normalized = inputPath.trim();
  const uri = path.isAbsolute(normalized)
    ? vscode.Uri.file(normalized)
    : vscode.Uri.file(path.resolve(root.uri.fsPath, normalized));

  if (!vscode.workspace.getWorkspaceFolder(uri)) {
    throw new Error(`Path must resolve inside the current workspace: ${inputPath}`);
  }

  await assertRealPathInsideWorkspace(root.uri.fsPath, uri.fsPath);
  return uri;
}

function assertTrustedWorkspace(action: string): void {
  if (!vscode.workspace.isTrusted) {
    throw new Error(`${APP_NAME} will not ${action} in an untrusted workspace.`);
  }
}

async function readWorkspaceText(uri: vscode.Uri, maxBytes: number): Promise<string> {
  const stat = await vscode.workspace.fs.stat(uri);
  if (stat.size > maxBytes) {
    throw new Error(`${vscode.workspace.asRelativePath(uri, false)} exceeds the read limit of ${maxBytes} bytes.`);
  }

  const bytes = await vscode.workspace.fs.readFile(uri);
  if (looksBinary(bytes)) {
    throw new Error(`${vscode.workspace.asRelativePath(uri, false)} appears to be binary data.`);
  }

  return textDecoder.decode(bytes);
}

async function tryReadWorkspaceText(uri: vscode.Uri, maxBytes: number): Promise<string | undefined> {
  try {
    return await readWorkspaceText(uri, maxBytes);
  } catch {
    return undefined;
  }
}

function looksBinary(bytes: Uint8Array): boolean {
  const sample = bytes.subarray(0, Math.min(bytes.length, 8192));
  for (const value of sample) {
    if (value === 0) {
      return true;
    }
  }

  return false;
}

function buildCommandEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of COMMAND_ENV_ALLOWLIST) {
    const value = process.env[key];
    if (value) {
      env[key] = value;
    }
  }

  return env;
}

async function assertRealPathInsideWorkspace(workspacePath: string, targetPath: string): Promise<void> {
  const workspaceRealPath = await realpath(workspacePath);
  const anchorPath = await findExistingPath(targetPath);
  const anchorRealPath = await realpath(anchorPath);

  if (!isInsidePath(workspaceRealPath, anchorRealPath)) {
    throw new Error('Resolved path escapes the current workspace through a symlink or junction.');
  }

  try {
    const targetStat = await lstat(targetPath);
    if (targetStat.isSymbolicLink()) {
      throw new Error('Refusing to follow symbolic links for workspace mutations.');
    }
  } catch (error) {
    if (!(error instanceof Error) || !/ENOENT/.test(error.message)) {
      throw error;
    }
  }
}

async function findExistingPath(inputPath: string): Promise<string> {
  let currentPath = inputPath;
  while (true) {
    try {
      await lstat(currentPath);
      return currentPath;
    } catch (error) {
      if (!(error instanceof Error) || !/ENOENT/.test(error.message)) {
        throw error;
      }
    }

    const parentPath = path.dirname(currentPath);
    if (parentPath === currentPath) {
      return currentPath;
    }
    currentPath = parentPath;
  }
}

function isInsidePath(rootPath: string, candidatePath: string): boolean {
  const relativePath = path.relative(rootPath, candidatePath);
  return relativePath === '' || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath));
}