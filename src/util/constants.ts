export const APP_NAME = 'ForgeCode';
export const APP_SLUG = 'forgecode';
export const LOG_PREFIX = `[${APP_SLUG}]`;
export const DEFAULT_LOCAL_BASE_URL = 'http://127.0.0.1:1234/v1';
export const EXTENSION_SECTION = 'forgeCode';
export const LEGACY_EXTENSION_SECTION = 'localAICoder';
export const MODEL_VENDOR = 'forgecode-agent';
export const CHAT_PARTICIPANT_ID = 'forgecode-agent.agent';

export const SECRET_KEYS = {
  apiKey: 'forgecode.apiKey',
} as const;

export const COMMANDS = {
  refreshModels: 'forgeCode.refreshModels',
  configureEndpoint: 'forgeCode.configureEndpoint',
  configureApiKey: 'forgeCode.configureApiKey',
  explainSelection: 'forgeCode.explainSelection',
} as const;

export const TOOL_NAMES = {
  listWorkspaceFiles: 'forgecode-agent-list-workspace-files',
  searchWorkspace: 'forgecode-agent-search-workspace',
  readFile: 'forgecode-agent-read-file',
  writeFile: 'forgecode-agent-write-file',
  replaceInFile: 'forgecode-agent-replace-in-file',
  runTerminalCommand: 'forgecode-agent-run-terminal-command',
} as const;

export const TOOL_TAGS = {
  root: 'forgecode-agent',
  read: 'read',
  write: 'write',
  exec: 'exec',
} as const;