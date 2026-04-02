import * as path from 'node:path';
import Mocha from 'mocha';

export async function run(): Promise<void> {
  const mocha = new Mocha({
    color: true,
    timeout: 60000,
    ui: 'tdd',
  });

  mocha.addFile(path.resolve(__dirname, './extension.integration.js'));

  await new Promise<void>((resolve, reject) => {
    mocha.run((failures) => {
      if (failures > 0) {
        reject(new Error(`${failures} integration test(s) failed.`));
        return;
      }

      resolve();
    });
  });
}