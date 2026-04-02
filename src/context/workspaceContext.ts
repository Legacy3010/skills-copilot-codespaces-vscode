import * as vscode from 'vscode';
import { getSettings } from '../config';
import { trimToMaxChars } from '../provider/protocol';
import { LOG_PREFIX } from '../util/constants';

const EXCLUDE_GLOB = '**/{.git,node_modules,out,dist,__pycache__,.venv}/**';

export class WorkspaceContextService {
  constructor(private readonly output: vscode.OutputChannel) {}

  async buildSnapshot(token: vscode.CancellationToken): Promise<string> {
    const settings = getSettings();
    const lines: string[] = [];
    const folders = vscode.workspace.workspaceFolders ?? [];

    if (!folders.length) {
      return 'No workspace folder is currently open.';
    }

    lines.push('Workspace folders:');
    for (const folder of folders) {
      lines.push(`- ${folder.name}`);
    }

    const editor = vscode.window.activeTextEditor;
    if (editor) {
      lines.push('');
      lines.push(this.buildEditorSnapshot(editor));
    }

    const openEditors = vscode.workspace.textDocuments
      .filter((document) => !document.isClosed && document.uri.scheme === 'file')
      .map((document) => vscode.workspace.asRelativePath(document.uri, false));

    if (openEditors.length) {
      lines.push('');
      lines.push('Open text documents:');
      for (const openEditor of openEditors.slice(0, 20)) {
        lines.push(`- ${openEditor}`);
      }
    }

    try {
      const files = await vscode.workspace.findFiles('**/*', EXCLUDE_GLOB, settings.maxWorkspaceFiles, token);
      lines.push('');
      lines.push('Workspace file sample:');
      for (const file of files) {
        lines.push(`- ${vscode.workspace.asRelativePath(file, false)}`);
      }
    } catch (error) {
      this.output.appendLine(`${LOG_PREFIX} failed to build workspace snapshot: ${error instanceof Error ? error.message : String(error)}`);
    }

    return trimToMaxChars(lines.join('\n'), settings.maxContextCharacters);
  }

  getActiveSelectionContext(): string | undefined {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return undefined;
    }

    return this.buildEditorSnapshot(editor);
  }

  private buildEditorSnapshot(editor: vscode.TextEditor): string {
    const document = editor.document;
    const selection = editor.selection;
    const startLine = Math.max(0, selection.start.line - 20);
    const endLine = Math.min(document.lineCount - 1, selection.end.line + 20);
    const lines: string[] = [];

    lines.push(`Active file: ${vscode.workspace.asRelativePath(document.uri, false)} (${document.languageId})`);
    lines.push(`Selection: lines ${selection.start.line + 1}-${selection.end.line + 1}`);
    lines.push('Excerpt:');

    for (let index = startLine; index <= endLine; index += 1) {
      lines.push(`${String(index + 1).padStart(4, ' ')} | ${document.lineAt(index).text}`);
    }

    return lines.join('\n');
  }
}