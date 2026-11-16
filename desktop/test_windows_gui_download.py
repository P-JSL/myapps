"""Run the real Windows launcher and GUI download workers on owned fixture media.

No engine or extraction worker is replaced. A localhost-only TLS fixture tunnel
is inherited by the real isolated metadata child. TLS verification stays on.
"""
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time
import traceback

parser = argparse.ArgumentParser()
parser.add_argument('--app-root', type=Path, required=True)
parser.add_argument('--output', type=Path, required=True)
args = parser.parse_args()
if sys.platform != 'win32':
    raise SystemExit('This verification requires native Windows; Linux/Wine cannot pass it.')
APP = args.app_root.resolve()
REPO = Path(__file__).resolve().parent.parent
OUT = args.output.resolve(); OUT.mkdir(parents=True, exist_ok=True)
sys.path.insert(0, str(APP / 'desktop'))
os.environ['QT_QPA_PLATFORM'] = 'windows'
from PySide6.QtCore import Qt
from PySide6.QtTest import QTest
from PySide6.QtWidgets import QApplication
import main as gui
from activity import ActivityLog
from engine import Engine

ID = 'a1b2c3d4-1234-5678-abcd-1234567890ab'
ROOT = f'https://surrit.com/{ID}/'
checks, failures = [], []
window = None
fixture = None
activity = None
original_environment = os.environ.copy()


def command(arguments):
    return subprocess.check_output([str(value) for value in arguments], stderr=subprocess.STDOUT, timeout=30)


def wait(predicate, message, seconds=35):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        QApplication.processEvents()
        if predicate():
            return
        QTest.qWait(20)
    raise AssertionError(message)


def screenshot(name):
    QApplication.processEvents()
    assert window.grab().save(str(OUT / (name + '.png')))


def enter(url):
    before = set(window.items)
    window.navigate(0)
    QApplication.clipboard().setText(url)
    QTest.mouseClick(window.paste_button, Qt.MouseButton.LeftButton)
    assert window.url_input.text() == url
    QTest.mouseClick(window.download_button, Qt.MouseButton.LeftButton)
    wait(lambda: bool(set(window.items) - before), 'Download button did not create a job')
    return (set(window.items) - before).pop()


def finish(job_id, expected='complete'):
    wait(lambda: window.items[job_id].stage in {'error', 'cancelled', 'complete'} and job_id not in window.workers,
         'Download worker did not finish')
    item = window.items[job_id]
    assert item.stage == expected, item.message
    return item


def check_media(item):
    file = Path(item.filepath)
    assert file.is_file() and file.parent == destination
    probe = json.loads(command([ffprobe, '-v', 'error', '-show_streams', '-of', 'json', file]))
    assert {stream['codec_type'] for stream in probe['streams']} == {'video', 'audio'}
    def digest(path):
        return command([ffmpeg, '-v', 'error', '-i', path, '-map', '0:v:0', '-f', 'hash', '-hash', 'sha256', '-'])
    assert digest(file) == digest(source)


try:
    ffmpeg, ffprobe = APP / 'runtime/ffmpeg/ffmpeg.exe', APP / 'runtime/ffmpeg/ffprobe.exe'
    source = REPO / 'tests/fixtures/desktop-source.mp4'
    fragment = OUT / 'owned.ts'
    command([ffmpeg, '-v', 'error', '-i', source, '-c', 'copy', '-f', 'mpegts', '-y', fragment])
    cert, key = OUT / 'fixture-ca.pem', OUT / 'fixture.key'
    openssl = shutil.which('openssl') or str(Path(os.environ.get('ProgramFiles', r'C:\Program Files')) / 'Git/usr/bin/openssl.exe')
    command([openssl, 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-keyout', key, '-out', cert,
             '-subj', '/CN=Owned Windows fixture', '-addext', 'subjectAltName=DNS:surrit.com,DNS:missav123.com',
             '-addext', 'basicConstraints=critical,CA:TRUE'])
    control = OUT / 'fixture-control.json'
    control.write_text(json.dumps({'slow': True, 'deny': True}), encoding='utf-8')
    fixture = subprocess.Popen([shutil.which('node'), str(REPO / 'tests/windows_gui_fixture_server.mjs'), str(cert), str(key), str(source),
                                str(fragment), str(OUT / 'fixture-requests.jsonl'), str(control)], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    proxy_port = json.loads(fixture.stdout.readline())['proxy']
    os.environ.update({'HTTPS_PROXY': f'http://127.0.0.1:{proxy_port}', 'https_proxy': f'http://127.0.0.1:{proxy_port}',
                       'SSL_CERT_FILE': str(cert), 'REQUESTS_CA_BUNDLE': str(cert), 'NO_PROXY': '127.0.0.1,localhost', 'no_proxy': '127.0.0.1,localhost'})
    launcher = subprocess.Popen([str(APP / 'My Video App.exe'), '--smoke-test', '--data-dir', str(OUT / '런처 시작 데이터'),
                                 '--screenshot', str(OUT / '00-native-launcher.png')], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        assert launcher.wait(timeout=20) == 0
    except Exception:
        subprocess.run(['taskkill', '/PID', str(launcher.pid), '/T', '/F'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
        raise
    assert (OUT / '00-native-launcher.png').is_file()
    checks.append('the actual EXE launcher opens native Qt from a Unicode installation path')
    app = QApplication.instance() or QApplication([])
    app.setStyle('Fusion')
    assert app.platformName() == 'windows'
    destination = OUT / '한글 저장 폴더'; destination.mkdir(exist_ok=True)
    data = OUT / '개별 테스트 데이터'
    activity = ActivityLog(data, version=gui.VERSION)
    engine = Engine(APP, data, activity=activity)
    engine.save_settings({'download_folder': str(destination), 'folder_confirmed': True, 'scan_after_download': False,
                          'output': 'original', 'quality': 'highest', 'concurrent_downloads': 1, 'host_concurrent_downloads': 1})
    window = gui.MainWindow(engine)
    window.show(); window.raise_(); window.activateWindow()
    wait(window.isVisible, 'Native Windows window did not appear')
    assert int(window.winId()) != 0
    screenshot('01-native-window')

    before = len(window.items)
    window.url_input.setText('not-a-media-url')
    QTest.mouseClick(window.download_button, Qt.MouseButton.LeftButton)
    assert len(window.items) == before and window.url_input.property('error')
    checks.append('invalid input is rejected by the real GUI without starting a worker')

    direct = enter(f'http://127.0.0.1:{proxy_port}/direct.m3u8')
    check_media(finish(direct)); screenshot('02-direct-hls-complete')
    checks.append('direct HLS runs through the isolated metadata child and saves identical frames in a Unicode directory')

    page_job = enter('https://missav123.com/ko/owned-gui')
    check_media(finish(page_job)); screenshot('03-missav-page-complete')
    checks.append('MissAV page downloads through real Windows curl-cffi, HTTP/2 and FFmpeg')

    failed = enter(ROOT + 'retry/video.m3u8')
    finish(failed, 'error'); screenshot('04-request-failure')
    control.write_text(json.dumps({'slow': True, 'deny': False}), encoding='utf-8')
    QTest.mouseClick(window.cards[failed].action, Qt.MouseButton.LeftButton)
    wait(lambda: failed in window.workers or window.items[failed].stage == 'complete', 'Retry button did not start a worker')
    check_media(finish(failed)); screenshot('05-retry-complete')
    checks.append('HTTP 403 creates an error card and the real retry button completes the same job')

    slow = enter(ROOT + 'slow/video.m3u8')
    wait(lambda: window.items[slow].stage == 'downloading', 'Slow job did not reach downloading')
    QTest.mouseClick(window.cards[slow].action, Qt.MouseButton.LeftButton)
    finish(slow, 'cancelled'); screenshot('06-cancelled')
    assert not window.items[slow].filepath
    control.write_text(json.dumps({'slow': False, 'deny': False}), encoding='utf-8')
    QTest.mouseClick(window.cards[slow].action, Qt.MouseButton.LeftButton)
    wait(lambda: slow in window.workers or window.items[slow].stage == 'complete', 'Cancelled job could not retry')
    finish(slow)
    probe = json.loads(command([ffprobe, '-v', 'error', '-show_streams', '-of', 'json', window.items[slow].filepath]))
    assert {stream['codec_type'] for stream in probe['streams']} == {'video', 'audio'}
    screenshot('07-cancel-retry-complete')
    checks.append('cancel stops a real downloading worker and retry completes without losing its slot or job identity')
    assert all(value['used'] == 0 for value in engine.resources.snapshot().values())
    assert not window.workers and not window.pending
    traffic = [json.loads(line) for line in (OUT / 'fixture-requests.jsonl').read_text(encoding='utf-8').splitlines()]
    assert any(row['encrypted'] and row['http'] == '2.0' and row['pathname'].endswith('.ts') for row in traffic)
    checks.append('all GUI workers, queue slots and engine resource leases are released')
except Exception:
    failures.append(traceback.format_exc())
    if window is not None:
        screenshot('failure')
finally:
    if window is not None:
        window.cancel_for_shutdown()
        try: wait(lambda: not window.workers, 'Workers remain after shutdown', 20)
        except Exception: failures.append(traceback.format_exc())
        window.close(); window.deleteLater(); QApplication.processEvents()
    if activity is not None:
        activity.close()
    if fixture is not None:
        fixture.terminate()
        try: fixture.communicate(timeout=5)
        except subprocess.TimeoutExpired:
            fixture.kill(); fixture.communicate(timeout=5)
    os.environ.clear(); os.environ.update(original_environment)
    for private in [OUT / 'fixture.key', OUT / 'fixture-ca.pem']:
        private.unlink(missing_ok=True)
    (OUT / 'WINDOWS-GUI-VALIDATION.json').write_text(json.dumps({'platform': sys.platform, 'qtBackend': 'windows',
        'engineMocked': False, 'metadataWorkerMocked': False, 'ownedMediaOnly': True, 'checks': checks, 'failures': failures}, ensure_ascii=False, indent=2), encoding='utf-8')
if failures:
    print('\n'.join(failures)); raise SystemExit(1)
print(f'{len(checks)} native Windows GUI checks passed.')
