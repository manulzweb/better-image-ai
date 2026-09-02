import { CryptoHashService } from './crypto-hash.service';

describe('CryptoHashService', () => {
  const service = new CryptoHashService();

  it('computa sha256 determinista', () => {
    const hash = service.compute(Buffer.from('hello'));
    expect(hash).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
  });

  it('produce el mismo hash para el mismo buffer', () => {
    expect(service.compute(Buffer.from('x'))).toBe(service.compute(Buffer.from('x')));
  });

  it('produce hashes distintos para buffers distintos', () => {
    expect(service.compute(Buffer.from('a'))).not.toBe(service.compute(Buffer.from('b')));
  });
});
