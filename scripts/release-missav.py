"""Verify the exact MissAV/Windows build and publish an immutable preview release."""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import zipfile

ROOT = Path(__file__).resolve().parent.parent
REPO = 'P-JSL/myapps'
TAG = 'v1.20.1-preview.1'
VERSION = '1.20.1'
PINNED = {
    'my-video-app-extension-standard.zip': '70ebcc3a49788d8fd1c61263914b386b612e9253bd3d937c9d3dec3b6e776942',
    'my-video-app-antivirus-helper.zip': '88818c9cc0ea443be213ac0c2c20cbeebf3796444026824ac3f9306aef55c959',
}


def require(value, message):
    if not value: raise ValueError(message)


def sha(path):
    with Path(path).open('rb') as file: return hashlib.file_digest(file, 'sha256').hexdigest()


def zip_inventory(path, prefix):
    with zipfile.ZipFile(path) as archive:
        names = archive.namelist()
        require(len(names) == len(set(names)) and bool(names), 'Duplicate or empty ZIP inventory')
        require(all(name.startswith(prefix) and '..' not in name.split('/') and '\\' not in name for name in names), 'Unsafe ZIP path')
        result = {}
        for item in archive.infolist():
            if item.is_dir(): continue
            with archive.open(item) as file: result[item.filename[len(prefix):]] = hashlib.file_digest(file, 'sha256').hexdigest()
        return result


def verify_installed_evidence(installed, identity):
    require(installed.get('buildSha256') == identity and installed.get('version') == VERSION
            and installed.get('extensionInstalled') is True and installed.get('chromeAPIsMocked') is False
            and len(installed.get('checks', [])) == 6 and installed.get('errors') == [], 'Real installed-extension checks are missing')


def verify(directory, commit):
    directory = Path(directory)
    for name, digest in PINNED.items(): require(sha(directory / name) == digest, 'Original asset changed: ' + name)
    windows = json.loads((directory / 'WINDOWS-VALIDATION.json').read_text(encoding='utf-8-sig'))
    require(windows.get('commit') == commit and windows.get('version') == VERSION
            and windows.get('platform') == 'windows-x64' and windows.get('scope') == 'focused-missav-v121', 'Windows validation provenance mismatch')
    require(windows.get('nativeMissavTests') == 11 and windows.get('nativeGuiTests') == 1, 'Windows runtime checks are missing')
    require(windows.get('desktopSha256') == sha(directory / 'my-video-app-desktop-windows-x64.zip'), 'Windows validation belongs to another ZIP')
    with zipfile.ZipFile(directory / 'my-video-app-desktop-windows-x64.zip') as archive:
        manifest = json.loads(archive.read('MyVideoApp/APPMANIFEST.json'))
    require(manifest['version'] == VERSION and manifest['platform'] == 'win32-x64', 'Desktop metadata mismatch')
    actual = zip_inventory(directory / 'my-video-app-desktop-windows-x64.zip', 'MyVideoApp/')
    require({k: v for k, v in actual.items() if k != 'APPMANIFEST.json'} == manifest['files'], 'Desktop member hash mismatch')
    for name, digest in manifest['sourceFiles'].items(): require(sha(ROOT / name) == digest, 'Desktop source changed since build: ' + name)
    inputs = {item['id']: item for item in manifest['inputs']}
    require(inputs['curl-cffi']['version'] == '0.16.3' and inputs['yt-dlp']['version'] == '2026.10.21', 'Desktop transport pins mismatch')
    build = json.loads((ROOT / 'reports/build.json').read_text(encoding='utf-8'))
    extension = zip_inventory(directory / 'my-video-app-extension-missav.zip', 'my-video-app/')
    identity = hashlib.sha256('\n'.join(name + '\0' + digest for name, digest in sorted(extension.items())).encode()).hexdigest()
    require(build['buildSha256'] == identity, 'Extension ZIP is not the verified build')
    with zipfile.ZipFile(directory / 'my-video-app-extension-missav.zip') as archive:
        require(json.loads(archive.read('my-video-app/manifest.json'))['version'] == VERSION, 'Extension version mismatch')
    entries = {entry['logicalOutput']: entry for entry in build['entries']}
    for name in ['local/background.js', 'local/collect.js']:
        require('src/local/missav-relay.ts' in entries[name]['inputs'], 'Page context relay missing from extension')
        require('src/local/missav-context.ts' in entries[name]['inputs'], 'Retry source recovery missing from extension')
    browser = json.loads((directory / 'BROWSER-VALIDATION.json').read_text(encoding='utf-8'))
    require(browser.get('buildSha256') == identity and len(browser.get('checks', [])) == 4 and browser.get('errors') == [], 'Browser checks do not match this build')
    installed = json.loads((directory / 'INSTALLED-EXTENSION-VALIDATION.json').read_text(encoding='utf-8'))
    verify_installed_evidence(installed, identity)


def prepare(directory):
    commit = subprocess.check_output(['git', '-C', str(ROOT), 'rev-parse', 'HEAD'], text=True).strip()
    require(not subprocess.check_output(['git', '-C', str(ROOT), 'diff', '--name-only', 'HEAD', '--',
            'src', 'desktop', 'scripts', 'tests', 'package.json', 'package-lock.json'], text=True).strip(), 'Application source changed after commit')
    verify(directory, commit)
    spec = importlib.util.spec_from_file_location('_release_source_archive', ROOT / 'scripts/assemble-release-bundle.py')
    helper = importlib.util.module_from_spec(spec); spec.loader.exec_module(helper)
    helper.source_zip(directory / 'my-video-app-source.zip', commit)
    names = [*PINNED, 'my-video-app-extension-missav.zip', 'my-video-app-desktop-windows-x64.zip', 'my-video-app-source.zip', 'WINDOWS-VALIDATION.json', 'BROWSER-VALIDATION.json', 'INSTALLED-EXTENSION-VALIDATION.json']
    contents = {'tag': TAG, 'version': VERSION, 'sourceCommit': commit, 'standardExtensionSourceTag': 'v1.19.4-bundle.1',
                'targetManifestVerified': True, 'targetFullVideoVerified': False, 'extensionInstallationVerified': True,
                'previousFullSuites': 'not repeated per user',
                'files': {name: {'sha256': sha(directory / name), 'bytes': (directory / name).stat().st_size} for name in names}}
    (directory / 'RELEASE-CONTENTS.json').write_text(json.dumps(contents, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    names.append('RELEASE-CONTENTS.json')
    (directory / 'SHA256SUMS-RELEASE.txt').write_text(''.join(sha(directory / name) + '  ' + name + '\n' for name in names), encoding='utf-8')
    names.append('SHA256SUMS-RELEASE.txt')
    (directory / 'release-notes.md').write_text(f'''MissAV 확장의 직접 주소 입력과 실패 기록 재시도가 원래 재생 탭을 잃어 실패하던 문제를 수정했습니다. 같은 재생목록의 최신 서명 주소를 사용합니다. Windows 앱은 버전 표시를 갱신했으며 기존 다운로드 동작을 유지합니다.

| 설치 파일 | 내용 |
| --- | --- |
| **my-video-app-extension-missav.zip** | v1.20.1. 감지 목록·직접 주소 입력·재시도 모두 원래 재생 탭을 사용. **확장 업데이트 후 원래 탭을 새로고침하고 영상을 재생하세요.** |
| **my-video-app-extension-standard.zip** | 기존 v1.19.4 일반판 확장. MissAV 전용 코드가 없는 원본 파일 그대로 제공 |
| **my-video-app-desktop-windows-x64.zip** | v1.20.1 Windows 10/11 x64 앱. MissAV 페이지 인식·감지된 m3u8 직접 주소, MissAV 전용 HTTP/2 호환 통신. 기존 YouTube 다운로드 경로·로그·최대 16개 동시 작업 유지 |

확장 ZIP은 둘 중 하나만 설치하세요. Windows ZIP은 **새 폴더에 전체 압축 해제**하고 My Video App.exe를 실행하세요. 페이지 인증이 실패하면 Chrome에서 영상을 재생한 뒤 확장의 ‘주소 복사’로 얻은 m3u8 주소를 Windows 앱에 입력하세요.

검증: 확장을 Chrome에 실제 설치하여 감지 다운로드, 직접 주소 입력, HTTP 403 실패 후 재시도, 재생 탭 조회, 탭을 닫은 경우의 안내, 만료 서명 갱신의 6개 검사를 통과했습니다. Chrome API를 모킹하지 않고 자체 HLS 영상을 실제 파일로 저장하고 모든 디코딩 영상 프레임 해시·음성 트랙을 확인합니다. TypeScript·소스 정책·회귀 검사, Windows 내장 Python·curl-cffi·Qt 및 다운로드→FFmpeg 병합 검사도 통과해야 게시합니다.

실제 CDN 재생목록의 HTTP 200·HLS 인식은 이전 1.20.0 조사에서 확인했습니다. 이번에는 테스트용 Chrome의 실제 확장 설치를 검증했습니다. 실제 사이트 영상 전체 다운로드와 사용자 PC 환경은 미검증입니다. Cloudflare 사람 확인을 자동으로 해결하지 않습니다. 사전 배포로 제공하며 기존 정식 최신 릴리즈와 태그는 유지합니다.

일반판 확장과 백신 도우미는 기존 체크섬과 동일합니다. Windows FFmpeg·Deno·yt-dlp 버전은 유지하며, 만료된 원래 FFmpeg 배포 주소 대신 SHA-256으로 고정한 v1.19.4 패키지에서 동일한 실행 파일·라이선스를 가져옵니다.

[변경·검증 보고서](https://github.com/{REPO}/blob/{commit}/reports/MISSAV_1_20_1.ko.md) · [검증한 소스 커밋](https://github.com/{REPO}/commit/{commit})

전체 소스, Windows·브라우저 검증 기록, 파일별 SHA-256도 첨부했습니다. 환경 자체는 게시하지 않았습니다.
''', encoding='utf-8')
    return commit, names


def gh(arguments):
    return json.loads(subprocess.check_output(['gh', *arguments], text=True, encoding='utf-8'))


def publish(directory, commit, names):
    require(os.environ.get('GITHUB_ACTIONS') == 'true' and os.environ.get('GITHUB_REPOSITORY') == REPO
            and os.environ.get('GITHUB_REF') == 'refs/heads/main' and os.environ.get('GITHUB_SHA') == commit,
            'Only the authorized main-branch CI job can publish')
    releases = gh(['api', f'repos/{REPO}/releases?per_page=100'])
    matches = [item for item in releases if item['tag_name'] == TAG]
    require(not matches or (len(matches) == 1 and matches[0]['draft']), 'A published release must not be changed')
    tag = subprocess.run(['gh', 'api', f'repos/{REPO}/git/ref/tags/{TAG}'], capture_output=True, text=True, encoding='utf-8')
    require((tag.returncode == 0 and json.loads(tag.stdout)['object']['sha'] == commit)
            or (tag.returncode != 0 and '404' in tag.stderr), 'Existing tag cannot be moved')
    if not matches or not matches[0]['assets']:
        if matches: subprocess.run(['gh', 'api', '--method', 'DELETE', f'repos/{REPO}/releases/{matches[0]["id"]}', '--silent'], check=True)
        subprocess.run(['gh', 'release', 'create', TAG, *[str(directory / name) for name in names], '--repo', REPO,
                        '--target', commit, '--draft', '--prerelease', '--latest=false', '--title', 'My Video App 1.20.1 · MissAV 확장 / 일반 확장 / Windows 앱',
                        '--notes-file', str(directory / 'release-notes.md')], check=True)
        matches = [item for item in gh(['api', f'repos/{REPO}/releases?per_page=100']) if item['tag_name'] == TAG]
    require(len(matches) == 1 and matches[0]['draft'], 'Release draft is missing')
    endpoint = f'repos/{REPO}/releases/{matches[0]["id"]}'
    current = gh(['api', endpoint])
    require({asset['name'] for asset in current['assets']} == set(names), 'Uploaded asset inventory mismatch')
    for asset in current['assets']:
        require(asset['size'] == (directory / asset['name']).stat().st_size
                and asset.get('digest') == 'sha256:' + sha(directory / asset['name']), 'Uploaded asset hash mismatch')
    body = directory / 'release-edit.json'
    body.write_text(json.dumps({'draft': False, 'prerelease': True, 'make_latest': 'false', 'target_commitish': commit,
                               'body': (directory / 'release-notes.md').read_text(encoding='utf-8')}, ensure_ascii=False), encoding='utf-8')
    subprocess.run(['gh', 'api', '--method', 'PATCH', endpoint, '--input', str(body), '--silent'], check=True)
    result = gh(['api', endpoint])
    require(not result['draft'] and result['prerelease'] and gh(['api', f'repos/{REPO}/git/ref/tags/{TAG}'])['object']['sha'] == commit, 'Published release validation failed')
    print(json.dumps({'url': result['html_url'], 'commit': commit, 'assets': names}, ensure_ascii=False))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--artifacts', type=Path, required=True)
    parser.add_argument('--publish', action='store_true')
    args = parser.parse_args()
    commit, names = prepare(args.artifacts)
    print('Verified', len(names), 'assets for', commit, flush=True)
    if args.publish: publish(args.artifacts, commit, names)
