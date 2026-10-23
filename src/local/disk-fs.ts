/** Minimal worker-only OPFS contract; callers own and close the two handles. */
export interface DiskAccessHandle {
  read(buffer: Uint8Array, options: { at: number }): number;
  write(buffer: Uint8Array, options: { at: number }): number;
  getSize(): number;
  truncate(size: number): void;
  flush?(): void;
}
export interface DiskExtent { offset: number; length: number; }
interface ExtentFile { offsets: Float64Array; ends: Float64Array; size: number; }
interface DiskNode {
  id: number; name: string; mode: number;
  node_ops: Record<string, unknown>; stream_ops?: Record<string, unknown>;
}
interface DiskStream { node: DiskNode; position: number; }
interface DiskFS {
  mkdir(path: string): void;
  createNode(parent: DiskNode | null, name: string, mode: number, device: number): DiskNode;
  mount(type: { mount(): DiskNode }, options: object, path: string): unknown;
  unmount(path: string): void;
  ErrnoError: new (errno: number) => Error;
}
export interface MountedDiskFiles {
  path(name: string): string;
  outputSize(): number;
  flush(): void;
  unmount(): void;
}
const filename = (name: string) => /^[a-z0-9][a-z0-9._-]{0,127}$/i.test(name) && !name.includes('..');
const integer = (value: number) => Number.isSafeInteger(value) && value >= 0;

/**
 * Expose disk-backed, seekable files to the pinned Emscripten FFmpeg core.
 * Physical extents can interleave parallel downloads in one shared container.
 * A virtual concatenation is only metadata; input/output bytes never enter MEMFS.
 */
export function mountDiskFiles(filesystem: object, assets: DiskAccessHandle, output: DiskAccessHandle,
  inputs: ReadonlyMap<string, readonly DiskExtent[]>, outputName: string, mountpoint = '/disk'): MountedDiskFiles {
  const fs = filesystem as DiskFS;
  if (assets === output || !filename(outputName) || !/^\/[a-z0-9_-]+$/i.test(mountpoint)
    || typeof fs.mount !== 'function' || typeof fs.createNode !== 'function') throw new Error('디스크 미디어 파일 시스템을 준비할 수 없습니다.');
  const physicalSize = assets.getSize();
  if (!integer(physicalSize)) throw new Error('디스크 미디어 용량이 올바르지 않습니다.');
  const files = new Map<string, ExtentFile>();
  for (const [name, extents] of inputs) {
    if (!filename(name) || name === outputName || files.has(name) || !Array.isArray(extents)) throw new Error('디스크 미디어 파일명이 올바르지 않습니다.');
    const offsets = new Float64Array(extents.length), ends = new Float64Array(extents.length);
    let size = 0;
    for (let index = 0; index < extents.length; index++) {
      const extent = extents[index]!;
      if (!extent || !integer(extent.offset) || !Number.isSafeInteger(extent.length) || extent.length <= 0
        || !integer(extent.offset + extent.length) || extent.offset + extent.length > physicalSize
        || !integer(size + extent.length)) throw new Error('디스크 미디어 조각 범위가 올바르지 않습니다.');
      offsets[index] = extent.offset; ends[index] = size += extent.length;
    }
    files.set(name, { offsets, ends, size });
  }
  let root: DiskNode;
  const nodes = new Map<string, DiskNode>();
  const io = <T>(operation: () => T): T => {
    try { return operation(); }
    catch (error) { if (error instanceof fs.ErrnoError) throw error; throw new fs.ErrnoError(29); }
  };
  const sizeOf = (node: DiskNode) => node === root ? 4096 : node.name === outputName ? output.getSize() : files.get(node.name)!.size;
  const checked = (buffer: Uint8Array, offset: number, length: number, position: number) => {
    if (!integer(position) || !integer(offset) || !integer(length) || offset + length > buffer.byteLength) throw new fs.ErrnoError(28);
  };
  const nodeOps = {
    getattr(node: DiskNode) {
      const size = io(() => sizeOf(node));
      return { dev: 1, ino: node.id, mode: node.mode, nlink: 1, uid: 0, gid: 0, rdev: 0,
        size, atime: new Date(), mtime: new Date(), ctime: new Date(), blksize: 4096, blocks: Math.ceil(size / 4096) };
    },
    lookup(_parent: DiskNode, name: string) { const node = nodes.get(name); if (!node) throw new fs.ErrnoError(44); return node; },
    readdir() { return ['.', '..', ...nodes.keys()]; },
    setattr(node: DiskNode, attributes: { mode?: number; size?: number }) {
      if (attributes.mode !== undefined) node.mode = attributes.mode;
      if (attributes.size !== undefined) {
        if (node.name !== outputName || !integer(attributes.size)) throw new fs.ErrnoError(63);
        io(() => output.truncate(attributes.size!));
      }
    },
  };
  const streamOps = {
    read(stream: DiskStream, buffer: Uint8Array, offset: number, length: number, position: number) {
      checked(buffer, offset, length, position);
      if (stream.node.name === outputName) return io(() => output.read(buffer.subarray(offset, offset + length), { at: position }));
      const file = files.get(stream.node.name)!;
      const wanted = Math.min(length, Math.max(0, file.size - position));
      let completed = 0, low = 0, high = file.ends.length;
      // Locate the first overlapping physical extent in O(log n), including >2GiB offsets.
      while (low < high) { const middle = Math.floor((low + high) / 2); if (file.ends[middle]! <= position) low = middle + 1; else high = middle; }
      let index = low;
      while (completed < wanted) {
        const start = index ? file.ends[index - 1]! : 0;
        const count = Math.min(wanted - completed, file.ends[index]! - position);
        const bytes = io(() => assets.read(buffer.subarray(offset + completed, offset + completed + count), { at: file.offsets[index]! + position - start }));
        if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes > count) throw new fs.ErrnoError(29);
        completed += bytes; position += bytes;
        if (position === file.ends[index]) index++;
      }
      return completed;
    },
    write(stream: DiskStream, buffer: Uint8Array, offset: number, length: number, position: number) {
      checked(buffer, offset, length, position);
      if (stream.node.name !== outputName || !integer(position + length)) throw new fs.ErrnoError(63);
      let completed = 0;
      while (completed < length) {
        const count = io(() => output.write(buffer.subarray(offset + completed, offset + length), { at: position + completed }));
        if (!Number.isSafeInteger(count) || count <= 0 || count > length - completed) throw new fs.ErrnoError(29);
        completed += count;
      }
      return completed;
    },
    llseek(stream: DiskStream, offset: number, whence: number) {
      const position = whence === 0 ? offset : whence === 1 ? stream.position + offset : whence === 2 ? io(() => sizeOf(stream.node)) + offset : NaN;
      if (!integer(position)) throw new fs.ErrnoError(28);
      return position;
    },
  };
  try { fs.mkdir(mountpoint); }
  catch (error) { if (!(error && typeof error === 'object' && 'errno' in error && error.errno === 20)) throw error; }
  fs.mount({ mount() {
    root = fs.createNode(null, '/', 0o40700, 0); root.node_ops = nodeOps;
    for (const name of [...files.keys(), outputName]) {
      const node = fs.createNode(root, name, name === outputName ? 0o100600 : 0o100400, 0);
      node.node_ops = nodeOps; node.stream_ops = streamOps; nodes.set(name, node);
    }
    return root;
  } }, {}, mountpoint);
  let mounted = true;
  return {
    path(name) { if (!nodes.has(name)) throw new Error('디스크 미디어 파일을 찾을 수 없습니다.'); return `${mountpoint}/${name}`; },
    outputSize() { return output.getSize(); },
    flush() { output.flush?.(); },
    unmount() { if (mounted) { fs.unmount(mountpoint); mounted = false; } },
  };
}
