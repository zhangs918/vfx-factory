/** Content-addressed resource cache for v3 artifacts. Resources are fetched only when
 * a material/geometry binding references them; repeated effects share the same promise. */
export class V3ResourceCache {
  private readonly pending = new Map<string, Promise<ArrayBuffer>>();

  load(uri: string): Promise<ArrayBuffer> {
    const existing = this.pending.get(uri);
    if (existing) return existing;
    const request = fetch(uri).then(async (response) => {
      if (!response.ok) throw new Error(`Failed to load v3 resource ${uri} (${response.status})`);
      return response.arrayBuffer();
    }).catch((error) => {
      this.pending.delete(uri);
      throw error;
    });
    this.pending.set(uri, request);
    return request;
  }

  async loadJson<T = unknown>(uri: string): Promise<T> {
    const bytes = await this.load(uri);
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
  }

  async loadVerified(uri: string, expectedSha256: string): Promise<ArrayBuffer> {
    if (!/^[a-f0-9]{64}$/.test(expectedSha256)) {
      throw new Error(`Cannot verify v3 resource ${uri}: expected SHA-256 is missing or invalid`);
    }
    const bytes = await this.load(uri);
    if (!globalThis.crypto?.subtle) throw new Error(`Cannot verify v3 resource ${uri}: WebCrypto is unavailable`);
    const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
    const actual = [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('');
    if (actual !== expectedSha256) throw new Error(`v3 resource integrity mismatch for ${uri}: expected ${expectedSha256}, got ${actual}`);
    return bytes;
  }

  async loadJsonVerified<T = unknown>(uri: string, expectedSha256: string): Promise<T> {
    const bytes = await this.loadVerified(uri, expectedSha256);
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
  }

  async loadTextVerified(uri: string, expectedSha256: string): Promise<string> {
    const bytes = await this.loadVerified(uri, expectedSha256);
    return new TextDecoder().decode(bytes);
  }

  clear() { this.pending.clear(); }
}
