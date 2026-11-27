"""Verify three freshly built products and publish the immutable 1.20.6 release."""
import argparse
import hashlib
import importlib.util
import json
import math
import os
from pathlib import Path
import re
import stat
import subprocess
import zipfile

ROOT = Path(__file__).resolve().parent.parent
REPO = 'P-JSL/myapps'
VERSION = '1.20.6'
TAG = 'v' + VERSION
RELEASE_REF = 'refs/heads/codex/release-' + VERSION
PINNED = {'my-video-app-antivirus-helper.zip': '88818c9cc0ea443be213ac0c2c20cbeebf3796444026824ac3f9306aef55c959'}
PRODUCTS = ['my-video-app-extension-standard.zip', 'my-video-app-extension-missav.zip', 'my-video-app-desktop-windows-x64.zip']
SPEED_REPORT = 'reports/LARGE_VIDEO_SPEED_COMPARISON.json'
SPEED_SOURCES = (
    'scripts/build-local.mjs', 'scripts/project.mjs', 'scripts/lib/browser-sha256.mjs', 'scripts/lib/protect-build.mjs',
    'src/local/page-fetch.ts', 'src/local/disk-assets.ts', 'src/local/large-stream-worker.ts', 'src/local/offscreen.ts',
    'src/security/file-digest.ts', 'src/security/internal-scan.ts',
)


def require(value, message):
    if not value:
        raise ValueError(message)


def sha(path):
    with Path(path).open('rb') as file:
        return hashlib.file_digest(file, 'sha256').hexdigest()


def read_json(path):
    return json.loads(Path(path).read_text(encoding='utf-8-sig'))


def zip_inventory(path, prefix):
    with zipfile.ZipFile(path) as archive:
        names = archive.namelist()
        require(len(names) == len(set(names)) and bool(names), 'Duplicate or empty ZIP inventory')
        require(all(name.startswith(prefix) and '..' not in name.split('/') and '\\' not in name for name in names), 'Unsafe ZIP path')
        result = {}
        for item in archive.infolist():
            require(not stat.S_ISLNK(item.external_attr >> 16), 'Unsafe ZIP link')
            if item.is_dir():
                continue
            with archive.open(item) as file:
                result[item.filename[len(prefix):]] = hashlib.file_digest(file, 'sha256').hexdigest()
        return result


def tree_identity(inventory):
    return hashlib.sha256('\n'.join(name + '\0' + digest for name, digest in sorted(inventory.items())).encode()).hexdigest()


def verify_installed_evidence(installed, identity):
    require(installed.get('buildSha256') == identity and installed.get('version') == VERSION
            and installed.get('extensionInstalled') is True and installed.get('chromeAPIsMocked') is False
            and len(installed.get('checks', [])) == 6 and installed.get('errors') == [], 'Real installed-extension checks are missing')


def verify_ui_evidence(evidence, identity, variant):
    require(evidence.get('platform') == 'win32' and evidence.get('variant') == variant
            and evidence.get('buildSha256') == identity and evidence.get('chromeAPIsMocked') is False
            and evidence.get('startsAndRetriesUseUI') is True and len(evidence.get('checks', [])) == 3
            and evidence.get('errors') == [] and len(evidence.get('downloads', [])) == 3
            and all(row.get('state') == 'complete' and row.get('bytes', 0) > 0 for row in evidence['downloads']),
            'Real installed-extension UI evidence mismatch: ' + variant)


def verify_speed_evidence(evidence):
    require(evidence.get('baselineTag') == 'v1.20.5' and evidence.get('chromeAPIsMocked') is False
            and evidence.get('fixture') == 'owned-synthetic-hls' and evidence.get('platform') == 'linux',
            'Large video benchmark conditions are missing')
    require(evidence.get('sourceSha256') == {name: sha(ROOT / name) for name in SPEED_SOURCES},
            'Large video benchmark source differs from release')
    lock = read_json(ROOT / 'package-lock.json')['packages']['node_modules/hash-wasm']
    require(evidence.get('hashWasmIntegrity') == lock['integrity'], 'Large video benchmark hasher differs from release')
    rows = evidence.get('runs', [])
    require([row.get('method') for row in rows] == ['candidate', 'baseline', 'baseline', 'candidate'], 'Missing paired large video runs')
    digest = evidence.get('savedFileSha256', '')
    require(re.fullmatch(r'[a-f0-9]{64}', digest) is not None, 'Missing large video SHA-256')
    times = {'baseline': [], 'candidate': []}
    for row in rows:
        elapsed = row.get('downloadElapsedMs', 0)
        require(isinstance(elapsed, (int, float)) and math.isfinite(elapsed) and elapsed > 0
                and row.get('fullVideoVerified') is True and row.get('savedFileSha256') == digest
                and row.get('bytes') == evidence.get('savedBytes') and row['bytes'] > 2 * 1024**3
                and row.get('browserVersion') == evidence.get('browserVersion'), 'Large video comparison output differs')
        times[row['method']].append(elapsed)
    base = sum(times['baseline']) / 2
    fast = sum(times['candidate']) / 2
    minimum = (1 - max(times['candidate']) / min(times['baseline'])) * 100
    require(minimum >= 30, 'Large video save-time reduction must meet the 30 percent target')
    return {'baselineMeanMs': base, 'candidateMeanMs': fast, 'timeReductionPercent': (1 - fast / base) * 100,
            'minimumObservedReductionPercent': minimum,
            'savedBytes': evidence['savedBytes'], 'savedFileSha256': digest, 'fixture': evidence['fixture']}


def verify(directory, commit):
    directory = Path(directory)
    for name, digest in PINNED.items():
        require(sha(directory / name) == digest, 'Original asset changed: ' + name)
    helper_files = {'README.ko.md', 'antivirus_host.py', 'windows_antivirus.py', 'internal_scan.py', 'install.py'}
    require(zip_inventory(directory / 'my-video-app-antivirus-helper.zip', 'my-video-app-antivirus-helper/')
            == {name: sha(ROOT / 'native' / name) for name in helper_files}, 'Pinned antivirus helper differs from current source')
    windows = read_json(directory / 'WINDOWS-VALIDATION.json')
    require(windows.get('commit') == commit and windows.get('version') == VERSION
            and windows.get('platform') == 'windows-x64' and windows.get('scope') == 'release-three-variants-v1206', 'Windows validation provenance mismatch')
    require(windows.get('nativeMissavTests') == 12 and windows.get('nativeGuiTests') == 1
            and windows.get('directHlsTests') == 4 and windows.get('nativeDownloadGuiChecks') == 7, 'Windows runtime checks are missing')
    require(windows.get('desktopSha256') == sha(directory / PRODUCTS[2]), 'Windows validation belongs to another ZIP')
    gui = read_json(directory / 'WINDOWS-GUI-VALIDATION.json')
    require(gui.get('platform') == 'win32' and gui.get('qtBackend') == 'windows'
            and gui.get('engineMocked') is False and gui.get('metadataWorkerMocked') is False
            and len(gui.get('checks', [])) == 7 and gui.get('failures') == [], 'Native GUI download verification is missing')
    with zipfile.ZipFile(directory / PRODUCTS[2]) as archive:
        manifest = json.loads(archive.read('MyVideoApp/APPMANIFEST.json'))
    require(manifest['version'] == VERSION and manifest['platform'] == 'win32-x64', 'Desktop metadata mismatch')
    actual = zip_inventory(directory / PRODUCTS[2], 'MyVideoApp/')
    require({k: v for k, v in actual.items() if k != 'APPMANIFEST.json'} == manifest['files'], 'Desktop member hash mismatch')
    for name, digest in manifest['sourceFiles'].items():
        if name == 'desktop/launcher/MyVideoApp.exe':
            require(digest == actual.get('My Video App.exe') == '5e2109ad9deb62e87065bc48c08871fe0bf0ca7a6b8db2b2ad07f51a20f6093c',
                    'Pinned unchanged launcher identity mismatch')
        else:
            require(sha(ROOT / name) == digest, 'Desktop source changed since build: ' + name)
    require(manifest['inputs'] == read_json(ROOT / 'desktop/dependencies-lock.json')['inputs'], 'Desktop runtime pins mismatch')
    require({'desktop/engine.py', 'desktop/missav.py', 'desktop/main.py'} <= set(manifest['files']), 'Shared desktop engine components are missing')
    identities, manifests = {}, []
    for variant in ['standard', 'missav']:
        build = read_json(directory / (variant.upper() + '-BUILD.json'))
        extension = zip_inventory(directory / f'my-video-app-extension-{variant}.zip', f'my-video-app-{variant}/')
        identity = tree_identity(extension); identities[variant] = identity
        require(build['version'] == VERSION and build['buildSha256'] == identity, 'Extension ZIP is not its verified build: ' + variant)
        with zipfile.ZipFile(directory / f'my-video-app-extension-{variant}.zip') as archive:
            extension_manifest = json.loads(archive.read(f'my-video-app-{variant}/manifest.json'))
        require(extension_manifest['version'] == VERSION, 'Extension version mismatch: ' + variant)
        require(extension_manifest.get('message_serialization') == ('structured_clone' if variant == 'missav' else None),
                'Extension relay transport mismatch: ' + variant)
        require(build['assetMap'].get('vendor/sha256/hasher.js') in extension
                and extension.get('licenses/hash-wasm-MIT.txt') == sha(ROOT / 'licenses/hash-wasm-MIT.txt'),
                'File SHA-256 module or license is missing: ' + variant)
        manifests.append(extension_manifest)
        entries = {entry['logicalOutput']: entry for entry in build['entries']}
        for logical, stem in [('local/background.js', 'background'), ('local/collect.js', 'collect')]:
            entry = entries[logical]
            expected = f'src/local/{stem}{"-standard" if variant == "standard" else ""}.ts'
            require(entry['input'] == expected and expected in entry['inputs'], 'Extension variant entry mismatch')
            if variant == 'standard':
                require(not any('missav' in name.lower() for name in entry['inputs']), 'MissAV runtime leaked into the standard build')
            else:
                require({'src/local/missav-relay.ts', 'src/local/missav-context.ts'} <= set(entry['inputs']), 'MissAV source context support is missing')
        verify_ui_evidence(read_json(directory / (variant.upper() + '-UI-VALIDATION.json')), identity, variant)
    require(identities['standard'] != identities['missav'], 'Extension builds are not distinct')
    require(manifests[0]['permissions'] == manifests[1]['permissions']
            and manifests[0]['host_permissions'] == manifests[1]['host_permissions'], 'Extension variant permissions differ')
    verify_installed_evidence(read_json(directory / 'INSTALLED-EXTENSION-VALIDATION.json'), identities['missav'])


def prepare(directory):
    directory = Path(directory)
    commit = subprocess.check_output(['git', '-C', str(ROOT), 'rev-parse', 'HEAD'], text=True).strip()
    require(not subprocess.check_output(['git', '-C', str(ROOT), 'diff', '--name-only', 'HEAD', '--',
            'src', 'desktop', 'scripts', 'tests', 'package.json', 'package-lock.json'], text=True).strip(), 'Application source changed after commit')
    verify(directory, commit)
    speed = verify_speed_evidence(read_json(ROOT / SPEED_REPORT))
    spec = importlib.util.spec_from_file_location('_release_source_archive', ROOT / 'scripts/assemble-release-bundle.py')
    helper = importlib.util.module_from_spec(spec); spec.loader.exec_module(helper)
    helper.source_zip(directory / 'my-video-app-source.zip', commit)
    (directory / 'DOWNLOAD-SPEED-COMPARISON.json').write_bytes((ROOT / SPEED_REPORT).read_bytes())
    names = PRODUCTS + list(PINNED) + ['DOWNLOAD-SPEED-COMPARISON.json', 'my-video-app-source.zip', 'WINDOWS-VALIDATION.json', 'WINDOWS-GUI-VALIDATION.json',
        'STANDARD-BUILD.json', 'MISSAV-BUILD.json', 'STANDARD-UI-VALIDATION.json', 'MISSAV-UI-VALIDATION.json',
        'INSTALLED-EXTENSION-VALIDATION.json']
    contents = {'tag': TAG, 'version': VERSION, 'sourceCommit': commit, 'standardExtensionRebuilt': True,
                'desktopSupports': ['YouTube', 'ordinary direct media', 'MissAV'],
                'extensionFolders': {'standard': 'extensions/standard', 'missav': 'extensions/missav'}, 'largeVideoBenchmark': speed,
                'previousFullSuites': 'not repeated per user',
                'files': {name: {'sha256': sha(directory / name), 'bytes': (directory / name).stat().st_size} for name in names}}
    (directory / 'RELEASE-CONTENTS.json').write_text(json.dumps(contents, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    names.append('RELEASE-CONTENTS.json')
    (directory / 'SHA256SUMS-RELEASE.txt').write_text(''.join(sha(directory / name) + '  ' + name + '\n' for name in names), encoding='utf-8')
    names.append('SHA256SUMS-RELEASE.txt')
    (directory / 'release-notes.md').write_text(f'''**v{VERSION}**에서 대용량 영상의 Chrome 내부 전송과 전체 파일 SHA-256 계산을 최적화했습니다. Linux에서 같은 합성 HLS 영상을 MissAV판으로 각 방식 두 번 저장했습니다. **평균 {speed['baselineMeanMs'] / 1000:.2f}초에서 {speed['candidateMeanMs'] / 1000:.2f}초로 {speed['timeReductionPercent']:.1f}% 줄었고**, 네 파일의 SHA-256이 일치했습니다. [측정 방법과 원본 수치](https://github.com/{REPO}/blob/{commit}/reports/RELEASE_1_20_6.ko.md)

| 설치 파일 | 용도 |
| --- | --- |
| **my-video-app-extension-standard.zip** | 일반판 Chrome 확장 |
| **my-video-app-extension-missav.zip** | 이번 속도 개선이 적용된 MissAV 지원 Chrome 확장 |
| **my-video-app-desktop-windows-x64.zip** | 일반 직접 미디어·YouTube와 MissAV를 한 앱에서 지원하는 Windows x64 포터블 앱 |

확장 ZIP을 풀고 `my-video-app-standard/` 또는 `my-video-app-missav/` 중 하나를 Chrome에 로드한 뒤 재생 탭을 새로고침하세요. Windows ZIP은 새 폴더에 전체 압축 해제한 뒤 `My Video App.exe`를 실행하세요.

Windows 앱의 GUI 검사 7개, 두 확장의 설치 후 UI 검사 각 3개, MissAV 설치 검사 6개, HLS·TLS 회귀 검사를 통과했습니다. 속도 수치는 약 {speed['savedBytes'] / 1_000_000_000:.2f}GB의 합성 파일을 사용한 Chrome 측정값입니다. 실사이트 Windows 속도 비교는 기준판에서 HTTP 403이 발생해 완료하지 못했습니다. [Windows 검증 방법](https://github.com/{REPO}/blob/{commit}/reports/WINDOWS_VERIFICATION_PLAN.ko.md)

출시 ZIP과 소스, 선택적 백신 도우미, 검증 JSON 및 파일별 SHA-256을 함께 제공합니다. [소스 커밋](https://github.com/{REPO}/commit/{commit})
''', encoding='utf-8')
    return commit, names


def gh(arguments):
    return json.loads(subprocess.check_output(['gh', *arguments], text=True, encoding='utf-8'))


def publish(directory, commit, names):
    require(os.environ.get('GITHUB_ACTIONS') == 'true' and os.environ.get('GITHUB_REPOSITORY') == REPO
            and os.environ.get('GITHUB_REF') == RELEASE_REF and os.environ.get('GITHUB_SHA') == commit,
            'Only the authorized release-branch CI commit can publish')
    releases = gh(['api', f'repos/{REPO}/releases?per_page=100'])
    matches = [item for item in releases if item['tag_name'] == TAG]
    require(not matches or (len(matches) == 1 and matches[0]['draft']), 'A published release must not be changed')
    tag = subprocess.run(['gh', 'api', f'repos/{REPO}/git/ref/tags/{TAG}'], capture_output=True, text=True, encoding='utf-8')
    require((tag.returncode == 0 and json.loads(tag.stdout)['object']['sha'] == commit)
            or (tag.returncode != 0 and '404' in tag.stderr), 'Existing tag cannot be moved')
    if not matches:
        subprocess.run(['gh', 'release', 'create', TAG, *[str(directory / name) for name in names], '--repo', REPO, '--target', commit, '--draft', '--latest=false',
                        '--title', f'My Video App {VERSION} · 기본 확장 / MissAV 확장 / Windows 통합 앱',
                        '--notes-file', str(directory / 'release-notes.md')], check=True)
        matches = [item for item in gh(['api', f'repos/{REPO}/releases?per_page=100']) if item['tag_name'] == TAG]
    require(len(matches) == 1 and matches[0]['draft'], 'Release draft is missing')
    endpoint = f'repos/{REPO}/releases/{matches[0]["id"]}'
    current = gh(['api', endpoint])
    uploaded = {asset['name']: asset for asset in current['assets']}
    require(set(uploaded) <= set(names), 'Unexpected uploaded assets')
    for name, asset in uploaded.items():
        require(asset['size'] == (directory / name).stat().st_size and asset.get('digest') == 'sha256:' + sha(directory / name), 'Existing draft asset hash mismatch')
    for name in names:
        if name not in uploaded:
            # Address an unfinished draft by ID; its tag may not exist yet.
            subprocess.run(['gh', 'api', '--method', 'POST',
                            f'https://uploads.github.com/repos/{REPO}/releases/{current["id"]}/assets?name={name}',
                            '--header', 'Content-Type: application/octet-stream', '--input', str(directory / name), '--silent'], check=True)
    current = gh(['api', endpoint])
    require({asset['name'] for asset in current['assets']} == set(names), 'Uploaded asset inventory mismatch')
    for asset in current['assets']:
        require(asset['size'] == (directory / asset['name']).stat().st_size
                and asset.get('digest') == 'sha256:' + sha(directory / asset['name']), 'Uploaded asset hash mismatch')
    body = directory / 'release-edit.json'
    body.write_text(json.dumps({'draft': False, 'prerelease': False, 'make_latest': 'true', 'target_commitish': commit,
                               'body': (directory / 'release-notes.md').read_text(encoding='utf-8')}, ensure_ascii=False), encoding='utf-8')
    subprocess.run(['gh', 'api', '--method', 'PATCH', endpoint, '--input', str(body), '--silent'], check=True)
    result = gh(['api', endpoint])
    require(not result['draft'] and not result['prerelease'] and gh(['api', f'repos/{REPO}/git/ref/tags/{TAG}'])['object']['sha'] == commit, 'Published release validation failed')
    require(gh(['api', f'repos/{REPO}/releases/latest'])['tag_name'] == TAG, 'New stable release is not latest')
    print(json.dumps({'url': result['html_url'], 'commit': commit, 'assets': names}, ensure_ascii=False))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--artifacts', type=Path, required=True)
    parser.add_argument('--publish', action='store_true')
    args = parser.parse_args()
    commit, names = prepare(args.artifacts)
    print('Verified', len(names), 'assets for', commit, flush=True)
    if args.publish:
        publish(args.artifacts, commit, names)
