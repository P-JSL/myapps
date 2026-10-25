"""Harmless local installer fixtures; no network installs or browser registry edits."""
from __future__ import annotations

import importlib.util
import json
import os
from pathlib import Path
import shlex
import stat
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("youtube_installer", Path(__file__).with_name("install_youtube.py"))
INSTALLER = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(INSTALLER)


class YouTubeInstallerTests(unittest.TestCase):
    def setUp(self):
        cache = Path(__file__).resolve().parent.parent / ".cache"
        cache.mkdir(exist_ok=True)
        self.temporary = tempfile.TemporaryDirectory(prefix="mva-youtube-install-", dir=cache)
        self.root = Path(self.temporary.name)

    def tearDown(self):
        self.temporary.cleanup()

    def executable(self, version="2.9.8", extra=""):
        path = self.root / "deno"
        path.write_text("#!/bin/sh\nprintf 'deno " + version + "\\nv8 fixture\\n'\n" + extra)
        path.chmod(0o700)
        return path

    def test_requirements_pin_only_pure_python_packages_with_hashes(self):
        text = Path(__file__).with_name("youtube-requirements.txt").read_text()
        entries = [line for line in text.splitlines() if line and not line.startswith("#")]
        self.assertEqual(len(entries), 2)
        self.assertEqual(entries[0], "yt-dlp==2026.10.21 --hash=sha256:94a3a3e2c423129d0bbd2f1be000c4171fa1226c29e251c84aff868f2851c247")
        self.assertEqual(entries[1], "yt-dlp-ejs==0.8.0 --hash=sha256:79300e5fca7f937a1eeede11f0456862c1b41107ce1d726871e0207424f4bdb4")

    def test_fixed_dependency_argv_has_no_config_plugins_or_extra_package_source(self):
        python, requirements = self.root / "python", self.root / "requirements.txt"
        command = INSTALLER.dependency_command(python, requirements)
        self.assertEqual(command[:5], [str(python), "-I", "-B", "-m", "pip"])
        for option in ("--isolated", "--require-hashes", "--no-deps", "--only-binary=:all:", "--no-input"):
            self.assertIn(option, command)
        self.assertEqual(command[command.index("--index-url") + 1], "https://pypi.org/simple")
        self.assertEqual(command[-2:], ["-r", str(requirements)])
        self.assertNotIn("--trusted-host", command)

    def test_manifest_allows_exact_extension_origins_only(self):
        path = self.root / "launch.sh"
        value = INSTALLER.manifest_data(path, ["b" * 32, "a" * 32, "b" * 32])
        self.assertEqual(value["name"], "com.myvideoapp.youtube")
        self.assertEqual(value["allowed_origins"], ["chrome-extension://" + "a" * 32 + "/", "chrome-extension://" + "b" * 32 + "/"])
        for ids in ([], ["x" * 32], ["a" * 31], ["a" * 32 + "/"], ["*"]):
            with self.subTest(ids=ids), self.assertRaises(ValueError):
                INSTALLER.manifest_data(path, ids)

    @unittest.skipIf(sys.platform == "win32", "Uses a harmless POSIX executable fixture")
    def test_deno_version_has_minimum_and_executes_no_user_arguments(self):
        path = self.executable()
        self.assertEqual(INSTALLER.validate_deno(str(path)), path)
        self.executable("2.3.0")
        self.assertEqual(INSTALLER.validate_deno(str(path)), path)
        self.executable("2.2.9")
        with self.assertRaises(ValueError):
            INSTALLER.validate_deno(str(path))
        self.executable("unknown")
        with self.assertRaises(ValueError):
            INSTALLER.validate_deno(str(path))

    def test_relative_parent_control_and_missing_deno_paths_are_rejected(self):
        for path in ("deno", "../deno", str(self.root / ".." / "deno"), str(self.root / "bad\npath")):
            with self.subTest(path=path), self.assertRaises(ValueError):
                INSTALLER.validate_deno(path)
        with self.assertRaises(FileNotFoundError):
            INSTALLER.validate_deno(str(self.root / "missing"))

    @unittest.skipIf(sys.platform == "win32", "POSIX ownership/execute fixture")
    def test_writable_or_nonexecuting_runtime_is_rejected_without_launch(self):
        path = self.executable()
        for mode in (0o600, 0o722, 0o777):
            path.chmod(mode)
            with self.subTest(mode=mode), patch.object(INSTALLER, "bounded_output") as run, self.assertRaises(ValueError):
                INSTALLER.validate_deno(str(path))
            run.assert_not_called()

    @unittest.skipIf(sys.platform == "win32", "POSIX parent permission fixture")
    def test_runtime_in_a_replaceable_parent_is_rejected_without_execution(self):
        path = self.executable()
        self.root.chmod(0o777)
        try:
            with patch.object(INSTALLER, "bounded_output") as run, self.assertRaises(ValueError):
                INSTALLER.validate_deno(str(path))
            run.assert_not_called()
        finally:
            self.root.chmod(0o700)

    @unittest.skipIf(sys.platform == "win32", "Symlink fixture needs no Windows privilege")
    def test_symlink_runtime_and_parent_install_path_are_rejected(self):
        actual = self.executable()
        linked = self.root / "linked"
        linked.symlink_to(actual)
        with self.assertRaises(ValueError):
            INSTALLER.safe_path(linked)
        directory = self.root / "parent"
        directory.symlink_to(self.root, target_is_directory=True)
        with self.assertRaises(ValueError):
            INSTALLER.safe_path(directory / "child" / "config.json")

    def test_atomic_private_write_preserves_existing_external_hardlink_content(self):
        original = self.root / "original"
        target = self.root / "youtube-config.json"
        original.write_text("keep")
        os.link(original, target)
        INSTALLER.write_private(target, '{"deno":"/fixed/deno"}\n')
        self.assertEqual(original.read_text(), "keep")
        self.assertEqual(json.loads(target.read_text()), {"deno": "/fixed/deno"})
        if sys.platform != "win32":
            self.assertEqual(stat.S_IMODE(target.stat().st_mode), 0o600)

    @unittest.skipIf(sys.platform == "win32", "POSIX quoting contract")
    def test_unix_launcher_quotes_fixed_paths_and_never_forwards_browser_arguments(self):
        python = self.root / "space and 'quotes'" / "python"
        host = self.root / "space and 'quotes'" / "youtube_host.py"
        text = INSTALLER.launcher_text(python, host)
        self.assertEqual(shlex.split(text.splitlines()[1]), ["exec", str(python), "-I", "-B", str(host)])
        self.assertNotIn("$@", text)

    def test_windows_launcher_rejects_shell_metacharacters_and_uses_isolation(self):
        with patch.object(INSTALLER.sys, "platform", "win32"):
            text = INSTALLER.launcher_text(Path("/fixture/python.exe"), Path("/fixture/youtube_host.py"))
            self.assertIn("DisableDelayedExpansion", text)
            self.assertIn(" -I -B ", text)
            for value in ('bad"path', "bad%path", "bad!path", "bad^path", "bad&path", "bad|path", "bad<path", "bad>path", "bad\npath"):
                with self.subTest(value=value), self.assertRaises(ValueError):
                    INSTALLER.launcher_text(Path(value), Path("safe"))

    def test_linux_locations_use_current_user_and_reject_relative_config(self):
        with patch.object(INSTALLER.Path, "home", return_value=self.root), patch.object(INSTALLER.sys, "platform", "linux"), patch.dict(os.environ, {"XDG_CONFIG_HOME": str(self.root / ".config")}):
            base, paths = INSTALLER.locations("both")
            self.assertEqual(base, self.root / ".local/share/my-video-app-youtube")
            self.assertEqual(paths, [self.root / ".config/google-chrome/NativeMessagingHosts/com.myvideoapp.youtube.json", self.root / ".config/chromium/NativeMessagingHosts/com.myvideoapp.youtube.json"])
        with patch.object(INSTALLER.sys, "platform", "linux"), patch.dict(os.environ, {"XDG_CONFIG_HOME": "relative"}), self.assertRaises(ValueError):
            INSTALLER.locations("chrome")

    def test_unsupported_browser_is_rejected(self):
        with self.assertRaises(ValueError):
            INSTALLER.locations("custom")

    def test_uninstall_removes_only_fixed_host_files_and_preserves_venv_and_unrelated_data(self):
        base = self.root / "host"
        base.mkdir()
        manifest = self.root / "com.myvideoapp.youtube.json"
        manifest.write_text("{}")
        for name in INSTALLER.OWN_FILES:
            (base / name).write_text("fixed")
        (base / "venv").mkdir()
        (base / "unrelated.txt").write_text("keep")
        with patch.object(INSTALLER, "locations", side_effect=lambda browser: (base, [manifest] if browser == "chrome" else [manifest, self.root / "missing.json"])):
            INSTALLER.uninstall("chrome")
        self.assertFalse(manifest.exists())
        self.assertEqual({item.name for item in base.iterdir()}, {"unrelated.txt", "venv"})
        self.assertEqual((base / "unrelated.txt").read_text(), "keep")

    def installed_fixture(self, fail=False):
        base = self.root / "installed"
        manifest = self.root / "browser" / "com.myvideoapp.youtube.json"
        deno = self.root / "deno"
        source = Path(INSTALLER.__file__).absolute().with_name("youtube_host.py")
        original_read = Path.read_text

        def read(path, *args, **kwargs):
            return "# Harmless host fixture\n" if path == source else original_read(path, *args, **kwargs)

        def create(_path):
            python = INSTALLER.python_for(base)
            python.parent.mkdir(parents=True)
            python.write_text("# Harmless Python fixture\n")

        with patch.object(INSTALLER, "locations", return_value=(base, [manifest])), \
                patch.object(INSTALLER, "validate_deno", return_value=deno), \
                patch.object(INSTALLER, "dependency_check") as check, \
                patch.object(INSTALLER, "registry_update") as registry, \
                patch.object(INSTALLER.venv, "EnvBuilder") as builder, \
                patch.object(INSTALLER.subprocess, "run") as run, \
                patch.object(INSTALLER.Path, "read_text", read), \
                patch.object(sys, "argv", ["install_youtube.py", "--extension-id", "a" * 32, "--deno", str(deno)]):
            builder.return_value.create.side_effect = create
            if fail:
                run.side_effect = subprocess.CalledProcessError(1, ["pip"])
                with self.assertRaises(subprocess.CalledProcessError):
                    INSTALLER.main()
                self.assertFalse(manifest.exists())
                self.assertFalse((base / "youtube-config.json").exists())
                self.assertFalse((base / "youtube_host.py").exists())
                check.assert_not_called()
                registry.assert_not_called()
            else:
                self.assertEqual(INSTALLER.main(), 0)
                run.assert_called_once()
                self.assertFalse(run.call_args.kwargs["shell"])
                self.assertEqual(run.call_args.kwargs["timeout"], 300)
                self.assertNotIn("env", run.call_args.kwargs, "Inherited proxy/CA must remain available")
                builder.assert_called_once_with(with_pip=True, symlinks=False)
                check.assert_called_once_with(INSTALLER.python_for(base))
        return base, manifest, deno

    def test_install_registers_only_after_dependency_success_and_keeps_private_config(self):
        base, manifest, deno = self.installed_fixture()
        self.assertEqual(json.loads((base / "youtube-config.json").read_text()), {"deno": str(deno)})
        value = json.loads(manifest.read_text())
        self.assertEqual(value["name"], "com.myvideoapp.youtube")
        self.assertEqual(value["allowed_origins"], ["chrome-extension://" + "a" * 32 + "/"])
        self.assertEqual((base / "youtube_host.py").read_text(), "# Harmless host fixture\n")
        self.assertTrue((base / "youtube-requirements.txt").exists())
        if sys.platform != "win32":
            self.assertEqual(stat.S_IMODE(base.stat().st_mode), 0o700)
            self.assertEqual(stat.S_IMODE((base / "youtube-config.json").stat().st_mode), 0o600)

    def test_failed_dependency_install_does_not_activate_new_host_or_registration(self):
        self.installed_fixture(fail=True)

    @unittest.skipIf(sys.platform == "win32", "POSIX subprocess fixtures")
    def test_runtime_probe_output_and_timeout_are_bounded(self):
        self.assertEqual(INSTALLER.bounded_output([sys.executable, "-c", "print('ok')"]), "ok\n")
        with self.assertRaises(ValueError):
            INSTALLER.bounded_output([sys.executable, "-c", "print('x'*100000)"], limit=100)
        with self.assertRaises(ValueError):
            INSTALLER.bounded_output([sys.executable, "-c", "import time; time.sleep(2)"], timeout=0.05)


if __name__ == "__main__":
    unittest.main()
