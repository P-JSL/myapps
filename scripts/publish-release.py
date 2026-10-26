"""Validate products and publish them only from the authorized GitHub job."""
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import subprocess
import tempfile
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from zipfile import ZipFile

ROOT = Path(__file__).resolve().parent.parent
ASSETS = ('my-video-app-extension.zip', 'my-video-app-desktop-windows-x64.zip', 'my-video-app-source.zip', 'my-video-app-antivirus-helper.zip')

def sha256(path):
    digest = hashlib.sha256()
    with path.open('rb') as source:
        for block in iter(lambda: source.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()

def validate():
    version = json.loads((ROOT / 'package.json').read_text(encoding='utf-8'))['version']
    if not re.fullmatch(r'\d+\.\d+\.\d+', version):
        raise ValueError('A stable numeric version is required.')
    checksums = dict(line.split()[::-1] for line in (ROOT / 'artifacts/SHA256SUMS').read_text().splitlines() if line.strip())
    hashes = {}
    for name in ASSETS:
        asset = ROOT / 'artifacts' / name
        hashes[name] = sha256(asset)
        if name != ASSETS[1] and checksums.get(name) != hashes[name]:
            raise ValueError('Committed checksum mismatch: ' + name)
        with ZipFile(asset) as archive:
            names = archive.namelist()
            if not names or len(names) != len(set(names)):
                raise ValueError('Empty or duplicate ZIP: ' + name)
            for entry in archive.infolist():
                path = PurePosixPath(entry.filename)
                if path.is_absolute() or '..' in path.parts or '\\' in entry.filename or path.as_posix() != entry.filename or stat.S_ISLNK(entry.external_attr >> 16) or entry.flag_bits & 1:
                    raise ValueError('Unsafe ZIP entry: ' + name)
            if archive.testzip() is not None:
                raise ValueError('ZIP CRC failure: ' + name)
            if name == ASSETS[0]:
                manifest = json.loads(archive.read('my-video-app/manifest.json'))
                if manifest['version'] != version or 'tabCapture' in manifest.get('permissions', []):
                    raise ValueError('Extension version or architecture mismatch.')
            elif name == ASSETS[1]:
                manifest = json.loads(archive.read('MyVideoApp/APPMANIFEST.json'))
                if manifest.get('version') != version:
                    raise ValueError('Desktop version mismatch.')
                sources = manifest.get('sourceFiles')
                if not isinstance(sources, dict) or not sources:
                    raise ValueError('Desktop source identity is missing.')
                for source, expected in sources.items():
                    path = PurePosixPath(source)
                    if path.is_absolute() or '..' in path.parts or '\\' in source or sha256(ROOT / source) != expected:
                        raise ValueError('Desktop package has stale application source.')
                for required in ('My Video App.exe', 'desktop/main.py', 'desktop/engine.py', 'runtime/python/pythonw.exe', 'runtime/deno.exe', 'runtime/ffmpeg/ffmpeg.exe', 'runtime/ffmpeg/ffprobe.exe'):
                    if 'MyVideoApp/' + required not in names:
                        raise ValueError('Desktop runtime missing: ' + required)
    return version, hashes

def main():
    version, hashes = validate()
    if os.environ.get('GITHUB_REPOSITORY') != 'P-JSL/myapps' or os.environ.get('GITHUB_REF') != 'refs/heads/main':
        raise SystemExit('Publishing is restricted to this repository main-branch workflow.')
    commit = os.environ['GITHUB_SHA']
    if not re.fullmatch('[0-9a-f]{40}', commit):
        raise SystemExit('Invalid release commit.')
    evidence_path = ROOT / 'artifacts/WINDOWS-VALIDATION.json'
    evidence = json.loads(evidence_path.read_text(encoding='utf-8-sig'))
    if evidence.get('version') != version or evidence.get('commit') != commit or evidence.get('platform') != 'windows-x64' or any(evidence.get(key) != 'passed' for key in ('packagedGui', 'guiQueueTests', 'localMediaMp4Mp3M4a')):
        raise SystemExit('Actual packaged Windows verification is missing or stale.')
    hashes[evidence_path.name] = sha256(evidence_path)
    tag, repository = 'v' + version, os.environ['GITHUB_REPOSITORY']
    def api(path):
        request = Request('https://api.github.com/repos/' + repository + path, headers={'Authorization': 'Bearer ' + os.environ['GH_TOKEN'], 'Accept': 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28'})
        try:
            with urlopen(request, timeout=30) as response:
                return json.load(response)
        except HTTPError as error:
            if error.code == 404:
                return None
            raise RuntimeError('GitHub identity check failed: HTTP ' + str(error.code)) from None
    reference = api('/git/ref/tags/' + tag)
    release = api('/releases/tags/' + tag)
    if release is not None and reference is None:
        raise SystemExit('Existing release lacks verified matching tag.')
    if reference is not None:
        target = reference['object']
        for _ in range(8):
            if target['type'] != 'tag':
                break
            target = api('/git/tags/' + target['sha'])['object']
        if target['type'] != 'commit':
            raise SystemExit('Existing tag does not resolve to a commit.')
        if target['sha'] != commit:
            # Preserve the repository's rollback-safety contract: never move a
            # version tag, and skip only an already published identical product.
            if release is None or release.get('draft') is not False or release.get('prerelease') is not False:
                raise SystemExit('Existing tag requires a published stable identical release.')
            def contents(identifier):
                snapshot = api('/git/commits/' + identifier)
                tree_id = (snapshot or {}).get('tree', {}).get('sha')
                if not isinstance(tree_id, str) or not re.fullmatch('[0-9a-f]{40}', tree_id):
                    raise SystemExit('Release commit has no verifiable Git tree.')
                tree = api('/git/trees/' + tree_id + '?recursive=1')
                if not tree or tree.get('truncated') is not False or not isinstance(tree.get('tree'), list):
                    raise SystemExit('Release Git tree is missing or truncated.')
                result = {}
                for item in tree['tree']:
                    if item.get('type') == 'tree':
                        continue
                    path = item.get('path')
                    if not isinstance(path, str) or path in result:
                        raise SystemExit('Invalid or duplicate Git tree entry.')
                    result[path] = (item.get('mode'), item.get('type'), item.get('sha'))
                return result
            before, after = contents(target['sha']), contents(commit)
            automation = {'.github/workflows/release.yml', 'scripts/publish-release.py', 'tests/test_publish_release.py', 'tests/release-workflow.test.mjs'}
            if any(before.get(path) != after.get(path) for path in before.keys() | after.keys() if path not in automation):
                raise SystemExit('Existing release has differing tracked content; bump the version.')
            published_assets = release.get('assets')
            if not isinstance(published_assets, list):
                raise SystemExit('Existing release assets are not verifiable.')
            for name in ASSETS:
                matches = [asset for asset in published_assets if asset.get('name') == name]
                if len(matches) != 1 or matches[0].get('digest') != 'sha256:' + hashes[name]:
                    raise SystemExit('Existing release asset digest differs: ' + name)
            print('Existing identical', tag, 'release; publication skipped without moving its tag.')
            return
    artifacts = ROOT / 'artifacts'
    sums = artifacts / 'SHA256SUMS-RELEASE.txt'
    sums.write_text(''.join(value + '  ' + name + '\n' for name, value in hashes.items()), encoding='utf-8')
    notes = ('My Video App **' + version + '**\n\n'
             '- **Windows 앱:** `my-video-app-desktop-windows-x64.zip` 전체 압축 해제 후 `My Video App.exe` 실행. '
             'YouTube·최고 화질·MP3/M4A·병합·대기열·기록·설정. Python·yt-dlp·Deno·FFmpeg·Qt 내장. 별도 도우미 등록·API 키 불필요.\n'
             '- **Chrome 확장:** `my-video-app-extension.zip`. **YouTube 제외**, 일반 미디어·HLS/DASH·로컬 도구 유지.\n'
             '- 최초 저장 폴더 설정 후 파일마다 저장 창 없이 자동 저장.\n'
             '- `my-video-app-source.zip`: 전체 프로젝트 소스. 확장 백신 도우미는 별도 선택 항목.\n\n'
             'Windows x64 개인용 포터블 빌드이며 서명되지 않았습니다. DRM·로그인/유료 권한 우회·라이브 녹화 미지원. '
             '사이트 변경·접근 조건에 따라 일부 다운로드는 제한됩니다. SHA-256은 첨부 목록을 참고하세요.\n')
    with tempfile.TemporaryDirectory(prefix='myvideo-release-') as temporary:
        body = Path(temporary) / 'notes.md'
        body.write_text(notes, encoding='utf-8')
        assets = [str(artifacts / name) for name in ASSETS] + [str(evidence_path), str(sums)]
        def gh(*args):
            subprocess.run(['gh', *args], check=True, cwd=ROOT, shell=False)
        if release is None:
            gh('release', 'create', tag, *assets, '--repo', repository, '--target', commit, '--draft', '--title', 'My Video App ' + tag, '--notes-file', str(body))
        else:
            gh('release', 'upload', tag, *assets, '--repo', repository, '--clobber')
        gh('release', 'edit', tag, '--repo', repository, '--draft=false', '--latest', '--title', 'My Video App ' + tag, '--notes-file', str(body))
    print('Published', tag, 'at', commit)

if __name__ == '__main__':
    main()
