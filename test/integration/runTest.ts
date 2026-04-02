import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { runTests } from '@vscode/test-electron';

async function main(): Promise<void> {
  const extensionDevelopmentPath = path.resolve(__dirname, '../..', '..');
  const extensionTestsPath = path.resolve(__dirname, './suite/index');
  const workspacePath = await createFixtureWorkspace();

  try {
    await runTests({
      extensionDevelopmentPath,
      extensionTestsPath,
      launchArgs: [workspacePath],
    });
  } catch (error) {
    console.error('Failed to run extension-host integration tests.');
    throw error;
  }
}

async function createFixtureWorkspace(): Promise<string> {
  const workspacePath = await mkdtemp(path.join(os.tmpdir(), 'forgecode-integration-'));
  await mkdir(path.join(workspacePath, 'src'), { recursive: true });
  await mkdir(path.join(workspacePath, '.vscode'), { recursive: true });

  await writeFile(
    path.join(workspacePath, 'README.md'),
    '# Fixture Workspace\n\nForgeCode integration test workspace.\n',
    'utf8',
  );
  await writeFile(
    path.join(workspacePath, 'src', 'sample.ts'),
    [
      'export function greet(name: string): string {',
      "  return `hello ${name}`;",
      '}',
      '',
    ].join('\n'),
    'utf8',
  );

  return workspacePath;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});