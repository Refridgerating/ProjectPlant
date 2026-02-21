const PUBLIC_KEY_BYTES = 32;
const RANDOM_BYTES = 16;

function getCrypto(): Crypto {
  const cryptoApi = globalThis.crypto;
  if (!cryptoApi?.subtle) {
    throw new Error("Secure crypto API unavailable in this runtime");
  }
  return cryptoApi;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) {
    diff |= a[index] ^ b[index];
  }
  return diff === 0;
}

function xorInto(target: Uint8Array, mask: Uint8Array): void {
  const length = Math.min(target.length, mask.length);
  for (let index = 0; index < length; index += 1) {
    target[index] ^= mask[index];
  }
}

function incrementCounter(counter: Uint8Array): void {
  for (let index = counter.length - 1; index >= 0; index -= 1) {
    counter[index] = (counter[index] + 1) & 0xff;
    if (counter[index] !== 0) {
      break;
    }
  }
}

class AesCtrStream {
  private readonly key: CryptoKey;
  private readonly counter: Uint8Array;
  private readonly streamBlock: Uint8Array;
  private offset = 0;

  private constructor(key: CryptoKey, counter: Uint8Array) {
    this.key = key;
    this.counter = counter;
    this.streamBlock = new Uint8Array(16);
  }

  static async create(keyBytes: Uint8Array, initialCounter: Uint8Array): Promise<AesCtrStream> {
    if (keyBytes.length !== 32) {
      throw new Error("Security1 expects 32-byte AES key");
    }
    if (initialCounter.length !== RANDOM_BYTES) {
      throw new Error("Security1 expects 16-byte random counter");
    }
    const cryptoApi = getCrypto();
    const key = await cryptoApi.subtle.importKey(
      "raw",
      keyBytes,
      { name: "AES-CTR" },
      false,
      ["encrypt"]
    );
    return new AesCtrStream(key, initialCounter.slice());
  }

  async xcrypt(input: Uint8Array): Promise<Uint8Array> {
    if (input.length === 0) {
      return new Uint8Array();
    }
    const out = new Uint8Array(input.length);
    for (let index = 0; index < input.length; index += 1) {
      if (this.offset === 0) {
        await this.refillBlock();
      }
      out[index] = input[index] ^ this.streamBlock[this.offset];
      this.offset = (this.offset + 1) & 0x0f;
    }
    return out;
  }

  private async refillBlock(): Promise<void> {
    const cryptoApi = getCrypto();
    const encrypted = await cryptoApi.subtle.encrypt(
      {
        name: "AES-CTR",
        counter: this.counter,
        length: 128,
      },
      this.key,
      new Uint8Array(16)
    );
    this.streamBlock.set(new Uint8Array(encrypted));
    incrementCounter(this.counter);
  }
}

export class Security1Session {
  readonly clientPublicKey: Uint8Array;
  private readonly clientPrivateKey: CryptoKey;
  private popValue: string;
  private devicePublicKey: Uint8Array | null = null;
  private stream: AesCtrStream | null = null;

  private constructor(clientPrivateKey: CryptoKey, clientPublicKey: Uint8Array, popValue: string) {
    this.clientPrivateKey = clientPrivateKey;
    this.clientPublicKey = clientPublicKey;
    this.popValue = popValue;
  }

  static async create(popValue: string): Promise<Security1Session> {
    const cryptoApi = getCrypto();
    let keyPair: CryptoKeyPair;
    try {
      keyPair = (await cryptoApi.subtle.generateKey(
        { name: "X25519" },
        true,
        ["deriveBits"]
      )) as CryptoKeyPair;
    } catch (error) {
      throw new Error(
        `X25519 is unavailable in this runtime: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }

    const publicKeyRaw = new Uint8Array(await cryptoApi.subtle.exportKey("raw", keyPair.publicKey));
    if (publicKeyRaw.length !== PUBLIC_KEY_BYTES) {
      throw new Error("Unexpected X25519 public key length");
    }
    return new Security1Session(keyPair.privateKey, publicKeyRaw, popValue);
  }

  setPop(popValue: string): void {
    this.popValue = popValue;
  }

  async initialise(devicePublicKey: Uint8Array, deviceRandom: Uint8Array): Promise<void> {
    if (devicePublicKey.length !== PUBLIC_KEY_BYTES) {
      throw new Error("Invalid device public key length");
    }
    if (deviceRandom.length !== RANDOM_BYTES) {
      throw new Error("Invalid device random length");
    }

    const cryptoApi = getCrypto();
    const importedDevicePublic = await cryptoApi.subtle.importKey(
      "raw",
      devicePublicKey,
      { name: "X25519" },
      false,
      []
    );
    const sharedBits = await cryptoApi.subtle.deriveBits(
      { name: "X25519", public: importedDevicePublic },
      this.clientPrivateKey,
      256
    );
    const sharedKey = new Uint8Array(sharedBits);

    const trimmedPop = this.popValue.trim();
    if (trimmedPop.length > 0) {
      const digest = new Uint8Array(
        await cryptoApi.subtle.digest("SHA-256", new TextEncoder().encode(trimmedPop))
      );
      xorInto(sharedKey, digest);
    }

    this.devicePublicKey = devicePublicKey.slice();
    this.stream = await AesCtrStream.create(sharedKey, deviceRandom);
  }

  async createClientVerifyData(): Promise<Uint8Array> {
    if (!this.stream || !this.devicePublicKey) {
      throw new Error("Security1 stream is not initialised");
    }
    return this.stream.xcrypt(this.devicePublicKey);
  }

  async verifyDevice(deviceVerifyData: Uint8Array): Promise<void> {
    if (!this.stream) {
      throw new Error("Security1 stream is not initialised");
    }
    const decrypted = await this.stream.xcrypt(deviceVerifyData);
    if (!bytesEqual(decrypted, this.clientPublicKey)) {
      throw new Error("Device proof verification failed");
    }
  }

  async encrypt(data: Uint8Array): Promise<Uint8Array> {
    if (!this.stream) {
      throw new Error("Secure session not established");
    }
    return this.stream.xcrypt(data);
  }

  async decrypt(data: Uint8Array): Promise<Uint8Array> {
    if (!this.stream) {
      throw new Error("Secure session not established");
    }
    return this.stream.xcrypt(data);
  }
}
