"""Readiness only contacts the selected local engine; it never scans user data."""
import importlib.util
import io
import json
from pathlib import Path
import struct
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


HOST = load("status_test_host", "antivirus_host.py")
WINDOWS = load("status_test_windows", "windows_antivirus.py")


class AntivirusStatusTests(unittest.TestCase):
    request = {"version": 1, "action": "status", "requestId": "status-request-1"}

    def test_status_uses_same_selection_but_never_scans_or_opens_a_file(self):
        scan = Mock(side_effect=AssertionError("Readiness must not scan user data"))
        scanner = HOST.Scanner(scan, lambda: {"status": "ready", "engine": "Test engine"}, ["Test product"])
        with patch.object(HOST, "select_scanner", return_value=scanner), patch.object(HOST, "load_config", return_value={}), \
                patch.object(HOST, "validate_file", side_effect=AssertionError("No file path is allowed")):
            result = HOST.status_request(self.request)
        self.assertEqual(result["status"], "ready")
        self.assertEqual(result["requestId"], self.request["requestId"])
        self.assertEqual(result["products"], ["Test product"])
        self.assertIs(result["internalAvailable"], True)
        self.assertNotIn("sha256", result)
        scan.assert_not_called()

    def test_status_rejects_paths_commands_bool_versions_and_extra_fields(self):
        invalid = [{**self.request, "path": "/private/video.mp4"}, {**self.request, "command": "anything"},
                   {**self.request, "version": True}, {**self.request, "requestId": "bad id"}, None, []]
        with patch.object(HOST, "select_scanner") as select, patch.object(HOST, "internal_scanner") as builtin:
            for request in invalid:
                result = HOST.status_request(request)
                self.assertEqual(result["status"], "error")
                self.assertNotIn("internalAvailable", result)
            select.assert_not_called()
            builtin.assert_not_called()

    def test_builtin_capability_preserves_external_status_and_selected_engine(self):
        for status in ("ready", "unavailable", "error"):
            external = {"status": status, "engine": "Selected external engine", "message": "External result"}
            scanner = HOST.Scanner(Mock(), lambda: dict(external), ["Selected product"])
            with self.subTest(status=status), patch.object(HOST, "load_config", return_value={}), \
                    patch.object(HOST, "select_scanner", return_value=scanner):
                result = HOST.status_request(self.request)
            self.assertIs(result.pop("internalAvailable"), True)
            self.assertEqual(result, {"version": 1, "requestId": self.request["requestId"],
                                      **external, "products": ["Selected product"]})

    def test_builtin_capability_survives_missing_external_engine_config_error_and_timeout(self):
        scenarios = [("missing", None, None, "unavailable"),
                     ("config", ValueError("Invalid native host configuration."), None, "error"),
                     ("timeout", None, subprocess.TimeoutExpired(["status"], 15), "error")]
        for name, config_error, selection_error, expected in scenarios:
            with self.subTest(name=name), patch.object(HOST, "load_config", return_value={}, side_effect=config_error), \
                    patch.object(HOST, "select_scanner", return_value=None, side_effect=selection_error):
                result = HOST.status_request(self.request)
            self.assertEqual(result["status"], expected)
            self.assertIs(result["internalAvailable"], True)
            self.assertNotIn("sha256", result)

    def test_builtin_capability_requires_loadable_expected_companion_and_valid_scan_contract(self):
        fixtures = [("missing", None), ("syntax", "def broken(\n"),
                    ("import", "raise ImportError('unavailable dependency')\n"),
                    ("engine", "ENGINE='other-engine'\ndef scan_file(path, *, max_bytes): pass\n"),
                    ("missing function", "ENGINE='builtin-static-v1'\n"),
                    ("noncallable", "ENGINE='builtin-static-v1'\nscan_file=True\n"),
                    ("signature", "ENGINE='builtin-static-v1'\ndef scan_file(): pass\n")]
        scanner = HOST.Scanner(Mock(), lambda: {"status": "ready", "engine": "External ready"})
        for name, content in fixtures:
            with self.subTest(name=name), tempfile.TemporaryDirectory(prefix="mva-status-companion-") as directory:
                companion = Path(directory) / "internal_scan.py"
                if content is not None:
                    companion.write_text(content, encoding="utf-8")
                with patch.object(HOST, "__file__", str(Path(directory) / "antivirus_host.py")), \
                        patch.object(HOST, "load_config", return_value={}), patch.object(HOST, "select_scanner", return_value=scanner):
                    result = HOST.status_request(self.request)
                self.assertEqual(result["status"], "ready")
                self.assertEqual(result["engine"], "External ready")
                self.assertNotIn("internalAvailable", result)
        with tempfile.TemporaryDirectory(prefix="mva-status-companion-") as directory:
            (Path(directory) / "internal_scan.py").write_text(
                "ENGINE='builtin-static-v1'\ndef scan_file(path, *, max_bytes):\n"
                "    raise AssertionError('Readiness must not scan user data')\n", encoding="utf-8")
            with patch.object(HOST, "__file__", str(Path(directory) / "antivirus_host.py")), \
                    patch.object(HOST, "load_config", return_value={}), patch.object(HOST, "select_scanner", return_value=scanner):
                self.assertIs(HOST.status_request(self.request)["internalAvailable"], True)

    def test_missing_engine_and_timeout_cannot_claim_readiness(self):
        with patch.object(HOST, "load_config", return_value={}), patch.object(HOST, "select_scanner", return_value=None):
            self.assertEqual(HOST.status_request(self.request)["status"], "unavailable")
        with patch.object(HOST, "load_config", return_value={}), patch.object(HOST, "select_scanner", side_effect=subprocess.TimeoutExpired(["status"], 15)):
            self.assertEqual(HOST.status_request(self.request)["status"], "error")
        with patch.object(sys, "platform", "win32"), patch.object(HOST, "load_config", return_value={"scanner": "clamav"}), patch.object(HOST, "select_scanner", return_value=None):
            self.assertEqual(HOST.status_request(self.request)["engine"], "ClamAV")

    def test_native_status_framing_remains_bound_to_request(self):
        scanner = HOST.unavailable_scanner("Test engine", "Scanner unavailable")
        encoded = json.dumps(self.request).encode()
        source = io.BytesIO(struct.pack("<I", len(encoded)) + encoded)
        destination = io.BytesIO()
        with patch.object(HOST, "load_config", return_value={}), patch.object(HOST, "select_scanner", return_value=scanner):
            HOST.serve(source, destination)
        result = json.loads(destination.getvalue()[4:])
        self.assertEqual(result["requestId"], self.request["requestId"])
        self.assertEqual(result["status"], "unavailable")

    def test_real_native_process_accepts_pathless_status_and_returns_versioned_readiness(self):
        encoded = json.dumps(self.request).encode()
        result = subprocess.run([sys.executable, "-I", str(Path(__file__).with_name("antivirus_host.py"))],
                                input=struct.pack("<I", len(encoded)) + encoded, capture_output=True, timeout=60, check=True)
        self.assertGreater(len(result.stdout), 4)
        length = struct.unpack("<I", result.stdout[:4])[0]
        self.assertEqual(length, len(result.stdout) - 4)
        response = json.loads(result.stdout[4:])
        self.assertEqual(response["requestId"], self.request["requestId"])
        self.assertEqual(response["version"], 1)
        self.assertIn(response["status"], {"ready", "unavailable", "error"})
        self.assertIs(response["internalAvailable"], True)
        self.assertNotIn("sha256", response)

    def test_defender_status_checks_active_normal_mode_without_invoking_scan(self):
        for state, expected in [("Normal", "ready"), ("Passive", "unavailable")]:
            with self.subTest(state=state), patch.object(HOST, "run_tool", return_value=(0, json.dumps({"enabled": True, "service": True, "mode": state}))) as tool:
                result = HOST.defender_readiness(Path("powershell.exe"))
                self.assertEqual(result["status"], expected)
                self.assertEqual(tool.call_count, 1)
                self.assertNotIn("-Scan", str(tool.call_args))

    def test_clamav_status_only_invokes_version_and_requires_confirmed_execution(self):
        for response, code, expected in [("ClamAV 1.4.3/12345/date", 0, "ready"), ("", 0, "error"), ("ClamAV 1.4.3", 2, "error")]:
            with self.subTest(response=response), patch.object(HOST, "run_tool", return_value=(code, response)) as tool:
                self.assertEqual(HOST.clamav_readiness(Path("/usr/bin/clamscan"))["status"], expected)
                self.assertEqual(tool.call_args.args[0], ["/usr/bin/clamscan", "--version"])

    def test_amsi_readiness_initializes_and_releases_handles_without_scan(self):
        calls = []

        class Api:
            def AmsiInitialize(self, name, handle):
                calls.append("initialize"); handle._obj.value = 123; return 0

            def AmsiOpenSession(self, context, handle):
                calls.append("open"); handle._obj.value = 456; return 0

            def AmsiCloseSession(self, context, session):
                calls.append("close")

            def AmsiUninitialize(self, context):
                calls.append("uninitialize")

            def AmsiScanBuffer(self, *args):
                raise AssertionError("Readiness must not scan any data")

        self.assertEqual(WINDOWS.probe_amsi(Api())["status"], "ready")
        self.assertEqual(calls, ["initialize", "open", "close", "uninitialize"])
        with patch.object(WINDOWS, "_load_amsi", side_effect=OSError("API unavailable")):
            self.assertEqual(WINDOWS.probe_amsi()["status"], "unavailable")

    def test_amsi_readiness_failed_hresult_does_not_claim_ready(self):
        api = Mock()
        api.AmsiInitialize.return_value = -2147467259
        self.assertEqual(WINDOWS.probe_amsi(api)["status"], "unavailable")
        api.AmsiOpenSession.assert_not_called()
        api.AmsiScanBuffer.assert_not_called()


if __name__ == "__main__":
    unittest.main()
