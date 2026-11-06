import { Semaphore } from '../../application/services/semaphore';
import { createHash } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GoogleGenAI, GenerateContentResponse } from '@google/genai';
import { ImageOptimizerPort, OptimizeInput } from '../../application/ports/image-optimizer.port';
import { EnvConfig } from '../../config/config.schema';
import { GeminiApiException } from '../../domain/exceptions/gemini-api.exception';
import { GeminiBadRequestException } from '../../domain/exceptions/gemini-bad-request.exception';
import { GeminiTimeoutException } from '../../domain/exceptions/gemini-timeout.exception';

// Prompt restrictivo: solo re-posicionar el producto; fondo y producto intactos.
const CENTER_PRODUCT_PROMPT = [
  'Center the product within the frame.',
  'Maintain the original background, product colors and shape untouched.',
  'Only adjust the product position.',
  'Output a square image preserving the original resolution.',
].join(' ');

@Injectable()
export class GeminiImageOptimizerAdapter implements ImageOptimizerPort {
  readonly strategy = 'gemini';
  readonly cacheVersion: string;
  private readonly semaphore: Semaphore;
  private readonly logger = new Logger(GeminiImageOptimizerAdapter.name);
  private readonly client: GoogleGenAI;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;

  constructor(private readonly config: ConfigService<EnvConfig, true>) {
    this.client = new GoogleGenAI({
      apiKey: config.get('GEMINI_API_KEY', { infer: true }),
    });
    this.semaphore = new Semaphore(config.get('GEMINI_CONCURRENCY', { infer: true }) ?? 2);
    this.model = config.get('GEMINI_MODEL', { infer: true });
    this.timeoutMs = config.get('GEMINI_TIMEOUT_MS', { infer: true });
    this.cacheVersion = createHash('sha256')
      .update(this.model + CENTER_PRODUCT_PROMPT)
      .digest('hex');
    this.maxRetries = config.get('GEMINI_MAX_RETRIES', { infer: true });
  }

  async optimize(input: OptimizeInput): Promise<Buffer> {
    return this.semaphore.run(() => this.optimizeWithRetries(input));
  }

  private async optimizeWithRetries(input: OptimizeInput): Promise<Buffer> {
    // +1 porque maxRetries son reintentos adicionales al intento inicial.
    const totalAttempts = this.maxRetries + 1;
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.request(input);
      } catch (error) {
        // Errores del dominio ya clasificados como no-reintentables (4xx, sin imagen).
        if (error instanceof GeminiApiException || error instanceof GeminiBadRequestException) {
          throw error;
        }
        const lastAttempt = attempt >= totalAttempts;
        // Si el último intento agotado fue timeout, se devuelve 504, no 502.
        if (lastAttempt && error instanceof GeminiTimeoutException) {
          throw error;
        }
        if (!this.isTransient(error) || lastAttempt) {
          throw new GeminiApiException(
            `Gemini API request failed (attempt ${attempt}/${totalAttempts}): ${this.messageOf(error)}`,
          );
        }
        const delayMs = this.backoffMs(attempt);
        this.logger.warn(
          `Gemini call failed (attempt ${attempt}/${totalAttempts}), retrying in ${delayMs}ms: ${this.messageOf(error)}`,
        );
        await this.sleep(delayMs);
      }
    }
  }

  private async request(input: OptimizeInput): Promise<Buffer> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: GenerateContentResponse;
    try {
      response = await this.client.models.generateContent({
        model: this.model,
        contents: [
          { inlineData: { mimeType: input.mimeType, data: input.buffer.toString('base64') } },
          {
            text: input.prompt
              ? [
                  'Edit this ecommerce product photograph. Preserve product identity, shape, colors, labels and logos.',
                  'Apply these presentation instructions:',
                  input.prompt,
                ].join(' ')
              : CENTER_PRODUCT_PROMPT,
          },
        ],
        config: { responseModalities: ['IMAGE'], abortSignal: controller.signal },
      });
    } catch (error) {
      if (controller.signal.aborted) {
        throw new GeminiTimeoutException(this.timeoutMs);
      }
      // 4xx distintos de 429: culpa de la entrada, no reintentable.
      const status = this.statusOf(error);
      if (status !== null && status >= 400 && status < 500 && status !== 429) {
        if (status === 400 || status === 422) {
          throw new GeminiBadRequestException(
            'Provider rejected the image or editing instructions',
          );
        }
        throw new GeminiApiException('Image provider configuration or availability error');
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }

    const parts = response.candidates?.[0]?.content?.parts ?? [];
    const imagePart = parts.find((part) => part.inlineData?.data);
    if (!imagePart?.inlineData?.data) {
      throw new GeminiApiException('Gemini API returned no image data');
    }
    return Buffer.from(imagePart.inlineData.data, 'base64');
  }

  // Reintentable: timeout, 429, 5xx o error de red (sin status HTTP).
  private isTransient(error: unknown): boolean {
    if (error instanceof GeminiTimeoutException) {
      return true;
    }
    const status = this.statusOf(error);
    return status === null || status === 429 || status >= 500;
  }

  private statusOf(error: unknown): number | null {
    if (error && typeof error === 'object' && 'status' in error) {
      const status = (error as { status: unknown }).status;
      return typeof status === 'number' ? status : null;
    }
    return null;
  }

  private messageOf(error: unknown): string {
    return error instanceof Error ? error.message : 'unknown error';
  }

  private backoffMs(attempt: number): number {
    return Math.floor(Math.min(500 * 2 ** (attempt - 1), 5_000) * (0.5 + Math.random() * 0.5));
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
