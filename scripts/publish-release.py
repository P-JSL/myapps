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
CONCURRENCY_VERSION = '1.18.0'
CONCURRENCY_MODE = 'focused-desktop-concurrency'
CONCURRENCY_BASELINE = 'v1.17.0'
CONCURRENCY_BASELINE_COMMIT = '252b452da32f16dc81cb36cca94231879d43c5f1'
TRANSPORT_VERSION = '1.19.0'
TRANSPORT_MODE = 'focused-desktop-transport'
TRANSPORT_BASELINE = 'v1.18.0'
TRANSPORT_BASELINE_COMMIT = '1756c8dec1cb6e655fd486ab4a55fcc35641fd74'
TRANSPORT_REPORT = 'DESKTOP-TRANSPORT-TESTS.json'
TRANSPORT_PROTOCOLS = frozenset(('h3', 'h2', 'http/1.1'))
RECOVERY_VERSION = '1.19.1'
RECOVERY_MODE = 'focused-download-recovery'
RECOVERY_BASELINE = 'v1.19.0'
RECOVERY_BASELINE_COMMIT = 'b09935f7d1ce9fe6f4003bce4d8a87d8e09d826a'

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
                if version == CONCURRENCY_VERSION:
                    for required in ('desktop/concurrency.py', 'runtime/python/python.exe'):
                        if 'MyVideoApp/' + required not in names:
                            raise ValueError('Desktop concurrency runtime missing: ' + required)
                elif version in (TRANSPORT_VERSION, RECOVERY_VERSION):
                    for required in ('desktop/concurrency.py', 'desktop/transport.py', 'desktop/transfer.py', 'desktop/bandwidth.py',
                                     'runtime/python/python.exe', 'runtime/python/Lib/site-packages/curl_cffi/__init__.py'):
                        if 'MyVideoApp/' + required not in names:
                            raise ValueError('Desktop transport runtime missing: ' + required)
    return version, hashes

def validate_transport_report(report):
    """Require the protocol observations emitted by the real loopback suite."""
    if (not isinstance(report, dict) or report.get('status') != 'passed'
            or report.get('liveYouTubeVerified') is not False):
        raise SystemExit('Actual packaged transport protocol proof is missing or failed.')
    protocols = report.get('protocols')
    if (not isinstance(protocols, list) or len(protocols) != len(TRANSPORT_PROTOCOLS)
            or not all(isinstance(protocol, str) for protocol in protocols)
            or set(protocols) != TRANSPORT_PROTOCOLS):
        raise SystemExit('Actual packaged transport protocol proof must observe HTTP/3, HTTP/2, and HTTP/1.1.')
    if not isinstance(report.get('tests'), int) or isinstance(report['tests'], bool) or report['tests'] <= 0:
        raise SystemExit('Actual packaged transport protocol proof has no successful tests.')

def validate_windows_evidence(version, commit, evidence, desktop_sha256,
                              transport_report=None, transport_report_sha256=None):
    """Each version keeps its own explicitly authorized verification scope."""
    if not isinstance(evidence, dict) or any(evidence.get(key) != value for key, value in (
            ('version', version), ('commit', commit), ('platform', 'windows-x64'))):
        raise SystemExit('Actual packaged Windows verification is missing or stale.')
    if version == RECOVERY_VERSION:
        required = {'validationMode': RECOVERY_MODE, 'baseline': RECOVERY_BASELINE,
                    'baselineCommit': RECOVERY_BASELINE_COMMIT, 'desktopSha256': desktop_sha256,
                    'recoveryTests': 'passed', 'releaseScopeTests': 'passed',
                    'priorChecks': 'skipped-per-user'}
        if (any(evidence.get(key) != value for key, value in required.items())
                or evidence.get('liveYouTubeVerified') is not False):
            raise SystemExit('Focused download recovery Windows verification is missing or stale.')
    elif version == TRANSPORT_VERSION:
        validate_transport_report(transport_report)
        if not isinstance(transport_report_sha256, str) or not re.fullmatch('[0-9a-f]{64}', transport_report_sha256):
            raise SystemExit('Actual packaged transport protocol proof hash is missing.')
        required = {
            'validationMode': TRANSPORT_MODE,
            'baseline': TRANSPORT_BASELINE,
            'baselineCommit': TRANSPORT_BASELINE_COMMIT,
            'desktopSha256': desktop_sha256,
            'bandwidthTests': 'passed',
            'rangeTests': 'passed',
            'transportTests': 'passed',
            'engineTransportTests': 'passed',
            'releaseScopeTests': 'passed',
            'actualProtocols': transport_report['protocols'],
            'transportReportSha256': transport_report_sha256,
            'priorChecks': 'skipped-per-user',
        }
        if (any(evidence.get(key) != value for key, value in required.items())
                or evidence.get('liveYouTubeVerified') is not False
                or evidence.get('publicWANBenchmarked') is not False):
            raise SystemExit('Focused desktop transport Windows verification is missing, stale, or has the wrong scope.')
    elif version == CONCURRENCY_VERSION:
        required = {
            'validationMode': CONCURRENCY_MODE,
            'baseline': CONCURRENCY_BASELINE,
            'baselineCommit': CONCURRENCY_BASELINE_COMMIT,
            'desktopSha256': desktop_sha256,
            'concurrencyTests': 'passed',
            'concurrencyGuiTests': 'passed',
            'releaseScopeTests': 'passed',
            'priorChecks': 'skipped-per-user',
        }
        if any(evidence.get(key) != value for key, value in required.items()) or evidence.get('liveYouTubeVerified') is not False:
            raise SystemExit('Focused desktop concurrency Windows verification is missing, stale, or has the wrong scope.')
    elif version == '1.17.0':
        if any(evidence.get(key) != 'passed' for key in ('packagedGui', 'guiQueueTests', 'localMediaMp4Mp3M4a')):
            raise SystemExit('Actual packaged Windows verification is missing or stale.')
    else:
        raise SystemExit('This release version has no authorized Windows verification scope.')

def main():
    version, hashes = validate()
    if os.environ.get('GITHUB_REPOSITORY') != 'P-JSL/myapps' or os.environ.get('GITHUB_REF') != 'refs/heads/main':
        raise SystemExit('Publishing is restricted to this repository main-branch workflow.')
    commit = os.environ['GITHUB_SHA']
    if not re.fullmatch('[0-9a-f]{40}', commit):
        raise SystemExit('Invalid release commit.')
    evidence_path = ROOT / 'artifacts/WINDOWS-VALIDATION.json'
    evidence = json.loads(evidence_path.read_text(encoding='utf-8-sig'))
    transport_report_path = ROOT / 'artifacts' / TRANSPORT_REPORT
    if version == TRANSPORT_VERSION:
        transport_report = json.loads(transport_report_path.read_text(encoding='utf-8-sig'))
        transport_report_sha256 = sha256(transport_report_path)
        validate_windows_evidence(version, commit, evidence, hashes[ASSETS[1]],
                                  transport_report, transport_report_sha256)
        hashes[TRANSPORT_REPORT] = transport_report_sha256
    else:
        validate_windows_evidence(version, commit, evidence, hashes[ASSETS[1]])
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
            for name in (hashes if version == TRANSPORT_VERSION else ASSETS):
                matches = [asset for asset in published_assets if asset.get('name') == name]
                if len(matches) != 1 or matches[0].get('digest') != 'sha256:' + hashes[name]:
                    raise SystemExit('Existing release asset digest differs: ' + name)
            print('Existing identical', tag, 'release; publication skipped without moving its tag.')
            return
    artifacts = ROOT / 'artifacts'
    sums = artifacts / 'SHA256SUMS-RELEASE.txt'
    sums.write_text(''.join(value + '  ' + name + '\n' for name, value in hashes.items()), encoding='utf-8')
    concurrency_notes = ('- **데스크톱 동시 다운로드:** 자동(기본값, CPU에 따라 2~4개) 또는 1~16개 작업을 선택할 수 있습니다. '
                         '호스트당 기본 4개(1~16개 설정), 전체 조각 예산 16개, 동시 변환 2개와 FFmpeg 스레드 2개로 리소스를 제한합니다.\n'
                         '- **검증 범위:** 새 동시성·동시성 GUI·릴리스 범위 검사만 실행했습니다. '
                         '이전 검사는 사용자 요청으로 건너뛰었으며 실제 YouTube 다운로드는 확인하지 않았습니다.\n') if version == CONCURRENCY_VERSION else ''
    transport_notes = ('- **직접 미디어 전송:** 강한 Range 검증자가 있는 파일만 병렬로 전송하며 HTTP/3 연결이 불가능하면 HTTP/2·HTTP/1.1로 대체합니다. 다운로드 속도 제한을 설정에서 켜거나 끌 수 있습니다.\n'
                       '- **실제 관측 프로토콜:** ' + ', '.join(evidence['actualProtocols']) + '. 내장 Windows 런타임으로 TLS 루프백 서버를 확인했습니다. '
                       '원시 결과는 `DESKTOP-TRANSPORT-TESTS.json`, 연결된 SHA-256은 `WINDOWS-VALIDATION.json`과 첨부 목록에 있습니다.\n'
                       '- **검증 범위:** 새 속도 제한·Range·전송·엔진 통합·릴리스 범위 검사만 실행했습니다. 이전 검사는 사용자 요청으로 건너뛰었습니다. '
                       '처리량 벤치마크는 통제된 로컬 조건이며 인터넷 속도를 보장하지 않습니다. 실제 YouTube 다운로드와 공용 WAN 벤치마크는 확인하지 않았습니다.\n') if version == TRANSPORT_VERSION else ''
    recovery_notes = ('- **완료 직전 실패 복구:** Range 확인 요청을 거부하는 서버는 쓰기 전 일반 GET으로 전환합니다. '
                      '일시적인 연결 중단은 실패한 트랙만 한 번 호환 전송으로 복구하며 이미 받은 영상은 유지합니다.\n'
                      '- **오류 구분:** 오디오·영상·검사·병합 단계와 HTTP 상태를 표시하고 실제 용량 부족·권한 오류를 구분합니다.\n'
                      '- **검증 범위:** 이번 복구 경로와 실제 로컬 영상·음성 병합만 재검증했습니다. 이전 검사는 건너뛰었으며 '
                      '제보된 실제 YouTube 서버 다운로드는 검증하지 않았습니다.\n') if version == RECOVERY_VERSION else ''
    notes = ('My Video App **' + version + '**\n\n'
             + concurrency_notes + transport_notes + recovery_notes +
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
        if version == TRANSPORT_VERSION:
            assets.append(str(transport_report_path))
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
