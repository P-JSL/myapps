#!/usr/bin/env python3
"""Harmless, temporary native snapshot I/O experiment; no antivirus invocation.

Compare the existing copy+SHA256 loop with an unapplied readinto prototype. Both
keep the mandatory second original-file SHA256 and file identity checks. Warm
filesystem caches and OS writeback affect timing; no AV throughput claim follows.
"""
import argparse
import hashlib
import inspect
import json
import os
from pathlib import Path
import statistics
import tempfile
import time
import tracemalloc


def identity(info):
    return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def copy_secure(source, snapshot, reusable):
    before = source.stat()
    digest = hashlib.sha256()
    copied = 0
    with source.open('rb') as original, snapshot.open('wb') as destination:
        if reusable:
            buffer = bytearray(min(max(before.st_size, 1), 1024 * 1024))
            view = memoryview(buffer)
            while size := original.readinto(buffer):
                copied += size
                if copied > before.st_size:
                    raise AssertionError('Fixture changed during copy')
                chunk = view[:size]
                digest.update(chunk)
                destination.write(chunk)
        else:
            while chunk := original.read(1024 * 1024):
                copied += len(chunk)
                if copied > before.st_size:
                    raise AssertionError('Fixture changed during copy')
                digest.update(chunk)
                destination.write(chunk)
        if copied != before.st_size or identity(before) != identity(os.fstat(original.fileno())):
            raise AssertionError('Fixture identity changed')
        original.seek(0)
        verified = hashlib.file_digest(original, 'sha256').hexdigest()
        if verified != digest.hexdigest() or identity(before) != identity(os.fstat(original.fileno())) or identity(before) != identity(source.stat()):
            raise AssertionError('Mandatory post-copy original verification differed')
    return copied, verified


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--size-mib', type=int, default=64)
    parser.add_argument('--repeats', type=int, default=7)
    options = parser.parse_args()
    if not 1 <= options.size_mib <= 512 or not 3 <= options.repeats <= 25:
        parser.error('Use 1..512 MiB and 3..25 repeats')
    results = {mode: [] for mode in ('baseline-read', 'unapplied-readinto')}
    with tempfile.TemporaryDirectory(prefix='my-video-app-native-bench-') as temporary:
        root = Path(temporary)
        source, snapshot = root / 'harmless.mp4', root / 'snapshot.mp4'
        block = (b'My Video App harmless I/O benchmark.\n' * 32768)[:1024 * 1024]
        block = (block * 2)[:1024 * 1024]
        with source.open('wb') as output:
            for _ in range(options.size_mib):
                output.write(block)
        with source.open('rb') as original:
            expected = (source.stat().st_size, hashlib.file_digest(original, 'sha256').hexdigest())
        # Alternate order to reduce one-sided cache and writeback advantages.
        for round_index in range(options.repeats + 1):
            modes = list(results) if round_index % 2 else list(reversed(results))
            for mode in modes:
                start = time.perf_counter()
                observed = copy_secure(source, snapshot, mode == 'unapplied-readinto')
                elapsed = (time.perf_counter() - start) * 1000
                with snapshot.open('rb') as copied:
                    if observed != expected or hashlib.file_digest(copied, 'sha256').hexdigest() != expected[1]:
                        raise AssertionError('Compared bytes or hashes differ')
                if round_index:
                    results[mode].append(elapsed)
        metrics = {}
        for mode, samples in results.items():
            tracemalloc.start()
            assert copy_secure(source, snapshot, mode == 'unapplied-readinto') == expected
            _, peak = tracemalloc.get_traced_memory()
            tracemalloc.stop()
            metrics[mode] = {'medianMs': statistics.median(samples), 'minMs': min(samples),
                             'maxMs': max(samples), 'repetitions': len(samples), 'peakPythonBytes': peak}
    repository = Path(__file__).resolve().parent.parent
    print(json.dumps({'name': 'native-snapshot-experiment', 'productionChangeApplied': False,
                      'decision': 'Keep existing secure copy: small warm-cache timing differences do not justify a production change.',
                      'scope': 'Copy with SHA256, original-file second SHA256 and identity verification; no antivirus engine; temporary harmless fixture; filesystem caches warm.',
                      'datasetBytes': expected[0], 'copiedBytes': expected[0], 'sha256': expected[1],
                      'bytesAndHashesEqual': True, 'sourceReadBytesPerRun': 2 * expected[0],
                      'snapshotWriteBytesPerRun': expected[0], 'metrics': metrics,
                      'sourceSha256': {str(path.relative_to(repository)): hashlib.sha256(path.read_bytes()).hexdigest()
                                       for path in (repository / 'native/antivirus_host.py', repository / 'native/windows_antivirus.py')},
                      'experimentSha256': hashlib.sha256(inspect.getsource(copy_secure).encode()).hexdigest()}))


if __name__ == '__main__':
    main()
