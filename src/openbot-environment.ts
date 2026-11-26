import type { Blueprint } from './types.js';

type Environment = Record<string, string | undefined>;

/** Validate native settings without logging, returning or resolving secret values. */
export function validateOpenBotEnvironment(env: Environment, blueprint: Blueprint): string[] {
  const errors: string[] = [];
  const value = (name: string) => env[name]?.trim() ?? '';
  const required = (name: string) => {
    if (!value(name)) errors.push(`${name} is required in the OpenBot environment`);
  };
  const url = (name: string, protocols: string[]) => {
    required(name);
    if (!value(name)) return;
    try {
      if (!protocols.includes(new URL(value(name)).protocol)) throw new Error();
    } catch { errors.push(`${name} must use ${protocols.join(' or ')}`); }
  };
  for (const name of ['DATABASE_URL', 'POSTGRES_PASSWORD', 'BOT_MODEL', 'KEY_ENCRYPTION_KEY',
    'COMPUTER_TOKEN', 'SUPERVISOR_TOKEN', 'AGENT_TOOL_TOKEN', 'WORKER_SHARED_SECRET']) required(name);

  const provider = value('BOT_PROVIDER') || 'openai';
  if (provider !== 'openai' && provider !== 'anthropic') {
    errors.push('BOT_PROVIDER must be openai or anthropic for the pinned OpenBot tenant loader');
  } else required(provider === 'openai' ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY');

  url('INTELLIGENCE_API_URL', ['http:', 'https:']);
  url('INTELLIGENCE_GATEWAY_WS_URL', ['ws:', 'wss:']);
  if (!value('CPK_INTELLIGENCE_API_KEY') && !value('INTELLIGENCE_API_KEY')) {
    errors.push('CPK_INTELLIGENCE_API_KEY or INTELLIGENCE_API_KEY is required');
  }
  for (const name of ['OPENAI_BASE_URL', 'ANTHROPIC_BASE_URL']) {
    if (value(name)) url(name, ['http:', 'https:']);
  }
  if (value('MANAGED_AGENT_AG_UI_URL')) {
    url('MANAGED_AGENT_AG_UI_URL', ['http:', 'https:']);
    required('MANAGED_AGENT_TOKEN');
    if (value('MANAGED_AGENT_TOKEN') && value('MANAGED_AGENT_TOKEN').length < 32) {
      errors.push('MANAGED_AGENT_TOKEN must contain at least 32 characters');
    }
  }

  if (value('KEY_ENCRYPTION_KEY')) {
    const encoded = value('KEY_ENCRYPTION_KEY');
    const decoded = Buffer.from(encoded, 'base64');
    if (decoded.length !== 32 || decoded.toString('base64') !== encoded || decoded.every(byte => byte === 0)) {
      errors.push('KEY_ENCRYPTION_KEY must be a non-example, base64-encoded 32-byte key');
    }
  }
  const tokenNames = ['COMPUTER_TOKEN', 'SUPERVISOR_TOKEN', 'AGENT_TOOL_TOKEN', 'WORKER_SHARED_SECRET'];
  for (const name of tokenNames) {
    if (value(name) && value(name).length < 32) errors.push(`${name} must contain at least 32 characters`);
  }
  const tokens = tokenNames.map(value).filter(Boolean);
  if (new Set(tokens).size !== tokens.length) errors.push('Internal service tokens must have distinct values');

  if (value('DATABASE_URL')) {
    try {
      const database = new URL(value('DATABASE_URL'));
      const user = value('POSTGRES_USER') || 'openbot';
      const name = value('POSTGRES_DB') || 'openbot';
      if (!['postgres:', 'postgresql:'].includes(database.protocol)
        || database.hostname !== 'postgres' || (database.port && database.port !== '5432')
        || decodeURIComponent(database.username) !== user
        || decodeURIComponent(database.password) !== value('POSTGRES_PASSWORD')
        || decodeURIComponent(database.pathname.slice(1)) !== name) {
        errors.push('DATABASE_URL must target postgres:5432 and match POSTGRES_USER, POSTGRES_DB and POSTGRES_PASSWORD');
      }
    } catch { errors.push('DATABASE_URL must be a valid PostgreSQL URL'); }
  }

  if (!['true', 'false'].includes(value('OPENBOT_SINGLE_USER'))) {
    errors.push('Set OPENBOT_SINGLE_USER explicitly to true or false');
  } else if (value('OPENBOT_SINGLE_USER') === 'false') {
    for (const name of ['BETTER_AUTH_SECRET', 'INITIAL_ADMIN_EMAILS', 'TRUSTED_ORIGINS']) required(name);
    url('BETTER_AUTH_URL', ['http:', 'https:']);
    if (value('BETTER_AUTH_SECRET') && value('BETTER_AUTH_SECRET').length < 32) {
      errors.push('BETTER_AUTH_SECRET must contain at least 32 characters');
    }
    const identityConfigured = ['GOOGLE', 'MICROSOFT', 'OKTA'].some(provider =>
      value(`${provider}_OAUTH_CLIENT_ID`) && value(`${provider}_OAUTH_CLIENT_SECRET`)
      && (provider !== 'OKTA' || value('OKTA_OAUTH_ISSUER')));
    if (!identityConfigured) errors.push('Configure a native Google, Microsoft or Okta sign-in provider');
  }
  const browser = value('COMPUTER_BROWSER_MODE') || 'headed';
  if (!['headed', 'headless'].includes(browser)) errors.push('COMPUTER_BROWSER_MODE must be headed or headless');

  for (const agent of blueprint.agents) {
    if (agent.runtime?.kind === 'local') {
      errors.push(`${agent.id}: deploy the local bot behind AG-UI and declare a remote runtime before starting OpenBot`);
    } else if (agent.runtime?.kind === 'remote') {
      url(agent.runtime.endpointEnv, ['http:', 'https:']);
    }
  }
  return errors;
}
