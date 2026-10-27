# Desktop runtime notices

My Video App uses the following unmodified third-party runtimes. The exact
download URLs, versions, SHA-256 hashes and corresponding-source/build URLs are
recorded in `licenses/dependencies-lock.json` and `APPMANIFEST.json`.

| Component | Version | License / included notices |
| --- | --- | --- |
| CPython | 3.13.17 | PSF-2.0 and the notices in `runtime/python/LICENSE.txt`; original NuGet metadata is in `licenses/python-package/`. |
| yt-dlp | 2026.10.21 | Unlicense; original package metadata and license files remain in `runtime/python/Lib/site-packages/yt_dlp-*.dist-info/`. |
| yt-dlp EJS | 0.8.0 | Unlicense, MIT and ISC; all wheel metadata/notices are preserved beside the package. |
| Deno | 2.9.8 | MIT; original distribution metadata/license files are in `licenses/deno/`. |
| PySide6 Essentials and shiboken6 | 6.12.0 | Open-source LGPL-3.0-only, GPL-2.0-only or GPL-3.0-only, as stated by the original wheel METADATA. Original license files/dist-info remain beside the packages. |
| Qt libraries and plugins shipped by PySide6 | 6.12.0 | Applicable Qt and third-party licenses; see the Qt source trees and original wheel notices. LGPL-3.0, GPL-3.0 and GPL-2.0 texts are supplied in `licenses/qt/`. |
| FFmpeg / ffprobe, BtbN stable 9.0 branch | 9.0.2-36-g6882969ce9 | LGPL-3.0-or-later and included third-party licenses. Original `LICENSE.txt`, documentation and presets are in `licenses/ffmpeg/`. |

Qt for Python is copyright The Qt Company Ltd. and its contributors. This
application uses the open-source Qt license option. Qt/PySide6/shiboken libraries
are loaded dynamically from `runtime/python/Lib/site-packages/`; users can replace
them with compatible modified versions. This distribution does not restrict
modification of those libraries or reverse engineering to debug modifications.
The application Python source is shipped in `desktop/` and can be run with the
included Python interpreter using `My Video App.cmd`.

Corresponding Qt for Python source and build instructions:
<https://github.com/pyside/pyside-setup/tree/v6.12.0>.
Qt source and module references:
<https://code.qt.io/cgit/qt/qt5.git/tree/?h=v6.12.0> and
<https://github.com/qt/qtbase/tree/v6.12.0>.
The upstream Qt licensing documentation is at
<https://doc.qt.io/qt-6/licensing.html>.

FFmpeg and ffprobe are separate executables, invoked as subprocesses; this
application does not link their code. Their corresponding source is at
<https://github.com/FFmpeg/FFmpeg/tree/6882969ce9>.
The exact BtbN build recipes, patches and dependency build definitions are at
<https://github.com/BtbN/FFmpeg-Builds/tree/autobuild-2026-10-25-13-00>.
The original build README is included as `licenses/ffmpeg/BUILD-README.md`.
Only `ffmpeg.exe` and `ffprobe.exe` are included; the upstream ffplay program is
omitted. The LGPL and GPL texts needed with this LGPL build are also included
in `licenses/qt/`.

Other corresponding-source repositories:
<https://github.com/python/cpython>, <https://github.com/yt-dlp/yt-dlp>,
<https://github.com/yt-dlp/ejs> and <https://github.com/denoland/deno>.
All original package metadata and third-party notices distributed in the pinned
inputs are retained. Unused QML content and optional designer, QML-debugging,
database, virtual-keyboard and PDF-image plugins are omitted; these can otherwise
require separate Qt Addons or database client installations. The exact omitted
groups are recorded in `APPMANIFEST.json`. This Qt Widgets application uses none
of them. Wheel data files that are unnecessary for execution are
retained under `licenses/<component>/wheel-data/`.
