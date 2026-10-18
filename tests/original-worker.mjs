import assert from 'node:assert/strict';

/** Exercise the untouched original HTTP-copy worker against our own local fixture. */
export async function testOriginalWorker(page, fixtureUrl, expectedSha256) {
  const result = await page.evaluate(async ({ fixtureUrl }) => {
    const downloadId = `original-http-${crypto.randomUUID()}`;
    const primitive = value => ({ __serde_tag: 'primitive', __serde_val: value });
    const downloadArgs = {
      __serde_tag: 'object',
      __serde_val: {
        strategy: primitive('http_audio_video_one_source'),
        download_id: primitive(downloadId),
        extension: primitive('mp4'),
        url: { __serde_tag: 'url', __serde_val: fixtureUrl },
        headers: { __serde_tag: 'headers', __serde_val: [] },
        cache: primitive('default'),
      },
    };
    return await new Promise((resolve, reject) => {
      const channel = new BroadcastChannel('worker_service');
      const worker = new Worker('/download_worker/main.js', { type: 'module' });
      const events = [];
      let started = false;
      const finish = (error, result) => {
        clearTimeout(timeout);
        channel.close();
        worker.terminate();
        error ? reject(error) : resolve(result);
      };
      const timeout = setTimeout(() => finish(new Error(`Original worker timed out; events=${events.join(',')}`)), 45_000);
      worker.addEventListener('error', event => finish(new Error(`Original worker error: ${event.message}`)));
      channel.addEventListener('message', async event => {
        const envelope = event.data;
        if (envelope?.channel !== 3) return;
        const { name, data } = envelope.msg;
        events.push(name);
        if (name === 'is_ready_success' && !started) {
          started = true;
          channel.postMessage({ channel: 2, msg: { name: 'download', data: { download_args: downloadArgs } } });
        }
        if (name === 'download_error' && data.download_id === downloadId) finish(new Error(`Original worker download error: ${JSON.stringify(data.error)}`));
        if (name !== 'download_result' || data.download_id !== downloadId) return;
        if (data.aborted_no_partial || data.ending_reason !== 'end_of_file') {
          finish(new Error(`Original HTTP copy did not complete: ${JSON.stringify(data)}`));
          return;
        }
        try {
          const directory = await navigator.storage.getDirectory();
          const file = await (await directory.getFileHandle(data.internal_filename)).getFile();
          const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
          const sha256 = [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
          const result = { filename: data.internal_filename, bytes: file.size, sha256, endingReason: data.ending_reason, events };
          // This harness owns only its generated output; leave other OPFS files intact.
          await directory.removeEntry(data.internal_filename);
          if (data.internal_bloburl) channel.postMessage({ channel: 2, msg: { name: 'revoke_blob_url', data: { blob_url: data.internal_bloburl } } });
          finish(null, result);
        } catch (error) { finish(error); }
      });
    });
  }, { fixtureUrl });
  assert.equal(result.sha256, expectedSha256, 'original HTTP download must preserve every fixture byte');
  assert.ok(result.bytes > 0);
  return result;
}
