const { expect } = require('chai');
const { generateKey, encrypt, decrypt } = require('../lib/crypto');

describe('lib/crypto.js (AES-256-GCM unit tests)', function () {
  this.timeout(10000);

  describe('generateKey', function () {
    it('returns a 32-byte Uint8Array', async function () {
      const key = await generateKey();
      expect(key).to.be.an.instanceOf(Uint8Array);
      expect(key.length).to.equal(32);
    });

    it('produces unique keys on successive calls', async function () {
      const a = await generateKey();
      const b = await generateKey();
      expect(Buffer.from(a).equals(Buffer.from(b))).to.equal(false);
    });
  });

  describe('encrypt + decrypt round-trip', function () {
    it('recovers the original plaintext', async function () {
      const key = await generateKey();
      const plaintext = new Uint8Array(Buffer.from('hello world'));
      const packed = await encrypt(plaintext, key);
      const recovered = await decrypt(packed, key);
      expect(Buffer.from(recovered).toString()).to.equal('hello world');
    });

    it('handles empty plaintext', async function () {
      const key = await generateKey();
      const plaintext = new Uint8Array(0);
      const packed = await encrypt(plaintext, key);
      const recovered = await decrypt(packed, key);
      expect(recovered.length).to.equal(0);
    });

    it('handles large plaintext (10 KB)', async function () {
      const key = await generateKey();
      const plaintext = new Uint8Array(10240);
      for (let i = 0; i < plaintext.length; i++) plaintext[i] = i % 256;
      const packed = await encrypt(plaintext, key);
      const recovered = await decrypt(packed, key);
      expect(Buffer.from(recovered).equals(Buffer.from(plaintext))).to.equal(true);
    });

    it('handles JSON-serialised object round-trip', async function () {
      const key = await generateKey();
      const obj = { facts: ['likes coffee', 'exam on Friday'], mood: 'stressed' };
      const plaintext = new Uint8Array(Buffer.from(JSON.stringify(obj)));
      const packed = await encrypt(plaintext, key);
      const recovered = await decrypt(packed, key);
      const parsed = JSON.parse(Buffer.from(recovered).toString());
      expect(parsed).to.deep.equal(obj);
    });
  });

  describe('encrypt output format', function () {
    it('produces output longer than plaintext (IV + auth tag overhead)', async function () {
      const key = await generateKey();
      const plaintext = new Uint8Array(Buffer.from('test'));
      const packed = await encrypt(plaintext, key);
      // 12-byte IV + ciphertext (same length as plaintext) + 16-byte auth tag = +28 bytes
      expect(packed.length).to.equal(plaintext.length + 12 + 16);
    });

    it('produces different ciphertext for the same plaintext (random IV)', async function () {
      const key = await generateKey();
      const plaintext = new Uint8Array(Buffer.from('deterministic?'));
      const a = await encrypt(plaintext, key);
      const b = await encrypt(plaintext, key);
      expect(Buffer.from(a).equals(Buffer.from(b))).to.equal(false);
    });
  });

  describe('decryption failures', function () {
    it('throws when decrypting with the wrong key', async function () {
      const rightKey = await generateKey();
      const wrongKey = await generateKey();
      const packed = await encrypt(new Uint8Array(Buffer.from('secret')), rightKey);
      let threw = false;
      try {
        await decrypt(packed, wrongKey);
      } catch {
        threw = true;
      }
      expect(threw, 'decrypt with wrong key should throw').to.equal(true);
    });

    it('throws when ciphertext is tampered with', async function () {
      const key = await generateKey();
      const packed = await encrypt(new Uint8Array(Buffer.from('original')), key);
      // Flip a byte in the ciphertext portion (after the 12-byte IV)
      const tampered = new Uint8Array(packed);
      tampered[14] ^= 0xff;
      let threw = false;
      try {
        await decrypt(tampered, key);
      } catch {
        threw = true;
      }
      expect(threw, 'decrypt of tampered ciphertext should throw').to.equal(true);
    });

    it('throws when the auth tag is corrupted', async function () {
      const key = await generateKey();
      const packed = await encrypt(new Uint8Array(Buffer.from('tagged')), key);
      const corrupted = new Uint8Array(packed);
      corrupted[corrupted.length - 1] ^= 0xff;
      let threw = false;
      try {
        await decrypt(corrupted, key);
      } catch {
        threw = true;
      }
      expect(threw, 'decrypt with corrupted auth tag should throw').to.equal(true);
    });

    it('throws when IV is corrupted', async function () {
      const key = await generateKey();
      const packed = await encrypt(new Uint8Array(Buffer.from('iv test')), key);
      const corrupted = new Uint8Array(packed);
      corrupted[0] ^= 0xff;
      let threw = false;
      try {
        await decrypt(corrupted, key);
      } catch {
        threw = true;
      }
      expect(threw, 'decrypt with corrupted IV should throw').to.equal(true);
    });
  });
});
