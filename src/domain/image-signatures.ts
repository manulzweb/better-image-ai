// Sniffing de magic bytes: no confiar en el Content-Type declarado por el cliente.
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const HEIC_BRANDS = ['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs'];
const HEIF_BRANDS = ['mif1', 'msf1'];

export function sniffImageMimeType(buffer: Buffer): string | null {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }
  if (buffer.length >= 8 && PNG_MAGIC.every((byte, index) => buffer[index] === byte)) {
    return 'image/png';
  }
  if (
    buffer.length >= 12 &&
    buffer.toString('ascii', 0, 4) === 'RIFF' &&
    buffer.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return 'image/webp';
  }
  return sniffIsoBmffBrand(buffer);
}

// ISO Base Media File Format (HEIC/HEIF): bytes 4..8 = 'ftyp', luego major brand.
function sniffIsoBmffBrand(buffer: Buffer): string | null {
  if (buffer.length < 12 || buffer.toString('ascii', 4, 8) !== 'ftyp') {
    return null;
  }
  const brand = buffer.toString('ascii', 8, 12);
  if (HEIC_BRANDS.includes(brand)) {
    return 'image/heic';
  }
  if (HEIF_BRANDS.includes(brand)) {
    return 'image/heif';
  }
  return null;
}
