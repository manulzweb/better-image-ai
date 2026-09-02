import { sniffImageMimeType } from './image-signatures';

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const bufferOf = (prefix: string): Buffer => Buffer.from(prefix, 'latin1');

describe('sniffImageMimeType', () => {
  it('detecta JPEG (FF D8 FF)', () => {
    expect(sniffImageMimeType(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]))).toBe('image/jpeg');
  });

  it('detecta PNG por su magic de 8 bytes', () => {
    expect(sniffImageMimeType(PNG_MAGIC)).toBe('image/png');
  });

  it('detecta WebP (RIFF + WEBP)', () => {
    const buffer = bufferOf('RIFF0000WEBP');
    expect(sniffImageMimeType(buffer)).toBe('image/webp');
  });

  it.each([
    ['heic', 'image/heic'],
    ['heix', 'image/heic'],
    ['hevc', 'image/heic'],
    ['mif1', 'image/heif'],
    ['msf1', 'image/heif'],
  ])('detecta ISO-BMFF con brand %s como %s', (brand, expected) => {
    // bytes 4-8 = 'ftyp', bytes 8-12 = brand
    const buffer = Buffer.concat([
      Buffer.from([0x00, 0x00, 0x00, 0x18]),
      Buffer.from('ftyp' + brand, 'ascii'),
      Buffer.from('00', 'ascii'),
    ]);
    expect(sniffImageMimeType(buffer)).toBe(expected);
  });

  it('devuelve null para un binario sin firma reconocida', () => {
    expect(sniffImageMimeType(Buffer.from('just some text'))).toBeNull();
  });

  it('devuelve null para buffers cortos', () => {
    expect(sniffImageMimeType(Buffer.from([0x89]))).toBeNull();
  });
});
