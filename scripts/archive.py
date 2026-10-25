"""Deterministic source/install archives; native helpers use explicit file lists."""
from pathlib import Path
from zipfile import ZipFile, ZipInfo, ZIP_DEFLATED
import hashlib
import shutil

root = Path.cwd()
out = root / 'artifacts'
out.mkdir(exist_ok=True)
# Failed packaging must not leave an old checksum manifest implying success.
(out / 'SHA256SUMS').unlink(missing_ok=True)
antivirus_files = {'README.ko.md', 'antivirus_host.py', 'windows_antivirus.py', 'internal_scan.py', 'install.py'}
youtube_files = {'YOUTUBE.ko.md', 'youtube_host.py', 'install_youtube.py', 'youtube-requirements.txt'}
packages = [
    ('my-video-app-extension.zip', root / 'dist', 'my-video-app', None),
    ('my-video-app-source.zip', root, 'my-video-app-source', None),
    ('my-video-app-antivirus-helper.zip', root / 'native', 'my-video-app-antivirus-helper', antivirus_files),
    ('my-video-app-youtube-helper.zip', root / 'native', 'my-video-app-youtube-helper', youtube_files),
]
source_exclusions = {'.git', 'node_modules', 'dist', 'dist-compat', 'artifacts', 'test-results', '.cache', '.venv', 'venv'}
private_configs = {'native/config.json', 'native/youtube-config.json'}
for name, source, prefix, allowed in packages:
    included = set()
    with ZipFile(out / name, 'w', compression=ZIP_DEFLATED, compresslevel=9) as archive:
        for path in sorted(source.rglob('*')):
            relative = path.relative_to(source)
            if source == root and (relative.parts[0] in source_exclusions or relative.as_posix() in private_configs):
                continue
            if '__pycache__' in relative.parts or path.suffix in {'.log', '.pyc', '.eml', '.pem', '.key', '.p12', '.pfx'}:
                continue
            if allowed is not None and relative.as_posix() not in allowed:
                continue
            if path.is_symlink():
                raise ValueError('Symbolic links are not allowed in packages: ' + str(relative))
            if not path.is_file():
                continue
            info = ZipInfo(prefix + '/' + relative.as_posix(), date_time=(2026, 10, 18, 0, 0, 0))
            info.compress_type = ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            archive.writestr(info, path.read_bytes(), compresslevel=9)
            included.add(relative.as_posix())
    if allowed is not None and included != allowed:
        raise ValueError('Required native helper files are missing: ' + ', '.join(sorted(allowed - included)))
    print(name, (out / name).stat().st_size, 'bytes')

aliases = {'vdh-typescript-upscale-extension.zip': 'my-video-app-extension.zip',
           'vdh-typescript-upscale-source.zip': 'my-video-app-source.zip'}
for alias, name in aliases.items():
    shutil.copyfile(out / name, out / alias)
lines = []
for name in [item[0] for item in packages] + list(aliases):
    lines.append(hashlib.sha256((out / name).read_bytes()).hexdigest() + '  ' + name)
(out / 'SHA256SUMS').write_text('\n'.join(lines) + '\n')
print('\n'.join(lines))
