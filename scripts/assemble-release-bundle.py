"""Combine pinned published binaries and the current source; publish only from CI."""
import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import stat
import subprocess
import tarfile
from zipfile import ZipFile, ZipInfo, ZIP_DEFLATED

ROOT = Path(__file__).resolve().parent.parent
REPOSITORY = 'P-JSL/myapps'
TAG = 'v1.19.4-bundle.1'
EXTENSION_COMMIT = '748c332c1eb40a94b653f01fbad363631ec22857'
DESKTOP_COMMIT = 'bfa08fb7ca85521a49e18a1f9a8d02a7faf7c29f'
PINNED = {
    'my-video-app-extension-missav.zip': ('v1.19.4-missav.2', '27661e0176009248ec61263df25f17400c513395269a4981835d903975a43d6a'),
    'my-video-app-extension-standard.zip': ('v1.19.4-missav.2', '70ebcc3a49788d8fd1c61263914b386b612e9253bd3d937c9d3dec3b6e776942'),
    'my-video-app-desktop-windows-x64.zip': ('v1.19.4', '2fb6e36bfc04068a3fe29ccaa6f08518de47ab1e67cd5be5448e419115d83768'),
    'my-video-app-antivirus-helper.zip': ('v1.19.4-missav.2', '88818c9cc0ea443be213ac0c2c20cbeebf3796444026824ac3f9306aef55c959'),
    'WINDOWS-VALIDATION.json': ('v1.19.4', 'd2c257615fe6f2c9628a87bfa999783f4de69ef7fcc9dc89a2d21d06d5a4915a'),
}


def sha256(path):
    with Path(path).open('rb') as source:
        return hashlib.file_digest(source, 'sha256').hexdigest()


def require(condition, message):
    if not condition:
        raise ValueError(message)


def verify_files(directory):
    """Reject altered upstream files before reading their ZIP contents."""
    for name, (_, expected) in PINNED.items():
        path = directory / name
        require(path.is_file() and not path.is_symlink(), 'Missing or unsafe input: ' + name)
        require(sha256(path) == expected, 'Upstream SHA-256 mismatch: ' + name)


def verify_windows_evidence(evidence, desktop_sha):
    require(evidence.get('version') == '1.19.4', 'Windows evidence version mismatch')
    require(evidence.get('commit') == DESKTOP_COMMIT, 'Windows evidence commit mismatch')
    require(evidence.get('desktopSha256') == desktop_sha, 'Windows evidence ZIP mismatch')
    require(evidence.get('platform') == 'windows-x64', 'Windows evidence platform mismatch')
    require(evidence.get('validationMode') == 'focused-desktop-v18-restore', 'Windows evidence scope mismatch')
    for key in ('v18RestoreTests', 'v18RestoreGuiTests', 'releaseScopeTests'):
        require(evidence.get(key) == 'passed', 'Missing original Windows check: ' + key)


def verify_archives(directory):
    scripts = []
    permissions = []
    for name in (n for n in PINNED if n.endswith('.zip')):
        with ZipFile(directory / name) as bundle:
            names = bundle.namelist()
            require(names and len(names) == len(set(names)), 'Empty or duplicate ZIP members: ' + name)
            for entry in bundle.infolist():
                p = PurePosixPath(entry.filename)
                require(not p.is_absolute() and '..' not in p.parts and '\\' not in entry.filename
                        and not stat.S_ISLNK(entry.external_attr >> 16), 'Unsafe ZIP member: ' + entry.filename)
            require(bundle.testzip() is None, 'ZIP CRC error: ' + name)
            if name.startswith('my-video-app-extension-'):
                manifest = json.loads(bundle.read('my-video-app/manifest.json'))
                require(manifest['version'] == '1.19.4', 'Extension version mismatch')
                script = 'my-video-app/' + manifest['content_scripts'][0]['js'][0]
                scripts.append(hashlib.sha256(bundle.read(script)).hexdigest())
                permissions.append((manifest['permissions'], manifest['host_permissions']))
            elif name == 'my-video-app-desktop-windows-x64.zip':
                manifest = json.loads(bundle.read('MyVideoApp/APPMANIFEST.json'))
                require(manifest['version'] == '1.19.4', 'Desktop version mismatch')
                require(set(names) == {'MyVideoApp/' + n for n in manifest['files']} | {'MyVideoApp/APPMANIFEST.json'}, 'Desktop ZIP inventory mismatch')
                for source, expected in manifest['sourceFiles'].items():
                    p = PurePosixPath(source)
                    require(not p.is_absolute() and '..' not in p.parts and '\\' not in source, 'Unsafe desktop source path')
                    require(sha256(ROOT / source) == expected, 'Current desktop source differs: ' + source)
                for source, expected in manifest['files'].items():
                    require(hashlib.sha256(bundle.read('MyVideoApp/' + source)).hexdigest() == expected, 'Desktop payload changed: ' + source)
    require(len(scripts) == 2 and len(set(scripts)) == 2, 'Extension collectors are not distinct')
    require(permissions[0] == permissions[1], 'Extension variant permissions differ')


def source_zip(destination, commit):
    excluded = {'.git', 'node_modules', 'dist', 'dist-compat', 'extensions', 'artifacts', 'test-results', '.cache', '.venv', 'venv'}
    private = {'native/config.json', 'native/youtube-config.json'}
    process = subprocess.Popen(['git', '-C', str(ROOT), 'archive', '--format=tar', commit], stdout=subprocess.PIPE)
    try:
        with tarfile.open(fileobj=process.stdout, mode='r|') as archive, ZipFile(destination, 'w', compression=ZIP_DEFLATED, compresslevel=9) as out:
            for item in archive:
                p = PurePosixPath(item.name)
                if p.parts[0] in excluded or item.name in private or '__pycache__' in p.parts or item.isdir():
                    continue
                if p.suffix in {'.log', '.pyc', '.eml', '.pem', '.key', '.p12', '.pfx'}:
                    continue
                require(item.isfile() and not p.is_absolute() and '..' not in p.parts, 'Unsafe source member')
                info = ZipInfo('my-video-app-source/' + item.name, date_time=(2026, 11, 16, 0, 0, 0))
                info.compress_type = ZIP_DEFLATED
                info.external_attr = 0o100644 << 16
                out.writestr(info, archive.extractfile(item).read(), compresslevel=9)
    finally:
        process.stdout.close()
        require(process.wait() == 0, 'Git source archive failed')


def prepare(directory):
    verify_files(directory)
    verify_archives(directory)
    evidence = json.loads((directory / 'WINDOWS-VALIDATION.json').read_text(encoding='utf-8-sig'))
    verify_windows_evidence(evidence, PINNED['my-video-app-desktop-windows-x64.zip'][1])
    commit = subprocess.check_output(['git', '-C', str(ROOT), 'rev-parse', 'HEAD'], text=True).strip()
    # A release never includes local, uncommitted application changes.
    require(not subprocess.check_output(['git', '-C', str(ROOT), 'status', '--porcelain', '--untracked-files=no'], text=True).strip(), 'Commit changes before preparing source')
    source_zip(directory / 'my-video-app-source.zip', commit)
    names = list(PINNED) + ['my-video-app-source.zip']
    record = {
        'tag': TAG, 'version': '1.19.4', 'sourceCommit': commit,
        'extensionBuildCommit': EXTENSION_COMMIT, 'desktopBuildCommit': DESKTOP_COMMIT,
        'appCodeChangedInBundleCommit': False, 'siteVideoVerified': False,
        'siteAccess': 'Cloudflare HTTP 403 human verification',
        'currentChecks': {'typecheck': 'passed', 'missavFocusedTests': 12, 'standardBuildTests': 2,
                          'bundleIntegrityTests': 7,
                          'originalAssetChecksums': 'passed', 'zipCRCAndInventory': 'passed',
                          'desktopCurrentSourceIdentity': 'passed', 'previousFullSuites': 'not repeated'},
        'files': {name: {'sha256': sha256(directory / name), 'bytes': (directory / name).stat().st_size,
                         'sourceTag': PINNED[name][0] if name in PINNED else TAG} for name in names},
    }
    (directory / 'RELEASE-CONTENTS.json').write_text(json.dumps(record, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    names.append('RELEASE-CONTENTS.json')
    (directory / 'SHA256SUMS-RELEASE.txt').write_text(''.join(sha256(directory / n) + '  ' + n + '\n' for n in names), encoding='utf-8')
    names.append('SHA256SUMS-RELEASE.txt')
    (directory / 'release-notes.md').write_text(f'''세 가지 설치 파일을 한 릴리즈에서 제공합니다. **Chrome 확장 ZIP은 둘 중 하나만 설치하세요.**

| 파일 | 내용 |
| --- | --- |
| **my-video-app-extension-missav.zip** | MissAV 플레이어·CDN HLS 감지 추가판. **실험판이며 실제 사이트 다운로드는 Cloudflare 확인 화면 때문에 미검증** |
| **my-video-app-extension-standard.zip** | MissAV 전용 코드가 없는 기존 일반 확장 |
| **my-video-app-desktop-windows-x64.zip** | 기존 정식 Windows v1.19.4와 동일한 파일. YouTube·직접 미디어 주소 지원, v1.18 다운로드 방식과 실행 로그 유지. **MissAV 페이지 지원은 추가하지 않음** |

확장 ZIP은 `v1.19.4-missav.2`, Windows ZIP은 `v1.19.4`의 검증된 파일을 재사용합니다. 원본 SHA-256·ZIP 무결성과 현재 Windows 소스의 일치를 확인했습니다. 앱 코드는 변경하지 않았습니다.

전체 소스 ZIP은 현재 커밋 `{commit}`의 코드와 점검 보고서입니다. 파일 출처는 `RELEASE-CONTENTS.json`, 모든 첨부 파일의 체크섬은 `SHA256SUMS-RELEASE.txt`에 있습니다. 선택적 백신 도우미와 원래 Windows 빌드의 `WINDOWS-VALIDATION.json`도 제공합니다.

타입 검사와 MissAV·일반판 구분 검사 14개가 통과했습니다. 이번 통합 배포의 원본 자산·Windows 검사 기록 및 게시 절차 검증 7개도 통과해야 게시합니다. 기존 전체 회귀 검사와 Windows 실행 검사는 반복하지 않았습니다.

[사이트 접속 결과와 검사 범위](https://github.com/{REPOSITORY}/blob/{commit}/reports/RELEASE_BUNDLE_2026_11_16.ko.md)

MissAV 추가판의 검증 상태를 알리기 위해 사전 배포로 표시합니다. 정식 최신 Windows 릴리즈와 기존 태그는 유지합니다. Windows ZIP은 새 폴더에 전체 압축 해제해 실행하세요.
''', encoding='utf-8')
    return commit, names


def gh_json(arguments):
    return json.loads(subprocess.check_output(['gh', *arguments], text=True))


def publish(directory, commit, names):
    require(os.environ.get('GITHUB_ACTIONS') == 'true' and os.environ.get('GITHUB_REPOSITORY') == REPOSITORY
            and os.environ.get('GITHUB_REF') == 'refs/heads/main' and os.environ.get('GITHUB_SHA') == commit,
            'Publication requires the authorized main-branch GitHub job')
    expected = {n: (directory / n).stat().st_size for n in names}
    hashes = {n: sha256(directory / n) for n in names}
    # The by-tag REST route only guarantees published releases. Include drafts
    # explicitly so an earlier failed local upload cannot create another draft.
    matches = [r for r in gh_json(['api', f'repos/{REPOSITORY}/releases?per_page=100']) if r['tag_name'] == TAG]
    require(len(matches) <= 1, 'Multiple matching releases require review')
    release = matches[0] if matches else None
    if release is not None:
        require(release['draft'], 'Refusing to modify an already published release')
    # A draft may point to the preceding documentation commit; only an absent tag
    # can use this updated target. Existing published/annotated tags never move.
    tag = subprocess.run(['gh', 'api', f'repos/{REPOSITORY}/git/ref/tags/{TAG}'], capture_output=True, text=True)
    if not tag.returncode:
        require(json.loads(tag.stdout)['object']['sha'] == commit, 'Existing tag belongs to another commit')
    else:
        require('404' in tag.stderr, 'Cannot inspect release tag')
    if release is None or not release['assets']:
        if release is not None:
            # Only our empty unpublished draft is disposable. No asset or tag is deleted.
            subprocess.run(['gh', 'api', '--method', 'DELETE', f'repos/{REPOSITORY}/releases/{release["id"]}', '--silent'], check=True)
        # gh release upload cannot always resolve an untagged draft. Creation
        # with assets keeps the release ID throughout upload, as in the main publisher.
        subprocess.run(['gh', 'release', 'create', TAG, *[str(directory / n) for n in names],
                        '--repo', REPOSITORY, '--target', commit, '--draft', '--prerelease', '--latest=false',
                        '--title', 'My Video App v1.19.4 · MissAV 확장 / 일반 확장 / Windows 앱',
                        '--notes-file', str(directory / 'release-notes.md')], check=True)
        matches = [r for r in gh_json(['api', f'repos/{REPOSITORY}/releases?per_page=100']) if r['tag_name'] == TAG]
        require(len(matches) == 1 and matches[0]['draft'], 'Created draft was not found')
        release = matches[0]
    endpoint = f'repos/{REPOSITORY}/releases/{release["id"]}'
    current = gh_json(['api', endpoint])
    require(set(a['name'] for a in current['assets']) == set(names), 'Release asset inventory mismatch')
    for a in current['assets']:
        require(a['size'] == expected[a['name']] and a.get('digest') == 'sha256:' + hashes[a['name']], 'Uploaded asset mismatch: ' + a['name'])
    edit = directory / 'release-edit.json'
    edit.write_text(json.dumps({'target_commitish': commit, 'draft': False, 'prerelease': True, 'make_latest': 'false',
                                'body': (directory / 'release-notes.md').read_text(encoding='utf-8')}, ensure_ascii=False), encoding='utf-8')
    subprocess.run(['gh', 'api', '--method', 'PATCH', endpoint, '--input', str(edit), '--silent'], check=True)
    published = gh_json(['api', endpoint])
    require(not published['draft'] and published['prerelease'], 'Release publication did not complete')
    require(gh_json(['api', f'repos/{REPOSITORY}/git/ref/tags/{TAG}'])['object']['sha'] == commit, 'Published tag mismatch')
    print(json.dumps({'status': 'published', 'url': published['html_url'], 'commit': commit, 'assets': names}, ensure_ascii=False))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--artifacts', type=Path, required=True)
    parser.add_argument('--publish', action='store_true')
    args = parser.parse_args()
    commit, names = prepare(args.artifacts)
    print('Prepared and verified', len(names), 'release assets at', commit, flush=True)
    if args.publish:
        publish(args.artifacts, commit, names)


if __name__ == '__main__':
    main()
