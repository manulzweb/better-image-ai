import { BadRequestException, PayloadTooLargeException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ImageUploadValidationPipe } from './image-upload-validation.pipe';
import { UnsupportedMimeTypeException } from '../../domain/exceptions/unsupported-mime-type.exception';

const fakeConfig = {
  get: (key: string) => {
    const values: Record<string, number> = { MAX_FILE_SIZE_MB: 7 };
    return values[key];
  },
} as unknown as ConfigService;

const SIGNATURES: Record<string, Buffer> = {
  'image/jpeg': Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
  'image/png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  'image/webp': Buffer.from('RIFF0000WEBP', 'latin1'),
  'image/heic': Buffer.from('0000ftypheic00', 'latin1'),
  'image/heif': Buffer.from('0000ftypmif100', 'latin1'),
};

const fileOf = (overrides: Partial<Express.Multer.File>): Express.Multer.File =>
  ({
    fieldname: 'file',
    originalname: 'photo.png',
    mimetype: 'image/png',
    size: 1024,
    buffer: SIGNATURES['image/png'],
    ...overrides,
  }) as Express.Multer.File;

describe('ImageUploadValidationPipe', () => {
  let pipe: ImageUploadValidationPipe;

  beforeEach(() => {
    pipe = new ImageUploadValidationPipe(fakeConfig as any);
  });

  it('pasa un PNG válido', () => {
    const file = fileOf({});
    expect(pipe.transform(file)).toBe(file);
  });

  it('rechaza ausencia de archivo (400)', () => {
    expect(() => pipe.transform(undefined)).toThrow(BadRequestException);
  });

  it('rechaza archivo vacío (400)', () => {
    expect(() => pipe.transform(fileOf({ size: 0 }))).toThrow(BadRequestException);
  });

  it('rechaza MIME no soportado (400 + código UNSUPPORTED_MIME_TYPE)', () => {
    expect(() => pipe.transform(fileOf({ mimetype: 'application/pdf' }))).toThrow(
      UnsupportedMimeTypeException,
    );
  });

  it('rechaza un binario sin firma de imagen aunque el Content-Type diga PNG', () => {
    const file = fileOf({ buffer: Buffer.from('not really a png'), mimetype: 'image/png' });
    expect(() => pipe.transform(file)).toThrow(UnsupportedMimeTypeException);
  });

  it('rechaza si la firma no encaja con el MIME declarado', () => {
    const file = fileOf({ buffer: SIGNATURES['image/jpeg'], mimetype: 'image/png' });
    expect(() => pipe.transform(file)).toThrow(UnsupportedMimeTypeException);
  });

  it('rechaza tamaño superior al límite (413)', () => {
    const overLimit = fileOf({ size: 8 * 1024 * 1024 });
    expect(() => pipe.transform(overLimit)).toThrow(PayloadTooLargeException);
  });

  it.each(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'])(
    'acepta %s con su firma correspondiente',
    (mimetype) => {
      expect(pipe.transform(fileOf({ mimetype, buffer: SIGNATURES[mimetype] })).mimetype).toBe(
        mimetype,
      );
    },
  );
});
