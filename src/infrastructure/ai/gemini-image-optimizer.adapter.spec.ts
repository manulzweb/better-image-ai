import { GeminiImageOptimizerAdapter } from './gemini-image-optimizer.adapter';
import { ConfigService } from '@nestjs/config';
import { EnvConfig } from '../../config/config.schema';
import { GeminiApiException } from '../../domain/exceptions/gemini-api.exception';
import { GeminiBadRequestException } from '../../domain/exceptions/gemini-bad-request.exception';
import { GeminiTimeoutException } from '../../domain/exceptions/gemini-timeout.exception';

// El módulo @google/genai se resuelve con un mock aislado; la factory no puede
// referenciar variables externas, así que el PNG de prueba va inline.
jest.mock('@google/genai', () => ({
  GoogleGenAI: jest.fn().mockImplementation(() => ({
    models: {
      generateContent: jest.fn().mockResolvedValue({
        candidates: [
          {
            content: {
              parts: [
                { text: 'ok' },
                {
                  inlineData: {
                    mimeType: 'image/png',
                    data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
                  },
                },
              ],
            },
          },
        ],
      }),
    },
  })),
}));

const INPUT = { buffer: Buffer.from('source-image'), mimeType: 'image/png' };

const httpError = (status: number, message: string): Error =>
  Object.assign(new Error(message), { status });

describe('GeminiImageOptimizerAdapter', () => {
  let adapter: GeminiImageOptimizerAdapter;
  let client: { models: { generateContent: jest.Mock } };

  const build = (overrides: Record<string, unknown> = {}): GeminiImageOptimizerAdapter => {
    const fakeConfig = {
      get: (key: string) => {
        const values: Record<string, unknown> = {
          GEMINI_API_KEY: 'test-key',
          GEMINI_MODEL: 'gemini-2.5-flash-image',
          GEMINI_TIMEOUT_MS: 5_000,
          GEMINI_MAX_RETRIES: 2,
          ...overrides,
        };
        return values[key];
      },
    };
    return new GeminiImageOptimizerAdapter(fakeConfig as unknown as ConfigService<EnvConfig, true>);
  };

  beforeEach(() => {
    adapter = build();
    client = (adapter as unknown as { client: { models: { generateContent: jest.Mock } } }).client;
    // Evita esperas reales de backoff en los tests.
    (adapter as unknown as { sleep: (ms: number) => Promise<void> }).sleep = () =>
      Promise.resolve();
  });

  it('expone el nombre de la estrategia', () => {
    expect(adapter.strategy).toBe('gemini');
  });

  it('devuelve el buffer de imagen decodificado desde base64', async () => {
    const result = await adapter.optimize(INPUT);

    expect(Buffer.isBuffer(result)).toBe(true);
    expect(result.length).toBeGreaterThan(0);
    expect(client.models.generateContent).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({
          responseModalities: ['IMAGE'],
          abortSignal: expect.any(AbortSignal),
        }),
      }),
    );
  });

  it('reintenta ante errores transitorios (429/503) y finalmente tiene éxito', async () => {
    client.models.generateContent
      .mockRejectedValueOnce(httpError(429, 'resource exhausted'))
      .mockRejectedValueOnce(httpError(503, 'overloaded'));

    const result = await adapter.optimize(INPUT);

    expect(Buffer.isBuffer(result)).toBe(true);
    // 1 intento + 1 fallo + 1 fallo + éxito = 3 llamadas
    expect(client.models.generateContent).toHaveBeenCalledTimes(3);
  });

  it('agota los reintentos ante 5xx persistente y envuelve en GeminiApiException', async () => {
    client.models.generateContent.mockRejectedValue(httpError(503, 'overloaded'));

    await expect(adapter.optimize(INPUT)).rejects.toBeInstanceOf(GeminiApiException);
    // 2 reintentos + intento inicial = 3 llamadas
    expect(client.models.generateContent).toHaveBeenCalledTimes(3);
  });

  it('no reintenta ante errores 4xx de Gemini (entrada inválida)', async () => {
    client.models.generateContent.mockRejectedValue(httpError(400, 'invalid image'));

    await expect(adapter.optimize(INPUT)).rejects.toBeInstanceOf(GeminiBadRequestException);
    expect(client.models.generateContent).toHaveBeenCalledTimes(1);
  });

  it('lanza GeminiTimeoutException si la llamada no responde a tiempo', async () => {
    const shortTimeout = build({ GEMINI_TIMEOUT_MS: 5 });
    (shortTimeout as unknown as { sleep: (ms: number) => Promise<void> }).sleep = () =>
      Promise.resolve();
    const shortClient = (
      shortTimeout as unknown as { client: { models: { generateContent: jest.Mock } } }
    ).client;
    // Simula el comportamiento real del SDK ante abort: rechaza la llamada.
    shortClient.models.generateContent.mockImplementation(
      ({ config }: { config?: { abortSignal?: AbortSignal } }) =>
        new Promise((_resolve, reject) => {
          config?.abortSignal?.addEventListener('abort', () =>
            reject(new Error('The operation was aborted')),
          );
        }),
    );

    await expect(shortTimeout.optimize(INPUT)).rejects.toBeInstanceOf(GeminiTimeoutException);
  });

  it('lanza GeminiApiException cuando la respuesta no contiene imagen', async () => {
    client.models.generateContent.mockResolvedValueOnce({
      candidates: [{ content: { parts: [{ text: 'only text' }] } }],
    });

    await expect(adapter.optimize(INPUT)).rejects.toThrow('Gemini API returned no image data');
    expect(client.models.generateContent).toHaveBeenCalledTimes(1);
  });
});
