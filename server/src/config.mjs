import {resolve} from 'node:path';
import {createDemoIdentities} from './auth.mjs';
import {DomainError} from './domain.mjs';

function integer(environment, name, fallback, {min, max}) {
  const raw = environment[name];
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new DomainError(500, 'INVALID_CONFIGURATION', `${name} must be an integer from ${min} to ${max}.`);
  }
  return value;
}

export function loadConfig(environment = process.env) {
  const identities = createDemoIdentities(environment);
  const tokens = identities.map(identity => identity.token);
  if (tokens.some(token => typeof token !== 'string' || token.length < 16)) {
    throw new DomainError(500, 'INVALID_CONFIGURATION', 'Demo identity tokens must each contain at least 16 characters.');
  }
  if (new Set(tokens).size !== tokens.length) {
    throw new DomainError(500, 'INVALID_CONFIGURATION', 'Demo identity tokens must be unique.');
  }
  const corsOrigins = new Set((environment.FIELDNOTE_CORS_ORIGINS ?? 'http://localhost:4200,http://127.0.0.1:4200,http://127.0.0.1:4173')
    .split(',').map(value => value.trim()).filter(Boolean));
  if (corsOrigins.has('*')) {
    throw new DomainError(500, 'INVALID_CONFIGURATION', 'FIELDNOTE_CORS_ORIGINS must be an explicit allowlist; wildcard origins are not accepted.');
  }
  return {
    host: environment.FIELDNOTE_HOST ?? '127.0.0.1',
    port: integer(environment, 'FIELDNOTE_PORT', 8787, {min: 0, max: 65535}),
    bodyLimitBytes: integer(environment, 'FIELDNOTE_BODY_LIMIT_BYTES', 1_048_576, {min: 1024, max: 10_485_760}),
    dataFile: resolve(environment.FIELDNOTE_DATA_FILE ?? './server/data/fieldnote.json'),
    corsOrigins,
    identities,
    buildVersion: environment.FIELDNOTE_BUILD_VERSION ?? 'development',
  };
}
