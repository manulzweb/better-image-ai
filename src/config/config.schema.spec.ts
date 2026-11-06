import { validateEnv } from './config.schema';

const base = { GEMINI_API_KEY: 'test', API_KEYS: 'dev-key' };
it('rejects malformed or duplicate client credentials', () => {
  expect(() => validateEnv({ ...base, CLIENTS_JSON: '{' })).toThrow('CLIENTS_JSON');
  const client = { id: 'shop', keyHashes: ['a'.repeat(64)], profiles: {} };
  expect(() => validateEnv({ ...base, CLIENTS_JSON: JSON.stringify([client, client]) })).toThrow(
    'Duplicate',
  );
});
it('requires hashed client keys and bounded proxy trust in production', () => {
  expect(() => validateEnv({ ...base, NODE_ENV: 'production' })).toThrow('Production requires');
  const production = {
    GEMINI_API_KEY: 'test',
    NODE_ENV: 'production',
    CLIENTS_JSON: JSON.stringify([{ id: 'shop', keyHashes: ['a'.repeat(64)], profiles: {} }]),
  };
  expect(validateEnv(production).API_KEYS).toEqual([]);
  expect(() => validateEnv({ ...production, TRUST_PROXY: 'true' })).toThrow('proxy hop');
});
it('bounds upload size, retries and batch size', () => {
  for (const override of [
    { MAX_FILE_SIZE_MB: 8 },
    { GEMINI_MAX_RETRIES: 6 },
    { MAX_BATCH_FILES: 21 },
  ]) {
    expect(() => validateEnv({ ...base, ...override })).toThrow();
  }
});
it('requires explicit merchant configuration and disables live payments by default', () => {
  expect(validateEnv(base).MP_LIVE_MODE).toBe(false);
  expect(() => validateEnv({ ...base, MP_ACCESS_TOKEN: 'token' })).toThrow('Mercado Pago requires');
  expect(() => validateEnv({ ...base, PUBLIC_BASE_URL: 'http://api.example.com' })).toThrow(
    'HTTPS',
  );
  expect(() =>
    validateEnv({ ...base, PUBLIC_BASE_URL: 'https://user:password@api.example.com' }),
  ).toThrow('HTTPS');
});
