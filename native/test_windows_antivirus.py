"""Windows integration contract tests use harmless data and API doubles on any OS."""
import importlib.util
import ctypes
import json
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch


def load_module(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


HOST = load_module("windows_selection_test_host", "antivirus_host.py")
WINDOWS = load_module("windows_antivirus_contract_test", "windows_antivirus.py")


class FakeAmsi:
    """Implements the public AMSI call shape, not a malware-detection engine."""

    def __init__(self, verdict=0, failure=None, hresult=0x80004005, missing_handle=None):
        self.verdict = verdict
        self.failure = failure
        self.hresult = hresult
        self.missing_handle = missing_handle
        self.calls = []
        self.buffers = []

    def AmsiInitialize(self, name, context):
        self.calls.append("initialize")
        context._obj.value = 0 if self.missing_handle == "context" else 123
        return self.hresult if self.failure == "initialize" else 0

    def AmsiOpenSession(self, context, session):
        self.calls.append("open")
        session._obj.value = 0 if self.missing_handle == "session" else 456
        return self.hresult if self.failure == "open" else 0

    def AmsiScanBuffer(self, context, buffer, length, name, session, result):
        self.calls.append("scan")
        self.buffers.append((bytes(buffer), length, name))
        if self.verdict is not None:
            result._obj.value = self.verdict
        return self.hresult if self.failure == "scan" else 0

    def AmsiCloseSession(self, context, session):
        self.calls.append("close")

    def AmsiUninitialize(self, context):
        self.calls.append("uninitialize")


class WindowsInventoryContractTests(unittest.TestCase):
    def inventory(self, products=None, providers=None):
        return {"status": "ok", "products": products if products is not None else [
            {"name": "Microsoft Defender Antivirus", "state": "on"}],
            "providers": providers if providers is not None else []}

    def discover(self, value, code=0):
        tool = Mock(return_value=(code, value if isinstance(value, str) else json.dumps(value)))
        return WINDOWS.discover_windows_antivirus(tool, Path("trusted-System32-powershell.exe")), tool

    def test_active_state_is_explicit_and_inventory_never_runs_supplied_executable(self):
        value = self.inventory(products=[
            {"name": "ESET Security", "state": "on", "pathToSignedProductExe": "UNTRUSTED-INVENTORY-EXECUTABLE"},
            {"name": "Microsoft Defender Antivirus", "state": "off"},
        ], providers=[{"identity": "ESET AMSI Provider"}])
        result, tool = self.discover(value)
        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["products"][0], {"name": "ESET Security", "state": "on"})
        self.assertEqual(result["products"][1]["state"], "off")
        self.assertNotIn("pathToSignedProductExe", str(result))
        self.assertEqual(tool.call_count, 1)
        self.assertNotIn("UNTRUSTED-INVENTORY-EXECUTABLE", str(tool.call_args))

    def test_failed_or_malformed_inventory_cannot_establish_a_connected_antivirus(self):
        invalid = ["not JSON", "[]", self.inventory(products=None, providers="provider"),
                   self.inventory(products=[{"name": "AV", "state": 0}]),
                   self.inventory(products=[{"name": "", "state": "on"}]),
                   self.inventory(products=[{"name": "AV", "state": "enabled"}]),
                   self.inventory(providers=[{"identity": ""}]),
                   self.inventory(products=[{"name": "AV", "state": "on"}] * 33),
                   self.inventory(providers=[{"identity": "ESET"}] * 65)]
        for value in invalid:
            with self.subTest(value=str(value)[:80]):
                result, _ = self.discover(value)
                self.assertEqual(result["status"], "error")
                self.assertEqual(result["products"], [])
                self.assertEqual(result["providers"], [])
        self.assertEqual(self.discover(self.inventory(), code=1)[0]["status"], "error")

    def test_provider_identity_must_match_the_active_vendor_without_ambiguity(self):
        self.assertTrue(WINDOWS.provider_for_product("ESET Security", [{"identity": "ESET, spol. s r.o. ESET AMSI Provider"}]))
        self.assertTrue(WINDOWS.provider_for_product("Norton Antivirus", [{"identity": "Symantec AMSI"}]))
        self.assertFalse(WINDOWS.provider_for_product("ESET Security", [{"identity": "Microsoft Defender AMSI"}]))
        self.assertFalse(WINDOWS.provider_for_product("ESET Security", [{"identity": "ESET Norton bridge"}]))
        self.assertFalse(WINDOWS.provider_for_product("ESET and Norton Security", [{"identity": "ESET AMSI"}]))
        self.assertFalse(WINDOWS.provider_for_product("Unknown AV", [{"identity": "Unknown vendor scanner"}]))
        self.assertFalse(WINDOWS.provider_for_product("ESET Security", [{"path": "ESET.exe"}]))

    def test_defender_name_match_cannot_swallow_another_vendor(self):
        self.assertTrue(WINDOWS.is_defender("Microsoft Defender Antivirus"))
        self.assertTrue(WINDOWS.is_defender("Windows Defender"))
        self.assertFalse(WINDOWS.is_defender("ESET Microsoft Defender Connector"))
        self.assertFalse(WINDOWS.is_defender("Some Antivirus"))


class WindowsAmsiContractTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="mva-amsi-contract-")
        self.root = Path(self.directory.name)
        self.video = self.root / "video.mp4"
        # More than a common read chunk verifies the full-buffer scan contract.
        self.payload = b"Harmless data before a boundary:" + b"v" * (1024 * 1024) + b":after boundary"
        self.video.write_bytes(self.payload)

    def tearDown(self):
        self.directory.cleanup()

    def test_scan_receives_exact_complete_bytes_once_and_releases_handles(self):
        api = FakeAmsi(verdict=1)
        result = WINDOWS.scan_with_amsi(self.video, "ESET Security", api=api)
        self.assertEqual(result["status"], "clean")
        self.assertEqual(result["engine"], "Windows AMSI")
        self.assertEqual(api.buffers, [(self.payload, len(self.payload), "video.mp4")])
        self.assertEqual(api.calls, ["initialize", "open", "scan", "close", "uninitialize"])
        self.assertIn("does not identify", result["message"])

    def test_detection_admin_blocks_and_uncertain_results_remain_distinct(self):
        for verdict, expected in [(0, "clean"), (1, "clean"), (2, "error"),
                                  (0x3FFF, "error"), (0x4000, "error"), (0x4FFF, "error"),
                                  (0x5000, "error"), (0x7FFF, "error"),
                                  (0x8000, "infected"), (0x8001, "infected"),
                                  (None, "error")]:
            with self.subTest(verdict=verdict):
                api = FakeAmsi(verdict=verdict)
                result = WINDOWS.scan_with_amsi(self.video, api=api)
                self.assertEqual(result["status"], expected)
                if expected == "infected":
                    self.assertTrue(result["threats"])
                if verdict is not None and 0x4000 <= verdict <= 0x4FFF:
                    self.assertIn("administrator policy", result["message"])
                self.assertEqual(api.calls[-2:], ["close", "uninitialize"])

    def test_failed_hresult_never_maps_to_clean_and_releases_initialized_resources(self):
        for stage in ("initialize", "open", "scan"):
            for error in (0x80004005, -2147467259, ctypes.c_int32(-2147467259)):
                with self.subTest(stage=stage, error=error):
                    api = FakeAmsi(failure=stage, hresult=error)
                    self.assertEqual(WINDOWS.scan_with_amsi(self.video, api=api)["status"], "error")
                    self.assertEqual(api.calls[-1], "uninitialize")
                    self.assertEqual(len(api.buffers), 1 if stage == "scan" else 0)

    def test_missing_context_or_session_never_reaches_a_successful_scan(self):
        for missing in ("context", "session"):
            with self.subTest(missing=missing):
                api = FakeAmsi(missing_handle=missing)
                self.assertEqual(WINDOWS.scan_with_amsi(self.video, api=api)["status"], "error")
                self.assertNotIn("scan", api.calls)

    def test_empty_and_larger_than_128_mib_remain_unscanned_without_api_call(self):
        empty = self.root / "empty.mp4"
        empty.touch()
        large = self.root / "large.mp4"
        with large.open("wb") as stream:
            stream.seek(128 * 1024 * 1024)
            stream.write(b"x")
        for path in (empty, large):
            with self.subTest(path=path.name):
                api = FakeAmsi()
                result = WINDOWS.scan_with_amsi(path, api=api)
                self.assertEqual(result["status"], "unavailable")
                self.assertIn("128 MiB", result["message"])
                self.assertFalse(api.calls)

    def test_unavailable_windows_library_is_a_failed_scan(self):
        with patch.object(WINDOWS, "_load_amsi", side_effect=OSError("Provider unavailable")):
            self.assertEqual(WINDOWS.scan_with_amsi(self.video)["status"], "error")


class WindowsAntivirusSelectionTests(unittest.TestCase):
    """Selection must follow active OS protection, not whichever executable exists."""

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="mva-win-av-test-")
        self.root = Path(self.directory.name)
        self.video = self.root / "video.mp4"
        self.video.write_bytes(b"Harmless video fixture")
        self.paths = (self.root / "powershell.exe", self.root / "MpCmdRun.exe")
        self.platform = patch.object(sys, "platform", "win32")
        self.defender_paths = patch.object(HOST, "windows_defender_paths", return_value=self.paths)
        self.platform.start()
        self.defender_paths.start()

    def tearDown(self):
        self.defender_paths.stop()
        self.platform.stop()
        self.directory.cleanup()

    def adapter(self, products, providers=(), status="ok", matching=True):
        return SimpleNamespace(
            discover_windows_antivirus=Mock(return_value={
                "status": status, "products": products, "providers": list(providers)}),
            is_defender=lambda name: name in {"Microsoft Defender", "Windows Defender"},
            provider_for_product=Mock(return_value=matching),
        )

    def test_windows_defaults_to_defender_even_with_clamav_installed(self):
        adapter = self.adapter([{"name": "Microsoft Defender", "state": "on"}])
        with patch.object(HOST, "windows_adapter", return_value=adapter), \
                patch.object(HOST, "clamav_path", return_value=self.root / "clamscan.exe") as clamav, \
                patch.object(HOST, "scan_defender", return_value={"status": "clean", "engine": "Microsoft Defender"}) as defender:
            result = HOST.select_scanner({})(self.video)
        self.assertEqual(result["engine"], "Microsoft Defender")
        defender.assert_called_once_with(*self.paths, self.video)
        clamav.assert_not_called()

    def test_active_other_product_uses_windows_amsi(self):
        adapter = self.adapter([
            {"name": "Microsoft Defender", "state": "off"},
            {"name": "Example Antivirus", "state": "on"},
        ], providers=[{"name": "Example Antivirus"}])
        with patch.object(HOST, "windows_adapter", return_value=adapter), \
                patch.object(HOST, "scan_windows_amsi", return_value={"status": "clean", "engine": "Windows AMSI"}) as amsi, \
                patch.object(HOST, "scan_defender") as defender:
            result = HOST.select_scanner({})(self.video)
        self.assertEqual(result["engine"], "Windows AMSI")
        amsi.assert_called_once_with(self.video, "Example Antivirus")
        defender.assert_not_called()

    def test_active_unsupported_product_never_silently_falls_back_to_another_scanner(self):
        adapter = self.adapter([{"name": "Unsupported Antivirus", "state": "on"}], matching=False)
        with patch.object(HOST, "windows_adapter", return_value=adapter), \
                patch.object(HOST, "scan_windows_amsi") as amsi, \
                patch.object(HOST, "scan_defender") as defender, \
                patch.object(HOST, "clamav_path") as clamav:
            result = HOST.select_scanner({})(self.video)
        self.assertEqual(result["status"], "unavailable")
        self.assertIn("Unsupported Antivirus", result["message"])
        amsi.assert_not_called()
        defender.assert_not_called()
        clamav.assert_not_called()

    def test_every_active_third_party_product_must_have_a_supported_provider(self):
        adapter = self.adapter([
            {"name": "First Antivirus", "state": "on"},
            {"name": "Second Antivirus", "state": "on"},
        ])
        adapter.provider_for_product.side_effect = [True, False]
        with patch.object(HOST, "windows_adapter", return_value=adapter), \
                patch.object(HOST, "scan_windows_amsi") as amsi:
            result = HOST.select_scanner({})(self.video)
        self.assertEqual(result["status"], "unavailable")
        amsi.assert_not_called()

    def test_inactive_third_party_products_do_not_override_defender(self):
        for state in ("off", "snoozed", "expired"):
            adapter = self.adapter([{"name": "Example Antivirus", "state": state}])
            with self.subTest(state=state), patch.object(HOST, "windows_adapter", return_value=adapter), \
                    patch.object(HOST, "scan_defender", return_value={"status": "clean", "engine": "Microsoft Defender"}) as defender:
                self.assertEqual(HOST.select_scanner({})(self.video)["engine"], "Microsoft Defender")
                defender.assert_called_once()
                adapter.provider_for_product.assert_not_called()

    def test_inventory_failure_only_uses_defender_after_its_own_availability_check(self):
        adapter = self.adapter([], status="error")
        with patch.object(HOST, "windows_adapter", return_value=adapter), \
                patch.object(HOST, "scan_defender", return_value={"status": "unavailable", "engine": "Microsoft Defender"}) as defender, \
                patch.object(HOST, "scan_windows_amsi") as amsi:
            self.assertEqual(HOST.select_scanner({})(self.video)["status"], "unavailable")
            defender.assert_called_once()
            amsi.assert_not_called()

    def test_explicit_clamav_path_remains_user_override(self):
        executable = self.root / "clamscan.exe"
        with patch.object(HOST, "clamav_path", return_value=executable), \
                patch.object(HOST, "scan_clamav", return_value={"status": "clean", "engine": "ClamAV"}) as clamav, \
                patch.object(HOST, "windows_adapter") as adapter:
            self.assertEqual(HOST.select_scanner({"clamav": str(executable)})(self.video)["engine"], "ClamAV")
            clamav.assert_called_once_with(executable, self.video)
            adapter.assert_not_called()

    def test_untrusted_worker_response_never_becomes_clean(self):
        for response, code in [("not JSON", 0), ("{}", 0),
                               ('{"status":"clean","engine":"wrong"}', 0),
                               ('{"status":"clean","engine":"Windows AMSI"}', 1)]:
            with self.subTest(response=response, code=code), patch.object(HOST, "run_tool", return_value=(code, response)):
                self.assertEqual(HOST.scan_windows_amsi(self.video, "Example Antivirus")["status"], "error")


if __name__ == "__main__":
    unittest.main()
