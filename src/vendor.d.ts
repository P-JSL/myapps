declare module '*ffmpeg-core.js' {
  export interface FFmpegCore {
    FS: {
      writeFile(name: string, data: Uint8Array, options?: { canOwn?: boolean }): void;
      readFile(name: string, options?: { encoding: 'utf8' }): Uint8Array | string;
      stat(name: string): { size: number };
      unlink(name: string): void;
      mkdir(path: string): void;
      chdir(path: string): void;
      mount(type: object, options: object, path: string): unknown;
      unmount(path: string): void;
      createNode(parent: unknown, name: string, mode: number, device: number): unknown;
      ErrnoError: new (errno: number) => Error;
    };
    exec(...args: string[]): number;
    ffprobe(...args: string[]): number;
    reset(): void;
    setTimeout(timeout: number): void;
    setLogger(handler: (data: { type: string; message: string }) => void): void;
    setProgress(handler: (data: { progress: number; time: number }) => void): void;
  }
  const createFFmpegCore: (config?: { wasmBinary?: Uint8Array; locateFile?: (path: string, prefix: string) => string }) => Promise<FFmpegCore>;
  export default createFFmpegCore;
}
