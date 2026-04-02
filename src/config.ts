import * as vscode from 'vscode';
import {
  DEFAULT_LOCAL_BASE_URL,
  EXTENSION_SECTION,
  LEGACY_EXTENSION_SECTION,
  SECRET_KEYS,
} from './util/constants';
import { ensureSecureBaseUrl, normalizeBaseUrl } from './provider/protocol';

export interface ForgeCodeSettings {
  apiKey: string;
  allowCommandExecution: boolean;
  allowRemoteEndpoints: boolean;
  baseUrl: string;
  defaultChatModel: string;
  defaultCompletionModel: string;
  discoveredModels: string[];
  maxCommandOutputCharacters: number;
  maxContextCharacters: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  maxReadFileBytes: number;
  maxSearchFileBytes: number;
  maxToolRounds: number;
  maxWorkspaceFiles: number;
  temperature: number;
  inlineCompletions: {
    enabled: boolean;
    maxPrefixChars: number;
    maxSuffixChars: number;
    minPromptCharacters: number;
  };
}

let extensionContext: vscode.ExtensionContext | undefined;
let cachedApiKey = '';

type StringConfigurationInspection = {
  globalValue?: string;
  workspaceValue?: string;
  workspaceFolderValue?: string;
} | undefined;

export async function initializeSettings(context: vscode.ExtensionContext): Promise<void> {
  extensionContext = context;
  await migrateApiKeyFromSettings();
  cachedApiKey = (await context.secrets.get(SECRET_KEYS.apiKey))?.trim() ?? '';
}

export function getSettings(): ForgeCodeSettings {
  const config = getPrimaryConfiguration();
  return {
    apiKey: cachedApiKey,
    allowCommandExecution: getSettingValue('allowCommandExecution', false),
    allowRemoteEndpoints: getSettingValue('allowRemoteEndpoints', false),
    baseUrl: ensureSecureBaseUrl(getSettingValue('baseUrl', DEFAULT_LOCAL_BASE_URL), getSettingValue('allowRemoteEndpoints', false)),
    defaultChatModel: getSettingValue('defaultChatModel', '').trim(),
    defaultCompletionModel: getSettingValue('defaultCompletionModel', '').trim(),
    discoveredModels: getSettingValue('discoveredModels', []),
    maxCommandOutputCharacters: getSettingValue('maxCommandOutputCharacters', 12000),
    maxContextCharacters: getSettingValue('maxContextCharacters', 18000),
    maxInputTokens: getSettingValue('maxInputTokens', 64000),
    maxOutputTokens: getSettingValue('maxOutputTokens', 8192),
    maxReadFileBytes: getSettingValue('maxReadFileBytes', 262144),
    maxSearchFileBytes: getSettingValue('maxSearchFileBytes', 131072),
    maxToolRounds: getSettingValue('maxToolRounds', 6),
    maxWorkspaceFiles: getSettingValue('maxWorkspaceFiles', 80),
    temperature: getSettingValue('temperature', 0.2),
    inlineCompletions: {
      enabled: getSettingValue('inlineCompletions.enabled', true),
      maxPrefixChars: getSettingValue('inlineCompletions.maxPrefixChars', 4000),
      maxSuffixChars: getSettingValue('inlineCompletions.maxSuffixChars', 1000),
      minPromptCharacters: getSettingValue('inlineCompletions.minPromptCharacters', 8),
    },
  };
}

export async function updateBaseUrl(baseUrl: string): Promise<void> {
  const settings = getSettings();
  await getPrimaryConfiguration().update(
    'baseUrl',
    ensureSecureBaseUrl(normalizeBaseUrl(baseUrl), settings.allowRemoteEndpoints),
    vscode.ConfigurationTarget.Global,
  );
}

export async function storeApiKey(apiKey: string): Promise<void> {
  if (!extensionContext) {
    throw new Error('ForgeCode settings are not initialized yet.');
  }

  cachedApiKey = apiKey.trim();
  if (cachedApiKey) {
    await extensionContext.secrets.store(SECRET_KEYS.apiKey, cachedApiKey);
    return;
  }

  await extensionContext.secrets.delete(SECRET_KEYS.apiKey);
}

function getPrimaryConfiguration(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration(EXTENSION_SECTION);
}

function getLegacyConfiguration(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration(LEGACY_EXTENSION_SECTION);
}

function getSettingValue<T>(key: string, defaultValue: T): T {
  const primary = getPrimaryConfiguration().get<T | undefined>(key);
  if (primary !== undefined) {
    return primary;
  }

  return getLegacyConfiguration().get<T>(key, defaultValue);
}

async function migrateApiKeyFromSettings(): Promise<void> {
  if (!extensionContext) {
    return;
  }

  const secretApiKey = (await extensionContext.secrets.get(SECRET_KEYS.apiKey))?.trim();
  if (secretApiKey) {
    return;
  }

  const primaryInspect = getPrimaryConfiguration().inspect<string>('apiKey');
  const legacyInspect = getLegacyConfiguration().inspect<string>('apiKey');
  const migratedValue = readConfiguredSecret(primaryInspect) ?? readConfiguredSecret(legacyInspect);

  if (migratedValue) {
    await extensionContext.secrets.store(SECRET_KEYS.apiKey, migratedValue);
  }

  await clearConfiguredSecret(getPrimaryConfiguration(), primaryInspect);
  await clearConfiguredSecret(getLegacyConfiguration(), legacyInspect);
}

function readConfiguredSecret(inspection: StringConfigurationInspection): string | undefined {
  const candidates = [
    inspection?.workspaceFolderValue,
    inspection?.workspaceValue,
    inspection?.globalValue,
  ];

  return candidates.find((value): value is string => typeof value === 'string' && value.trim().length > 0)?.trim();
}

async function clearConfiguredSecret(
  config: vscode.WorkspaceConfiguration,
  inspection: StringConfigurationInspection,
): Promise<void> {
  if (!inspection) {
    return;
  }

  if (inspection.globalValue !== undefined) {
    await config.update('apiKey', undefined, vscode.ConfigurationTarget.Global);
  }
  if (inspection.workspaceValue !== undefined) {
    await config.update('apiKey', undefined, vscode.ConfigurationTarget.Workspace);
  }
  if (inspection.workspaceFolderValue !== undefined) {
    await config.update('apiKey', undefined, vscode.ConfigurationTarget.WorkspaceFolder);
  }
}