"""Exercise the portable packager with tiny archives, never downloaded binaries."""

import importlib.util
from io import BytesIO
import hashlib
import json
from pathlib import Path
import stat
import struct
import tempfile
import unittest
from unittest.mock import patch
import zipfile


SCRIPT = Path(__file__).resolve().parents[1] / "scripts/build-desktop.py"
spec = importlib.util.spec_from_file_location("desktop_bundle", SCRIPT)
bundle = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bundle)


def windows_pe(machine=0x8664):
    data = bytearray(128)
    data[:2] = b"MZ"
    struct.pack_into("<I", data, 60, 64)
    data[64:68] = b"PE\0\0"
    struct.pack_into("<H", data, 68, machine)
    struct.pack_into("<H", data, 88, 0x20B)
    return bytes(data)


class DesktopBundleTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.cache = self.root / "cache"
        self.cache.mkdir()
        self.desktop = self.root / "desktop"
        (self.desktop / "launcher").mkdir(parents=True)
        (self.desktop / "launcher/MyVideoApp.exe").write_bytes(windows_pe())
        (self.root / "package.json").write_text('{"version":"1.17.0"}')
        for name in ("main.py", "engine.py", "README.ko.md", "THIRD_PARTY_NOTICES.md"):
            (self.desktop / name).write_text("# " + name, encoding="utf-8")
        self.lock = {"schema": 1, "version": "1.17.0", "platform": "win32-x64", "inputs": [], "notices": []}
        self.make_input("python", "3.13.17", "python.nupkg", {
            "tools/python.exe": windows_pe(), "tools/pythonw.exe": windows_pe(),
            "tools/LICENSE.txt": b"Python license", "tools/python313.dll": windows_pe(),
            "tools/vcruntime140.dll": windows_pe(), "tools/Lib/os.py": b"# stdlib",
            "tools/Lib/ssl.py": b"# ssl", "tools/DLLs/_ssl.pyd": windows_pe(),
            "python.nuspec": b"original publisher metadata",
        })
        self.make_input("yt-dlp", "2026.10.21", "yt_dlp.whl", {
            "yt_dlp/__init__.py": b"# downloader", "yt_dlp-2026.10.21.dist-info/licenses/LICENSE": b"Unlicense",
            "yt_dlp-2026.10.21.data/data/share/man/man1/yt-dlp.1": b"manual",
        })
        self.make_input("yt-dlp-ejs", "0.8.0", "yt_dlp_ejs.whl", {"yt_dlp_ejs/__init__.py": b"# EJS"})
        self.make_input("deno", "2.9.8", "deno.whl", {
            "deno-2.9.8.data/scripts/deno.exe": windows_pe(), "deno-2.9.8.dist-info/licenses/LICENSE": b"MIT",
        })
        self.make_input("pyside6-essentials", "6.12.0", "pyside6_essentials.whl", {
            "PySide6/__init__.py": b"# Qt",
            **{"PySide6/" + name: windows_pe() for name in (
                "QtCore.pyd", "QtGui.pyd", "QtWidgets.pyd", "Qt6Core.dll", "Qt6Gui.dll", "Qt6Widgets.dll", "msvcp140.dll", "plugins/platforms/qwindows.dll")},
            "pyside6_essentials-6.12.0.dist-info/METADATA": b"License: LGPL-3.0-only",
            "PySide6/qml/Unused/module.qml": b"optional QML component",
            "PySide6/plugins/sqldrivers/qsqloci.dll": windows_pe(),
            "PySide6/plugins/imageformats/qpdf.dll": windows_pe(),
        })
        self.make_input("shiboken6", "6.12.0", "shiboken6.whl", {"shiboken6/__init__.py": b"# bindings"})
        self.make_input("ffmpeg", "9.0.2-36-g6882969ce9", "ffmpeg-test.zip", {
            "ffmpeg-test/bin/ffmpeg.exe": windows_pe(), "ffmpeg-test/bin/ffprobe.exe": windows_pe(),
            "ffmpeg-test/bin/ffplay.exe": windows_pe(), "ffmpeg-test/LICENSE.txt": b"LGPL3",
            "ffmpeg-test/doc/ffmpeg.html": b"all original docs",
        })
        self.lock["inputs"][-1]["archiveRoot"] = "ffmpeg-test"
        self.lock_path = self.desktop / "dependencies-lock.json"
        self.write_lock()

    def make_input(self, identifier, version, filename, members):
        path = self.cache / filename
        with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            for name, content in members.items():
                archive.writestr(name, content)
        host = "api.nuget.org" if identifier == "python" else "github.com" if identifier == "ffmpeg" else "files.pythonhosted.org"
        item = {"id": identifier, "version": version, "filename": filename,
                "url": f"https://{host}/pinned/{filename}", "size": path.stat().st_size,
                "sha256": bundle.sha256_file(path), "license": "preserved original notices"}
        self.lock["inputs"].append(item)

    def write_lock(self):
        self.lock_path.write_bytes(bundle.canonical_json(self.lock))

    def replace_archive(self, identifier, members):
        item = next(item for item in self.lock["inputs"] if item["id"] == identifier)
        path = self.cache / item["filename"]
        with zipfile.ZipFile(path, "w") as archive:
            for name, data in members.items():
                archive.writestr(name, data)
        item.update(size=path.stat().st_size, sha256=bundle.sha256_file(path))
        self.write_lock()

    def build(self, name="app.zip"):
        return bundle.build_bundle(self.root, self.lock_path, self.cache, self.root / name, offline=True)

    def test_offline_bundle_is_reproducible_complete_and_has_verifiable_manifest(self):
        (self.desktop / "theme.py").write_text("# dynamic source module")
        (self.desktop / "tests").mkdir()
        (self.desktop / "tests/test_private.py").write_text("never ship tests")
        (self.desktop / "test_gui.py").write_text("never ship GUI test harness")
        (self.desktop / "settings.json").write_text('{"token":"never ship settings"}')
        (self.desktop / ".env.py").write_text("never ship hidden files")
        (self.desktop / "__pycache__").mkdir()
        (self.desktop / "__pycache__/cache.py").write_text("never ship cache")
        with patch.object(bundle.urllib.request, "build_opener", side_effect=AssertionError("offline network access")):
            first = self.build()
            second = self.build("repeat.zip")
        self.assertEqual(first["sha256"], second["sha256"])
        with zipfile.ZipFile(first["output"]) as archive:
            self.assertIsNone(archive.testzip())
            names = set(archive.namelist())
            manifest = json.loads(archive.read("MyVideoApp/APPMANIFEST.json"))
            self.assertEqual(manifest["version"], "1.17.0")
            self.assertEqual(names - {"MyVideoApp/APPMANIFEST.json"}, {bundle.PREFIX + n for n in manifest["files"]})
            for name, digest in manifest["files"].items():
                self.assertEqual(hashlib.sha256(archive.read(bundle.PREFIX + name)).hexdigest(), digest, name)
            self.assertIn("desktop/theme.py", manifest["files"])
            self.assertIn("My Video App.exe", manifest["files"])
            self.assertIn("runtime/ffmpeg/ffprobe.exe", manifest["files"])
            self.assertIn("licenses/ffmpeg/doc/ffmpeg.html", manifest["files"])
            self.assertIn("runtime/python/Lib/site-packages/pyside6_essentials-6.12.0.dist-info/METADATA", manifest["files"])
            self.assertFalse(any("ffplay" in n or "settings.json" in n or "/tests/" in n or "test_gui.py" in n or "__pycache__" in n or ".env" in n or "/qml/" in n or "qsqloci.dll" in n or "qpdf.dll" in n for n in names))
            self.assertIn(b'"%~dp0runtime\\python\\pythonw.exe" -I -B "%~dp0desktop\\main.py"', archive.read("MyVideoApp/My Video App.cmd"))

    def test_corrupted_cached_input_fails_before_creating_output(self):
        path = self.cache / self.lock["inputs"][0]["filename"]
        path.write_bytes(b"corrupted")
        with self.assertRaisesRegex(ValueError, "SHA-256/size mismatch"):
            self.build()
        self.assertFalse((self.root / "app.zip").exists())

    def test_missing_input_offline_does_not_download(self):
        (self.cache / self.lock["inputs"][0]["filename"]).unlink()
        with patch.object(bundle.urllib.request, "build_opener", side_effect=AssertionError("network")):
            with self.assertRaisesRegex(ValueError, "offline cache"):
                self.build()

    def test_earlier_verified_runtime_cache_can_be_reused(self):
        fallback = self.root / ".cache/youtube-offline-runtime"
        fallback.mkdir(parents=True)
        item = self.lock["inputs"][0]
        (self.cache / item["filename"]).rename(fallback / item["filename"])
        self.assertEqual(bundle.acquire(item, self.cache, True, fallback), fallback / item["filename"])

    def test_traversal_windows_aliases_and_case_collisions_are_rejected(self):
        for name in ("../escape", "C:/escape", "/absolute", "directory\\file", "folder/CON.txt", "folder/file.", "folder/file ", "file:stream"):
            with self.subTest(name=name), self.assertRaises(ValueError):
                bundle.safe_name(name)
        self.replace_archive("yt-dlp", {"yt_dlp/__init__.py": b"ok", "yt_dlp/../escape.py": b"bad"})
        with self.assertRaisesRegex(ValueError, "Unsafe archive path"):
            self.build()
        self.replace_archive("yt-dlp", {"yt_dlp/__init__.py": b"ok", "YT_DLP/__INIT__.PY": b"bad"})
        with self.assertRaisesRegex(ValueError, "Duplicate archive path"):
            self.build()

    def test_symlink_archives_and_application_sources_are_rejected(self):
        memory = BytesIO()
        with zipfile.ZipFile(memory, "w") as archive:
            info = zipfile.ZipInfo("symlink")
            info.create_system = 3
            info.external_attr = (stat.S_IFLNK | 0o777) << 16
            archive.writestr(info, "target")
        with zipfile.ZipFile(BytesIO(memory.getvalue())) as archive:
            with self.assertRaisesRegex(ValueError, "file type"):
                list(bundle.archive_members(archive))
        (self.desktop / "theme.py").symlink_to(self.desktop / "main.py")
        with self.assertRaisesRegex(ValueError, "Symlink in desktop"):
            self.build()

    def test_missing_platform_plugin_is_rejected(self):
        item = next(i for i in self.lock["inputs"] if i["id"] == "pyside6-essentials")
        with zipfile.ZipFile(self.cache / item["filename"]) as archive:
            members = {n: archive.read(n) for n in archive.namelist() if not n.endswith("qwindows.dll")}
        self.replace_archive(item["id"], members)
        with self.assertRaisesRegex(ValueError, "archives are incomplete"):
            self.build()

    def test_windows_architecture_is_checked_without_execution(self):
        with self.assertRaisesRegex(ValueError, r"PE32\+ AMD64"):
            bundle.validate_pe(BytesIO(windows_pe(0x14C)), "x86 executable")
        (self.desktop / "launcher/MyVideoApp.exe").write_bytes(windows_pe(0x14C))
        with self.assertRaisesRegex(ValueError, r"PE32\+ AMD64"):
            self.build()

    def test_version_and_matching_qt_pair_are_required(self):
        self.lock["inputs"][5]["version"] = "6.11.0"
        self.write_lock()
        with self.assertRaisesRegex(ValueError, "versions must match"):
            self.build()
        self.lock["inputs"][5]["version"] = "6.12.0"
        self.write_lock()
        (self.root / "package.json").write_text('{"version":"1.16.0"}')
        with self.assertRaisesRegex(ValueError, "versions differ"):
            self.build()

    def test_only_official_https_download_and_redirect_hosts_are_allowed(self):
        for url in ("http://files.pythonhosted.org/file", "https://example.com/file", "https://user@github.com/file", "https://github.com:444/file", "https://github.com/file?mutable=true"):
            with self.subTest(url=url), self.assertRaises(ValueError):
                bundle.official_url(url)
        bundle.official_url("https://release-assets.githubusercontent.com/file?sig=preserved", redirect=True)
        with self.assertRaises(ValueError):
            bundle.official_url("https://release-assets.githubusercontent.com/file")


if __name__ == "__main__":
    unittest.main()
