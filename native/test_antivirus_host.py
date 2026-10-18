"""Harmless scanner fixtures exercise the native bridge without real malware."""
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import struct
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("antivirus_host", Path(__file__).with_name("antivirus_host.py"))
HOST = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(HOST)


class AntivirusHostTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="mva-host-unit-")
        self.root = Path(self.directory.name).resolve()
        self.video = self.root / "video.mp4"
        self.payload = b"Harmless video download test fixture\n"
        self.video.write_bytes(self.payload)
        self.request = {"version": 1, "action": "scan", "requestId": "test-request-1", "path": str(self.video)}
        self.config_patch = patch.object(HOST, "CONFIG_PATH", self.root / "absent-config.json")
        self.config_patch.start()

    def tearDown(self):
        self.config_patch.stop()
        self.directory.cleanup()

    def fake_clamav(self, output: str, code: int) -> Path:
        executable = self.root / "clamscan"
        expression = "sys.argv[-1] + ': OK'" if output == "__CLEAN__" else repr(output)
        executable.write_text("#!" + sys.executable + "\nimport sys\nprint(" + expression + ")\nsys.exit(" + str(code) + ")\n", encoding="utf-8")
        executable.chmod(0o700)
        return executable

    def test_clean_scan_hashes_same_bytes_and_removes_private_snapshot(self):
        snapshots = []

        def scanner(snapshot):
            snapshots.append(snapshot)
            self.assertEqual(snapshot.read_bytes(), self.payload)
            self.assertNotEqual(snapshot, self.video)
            self.assertEqual(snapshot.stat().st_mode & 0o077, 0)
            return {"status": "clean", "engine": "test-local-engine"}

        with patch.object(HOST, "select_scanner", return_value=scanner):
            result = HOST.scan_request(self.request)
        self.assertEqual(result["status"], "clean")
        self.assertEqual(result["sha256"], hashlib.sha256(self.payload).hexdigest())
        self.assertEqual(result["size"], len(self.payload))
        self.assertEqual(result["requestId"], "test-request-1")
        self.assertFalse(snapshots[0].exists())
        self.assertEqual(self.video.read_bytes(), self.payload)

    def test_real_fake_clamav_subprocess_detection_is_not_removed(self):
        executable = self.fake_clamav("download.mp4: Harmless.Test.Signature FOUND", 1)
        with patch.object(HOST, "clamav_path", return_value=executable):
            result = HOST.scan_request(self.request)
        self.assertEqual(result["status"], "infected")
        self.assertEqual(result["threats"], ["Harmless.Test.Signature"])
        self.assertEqual(result["sha256"], hashlib.sha256(self.payload).hexdigest())
        self.assertEqual(self.video.read_bytes(), self.payload)

    def test_real_fake_clamav_clean_exit(self):
        executable = self.fake_clamav("__CLEAN__", 0)
        result = HOST.scan_clamav(executable, self.video)
        self.assertEqual(result, {"status": "clean", "engine": "ClamAV"})

    def test_real_fake_clamav_error_and_limit_never_become_clean(self):
        for output, code in [("ERROR: database missing", 2), ("WARNING: file skipped", 0),
                             ("/tmp/download.mp4: partial scan ERROR", 0), ("", 0),
                             ("download.mp4: Heuristics.Limits.Exceeded.MaxFileSize FOUND", 1)]:
            executable = self.fake_clamav(output, code)
            self.assertEqual(HOST.scan_clamav(executable, self.video)["status"], "error")

    def test_scanner_output_is_bounded(self):
        executable = self.fake_clamav("x" * (HOST.MAX_OUTPUT + 1), 0)
        with self.assertRaises(RuntimeError):
            HOST.scan_clamav(executable, self.video)

    def test_real_scanner_timeout_terminates_process(self):
        with self.assertRaises(subprocess.TimeoutExpired):
            HOST.run_tool([sys.executable, "-c", "import time; time.sleep(5)"], timeout=0.05)

    def test_unavailable_is_explicit_and_has_no_hash(self):
        with patch.object(HOST, "select_scanner", return_value=None):
            result = HOST.scan_request(self.request)
        self.assertEqual(result["status"], "unavailable")
        self.assertNotIn("sha256", result)

    def test_file_mutation_during_scan_rejects_clean_verdict(self):
        def scanner(snapshot):
            self.video.write_bytes(b"changed bytes")
            return {"status": "clean", "engine": "test"}

        with patch.object(HOST, "select_scanner", return_value=scanner):
            result = HOST.scan_request(self.request)
        self.assertEqual(result["status"], "error")
        self.assertNotIn("sha256", result)

    def test_links_directories_relative_and_traversal_are_rejected(self):
        link = self.root / "linked.mp4"
        link.symlink_to(self.video)
        for candidate in [str(link), str(self.root), "relative.mp4", str(self.root / ".." / self.root.name / "video.mp4")]:
            request = {**self.request, "path": candidate}
            self.assertEqual(HOST.scan_request(request)["status"], "error")
        linked_directory = self.root / "linked-directory"
        linked_directory.symlink_to(self.root, target_is_directory=True)
        self.assertEqual(HOST.scan_request({**self.request, "path": str(linked_directory / "video.mp4")})["status"], "error")

    def test_invalid_actions_ids_and_schema_cannot_run_scanner(self):
        requests = [{**self.request, "action": "run"}, {**self.request, "requestId": "bad id"},
                    {**self.request, "version": True}, {**self.request, "command": "echo test"}, [], None]
        with patch.object(HOST, "select_scanner") as scanner:
            for request in requests:
                self.assertEqual(HOST.scan_request(request)["status"], "error")
            scanner.assert_not_called()

    def test_timeout_never_maps_to_clean(self):
        def scanner(snapshot):
            raise subprocess.TimeoutExpired(["local-scanner"], 120)

        with patch.object(HOST, "select_scanner", return_value=scanner):
            result = HOST.scan_request(self.request)
        self.assertEqual(result["status"], "error")
        self.assertIn("timed out", result["message"])

    def test_native_framing_roundtrip_and_oversize_rejection(self):
        encoded = json.dumps(self.request).encode()
        input_stream = io.BytesIO(struct.pack("<I", len(encoded)) + encoded)
        output = io.BytesIO()
        with patch.object(HOST, "select_scanner", return_value=None):
            HOST.serve(input_stream, output)
        payload = output.getvalue()
        length = struct.unpack("<I", payload[:4])[0]
        result = json.loads(payload[4:])
        self.assertEqual(length, len(payload) - 4)
        self.assertEqual(result["requestId"], self.request["requestId"])
        self.assertEqual(result["status"], "unavailable")
        output = io.BytesIO()
        HOST.serve(io.BytesIO(struct.pack("<I", HOST.MAX_MESSAGE + 1)), output)
        self.assertEqual(json.loads(output.getvalue()[4:])["status"], "error")

    def test_truncated_and_non_json_frames_report_errors(self):
        for raw in (b"\x01", struct.pack("<I", 20) + b"{}", struct.pack("<I", 1) + b"x"):
            output = io.BytesIO()
            HOST.serve(io.BytesIO(raw), output)
            self.assertEqual(json.loads(output.getvalue()[4:])["status"], "error")

    def test_defender_cloud_policy_is_not_changed_and_blocks_scan(self):
        with patch.object(HOST, "run_tool", return_value=(0, '{"maps":2,"samples":1,"enabled":true}')) as tool:
            result = HOST.scan_defender(Path("powershell.exe"), Path("MpCmdRun.exe"), self.video)
        self.assertEqual(result["status"], "unavailable")
        self.assertEqual(tool.call_count, 1)
        self.assertNotIn("Set-MpPreference", str(tool.call_args))

    def test_defender_ambiguous_exit_never_maps_to_clean(self):
        with patch.object(HOST, "run_tool", side_effect=[(0, '{"maps":0,"samples":2,"enabled":true}'), (2, "Scan failed")]) as tool:
            result = HOST.scan_defender(Path("powershell.exe"), Path("MpCmdRun.exe"), self.video)
        self.assertEqual(result["status"], "error")
        self.assertIn("-DisableRemediation", tool.call_args.args[0])

    @unittest.skipIf(sys.platform == "win32", "POSIX executable fixture")
    def test_installer_registers_exact_id_per_user_and_uninstalls_own_files(self):
        fake_home = self.root / "home"
        fake_home.mkdir()
        environment = {**os.environ, "HOME": str(fake_home), "XDG_CONFIG_HOME": str(fake_home / "config")}
        installer = Path(__file__).with_name("install.py")
        command = [sys.executable, str(installer), "--extension-id", "a" * 32]
        result = subprocess.run(command, env=environment, capture_output=True, text=True, check=False)
        self.assertEqual(result.returncode, 0, result.stderr)
        if sys.platform == "darwin":
            manifest = fake_home / "Library/Application Support/Google/Chrome/NativeMessagingHosts/com.myvideoapp.antivirus.json"
        else:
            manifest = fake_home / "config/google-chrome/NativeMessagingHosts/com.myvideoapp.antivirus.json"
        details = json.loads(manifest.read_text())
        self.assertEqual(details["allowed_origins"], ["chrome-extension://" + "a" * 32 + "/"])
        self.assertTrue(Path(details["path"]).is_file())
        self.assertNotIn("$@", Path(details["path"]).read_text())
        result = subprocess.run([sys.executable, str(installer), "--uninstall"], env=environment, capture_output=True, text=True, check=False)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(manifest.exists())
        self.assertFalse(Path(details["path"]).exists())


if __name__ == "__main__":
    unittest.main()
