import { ByteBudget, fetchBytes } from './network.ts';
import { MAX_STREAM_BYTES } from './model.ts';
import type { RemoteAsset } from './hls.ts';
import type { Transport } from './transport.ts';

export async function downloadAssets(assets: RemoteAsset[], consume: (name: string, data: Uint8Array<ArrayBuffer>) => void, signal: AbortSignal,
  progress: (completed: number) => void = () => {}, protocol: (value: Transport) => void = () => {}): Promise<void> {
  const controller = new AbortController();
  const combined = AbortSignal.any([signal, controller.signal]);
  const budget = new ByteBudget(MAX_STREAM_BYTES);
  let next = 0, completed = 0;
  let failure: unknown;
  await Promise.all(Array.from({ length: Math.min(3, assets.length) }, async () => {
    try {
      while (next < assets.length) {
        combined.throwIfAborted(); const asset = assets[next++]!;
        const bytes = await fetchBytes(asset.url, MAX_STREAM_BYTES, combined, asset.range, { budget, protocol,
          ...(asset.expectedSize === undefined ? {} : { expectedSize: asset.expectedSize }) });
        combined.throwIfAborted(); consume(asset.filename, bytes); progress(++completed);
      }
    } catch (error) { failure ??= error; controller.abort(); }
  }));
  if (failure !== undefined) throw failure;
  signal.throwIfAborted();
}
