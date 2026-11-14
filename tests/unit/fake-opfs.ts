// In-memory stand-in for the parts of OPFS the storage tests use, so the storage
// kernels and worker can run in Node. It mimics the rules that matter for cleanup:
// one open sync handle per file, and a locked file cannot be removed.

export interface FileFaults {
  /** Pretend to write (report success) without storing anything. `nth` counts writes to this file from 0. */
  dropWrite?: (at: number, nth: number) => boolean;
  /** Write everything but report one byte fewer (every write, or the writes `nth` selects). */
  shortWrite?: boolean | ((nth: number) => boolean);
  /** Report one byte fewer than were read. */
  shortRead?: boolean;
  /** Serve reads from `at + readShift` instead of `at`. */
  readShift?: number;
  /** Throw this from every write (e.g. a QuotaExceededError). */
  throwOnWrite?: Error;
}

function dom(name: string, message = name): DOMException {
  return new DOMException(message, name);
}

export class FakeSyncHandle {
  private buf = new Uint8Array(0);
  private size = 0;
  private writes = 0;
  closed = false;
  /** Offsets of every read, in order. */
  readonly readAt: number[] = [];

  constructor(
    private readonly file: FakeFile,
    private readonly faults: FileFaults,
  ) {}

  /** The file's current bytes (a view; do not keep it across writes). */
  bytes(): Uint8Array {
    return this.buf.subarray(0, this.size);
  }

  private grow(n: number): void {
    if (n <= this.buf.length) return;
    const next = new Uint8Array(Math.max(n, this.buf.length * 2));
    next.set(this.buf.subarray(0, this.size));
    this.buf = next;
  }

  write(data: ArrayBufferView, opts?: { at?: number }): number {
    const at = opts?.at ?? 0;
    const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    if (this.faults.throwOnWrite) throw this.faults.throwOnWrite;
    const nth = this.writes++;
    if (!this.faults.dropWrite?.(at, nth)) {
      this.grow(at + bytes.length);
      this.buf.set(bytes, at);
      this.size = Math.max(this.size, at + bytes.length);
    }
    const sw = this.faults.shortWrite;
    return (typeof sw === 'function' ? sw(nth) : sw) ? bytes.length - 1 : bytes.length;
  }

  read(data: ArrayBufferView, opts?: { at?: number }): number {
    const at = opts?.at ?? 0;
    this.readAt.push(at);
    const out = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    const from = at + (this.faults.readShift ?? 0);
    const n = Math.max(0, Math.min(out.length, this.size - from));
    out.set(this.buf.subarray(from, from + n));
    return this.faults.shortRead ? Math.max(0, n - 1) : n;
  }

  truncate(n: number): void {
    this.grow(n);
    if (n > this.size) this.buf.fill(0, this.size, n);
    this.size = n;
  }

  flush(): void {}

  getSize(): number {
    return this.size;
  }

  close(): void {
    this.closed = true;
    this.file.handle = undefined;
  }
}

class FakeFile {
  readonly kind = 'file';
  /** The open sync handle, while there is one (the file is then locked). */
  handle: FakeSyncHandle | undefined;
  /** Kept after close so tests can inspect the final bytes. */
  last: FakeSyncHandle | undefined;

  constructor(
    readonly name: string,
    private readonly fs: FakeFs,
  ) {}

  async createSyncAccessHandle(): Promise<FakeSyncHandle> {
    if (this.handle) throw dom('NoModificationAllowedError', 'file is locked');
    // The data survives close/reopen of a file in real OPFS; keep the buffer by reusing the last handle's bytes.
    const h = new FakeSyncHandle(this, this.fs.faults[this.name] ?? {});
    if (this.last) {
      h.write(this.last.bytes(), { at: 0 });
    }
    this.handle = h;
    this.last = h;
    return h;
  }

  get locked(): boolean {
    return this.handle !== undefined;
  }
}

export class FakeDir {
  readonly kind = 'directory';
  readonly children = new Map<string, FakeFile | FakeDir>();

  constructor(
    readonly name: string,
    private readonly fs: FakeFs,
  ) {}

  async getFileHandle(name: string, opts?: { create?: boolean }): Promise<FakeFile> {
    const e = this.children.get(name);
    if (e instanceof FakeFile) return e;
    if (e) throw dom('TypeMismatchError');
    if (!opts?.create) throw dom('NotFoundError');
    const f = new FakeFile(name, this.fs);
    this.children.set(name, f);
    return f;
  }

  async getDirectoryHandle(name: string, opts?: { create?: boolean }): Promise<FakeDir> {
    const e = this.children.get(name);
    if (e instanceof FakeDir) return e;
    if (e) throw dom('TypeMismatchError');
    if (!opts?.create) throw dom('NotFoundError');
    const d = new FakeDir(name, this.fs);
    this.children.set(name, d);
    return d;
  }

  private anyLocked(): boolean {
    for (const c of this.children.values()) {
      if (c instanceof FakeFile ? c.locked : c.anyLocked()) return true;
    }
    return false;
  }

  async removeEntry(name: string, opts?: { recursive?: boolean }): Promise<void> {
    const e = this.children.get(name);
    if (!e) throw dom('NotFoundError');
    if (e instanceof FakeFile ? e.locked : e.anyLocked()) throw dom('NoModificationAllowedError', 'file is locked');
    if (e instanceof FakeDir && e.children.size > 0 && !opts?.recursive) throw dom('InvalidModificationError');
    this.children.delete(name);
  }

  async *entries(): AsyncGenerator<[string, FakeFile | FakeDir]> {
    for (const pair of [...this.children]) yield pair;
  }

  /** Names of the entries, for assertions. */
  names(): string[] {
    return [...this.children.keys()].sort();
  }
}

export class FakeFs {
  readonly faults: Record<string, FileFaults> = {};
  readonly root = new FakeDir('', this);

  /** The bytes of `name` in `dir` as of its last sync handle. */
  bytesOf(dir: FakeDir, name: string): Uint8Array {
    const f = dir.children.get(name);
    if (!(f instanceof FakeFile) || !f.last) throw new Error(`no file ${name}`);
    return f.last.bytes();
  }

  /** The last sync handle opened on `name` in `dir`. */
  handleOf(dir: FakeDir, name: string): FakeSyncHandle {
    const f = dir.children.get(name);
    if (!(f instanceof FakeFile) || !f.last) throw new Error(`no file ${name}`);
    return f.last;
  }
}

/** The class to install as `FileSystemFileHandle` so feature detection passes. */
export class FakeFileSystemFileHandle {
  async createSyncAccessHandle(): Promise<void> {}
}

export function asDir(d: FakeDir): FileSystemDirectoryHandle {
  return d as unknown as FileSystemDirectoryHandle;
}

/** The pair of u32 header words of 4 KiB block `b`, read as native-endian. */
export function header(bytes: Uint8Array, b: number): [number, number] {
  const v = new Uint32Array(bytes.slice(b * 4096, b * 4096 + 8).buffer);
  return [v[0]!, v[1]!];
}

/** Overwrite header word `word` (0 = index, 1 = pass) of block `b`. */
export function setHeader(bytes: Uint8Array, b: number, word: 0 | 1, value: number): void {
  new DataView(bytes.buffer, bytes.byteOffset).setUint32(b * 4096 + word * 4, value, true);
}
