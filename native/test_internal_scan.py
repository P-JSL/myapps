"""Harmless structural fixtures; no real executable or malware is run."""
import hashlib
import importlib.util
import io
from pathlib import Path
import struct
import tempfile
import unittest
from unittest.mock import patch
import zipfile

SPEC = importlib.util.spec_from_file_location("internal_scan", Path(__file__).with_name("internal_scan.py"))
SCAN = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(SCAN)
HOST_SPEC = importlib.util.spec_from_file_location("internal_scan_host_test", Path(__file__).with_name("antivirus_host.py"))
HOST = importlib.util.module_from_spec(HOST_SPEC)
HOST_SPEC.loader.exec_module(HOST)


def media(payload=b"harmless media bytes"):
    return b"\x00\x00\x00\x18ftypisom\x00\x00\x00\x00isommp42" + struct.pack(">I", len(payload) + 8) + b"mdat" + payload


def pe_fixture():
    # Coherent PE headers and one raw section, containing zeros only.
    data = bytearray(1024)
    data[:2] = b"MZ"
    struct.pack_into("<I", data, 60, 128)
    data[128:132] = b"PE\0\0"
    struct.pack_into("<HH", data, 132, 0x14c, 1)
    struct.pack_into("<HH", data, 148, 224, 2)
    struct.pack_into("<H", data, 152, 0x10b)
    struct.pack_into("<II", data, 208, 4096, 512)
    struct.pack_into("<II", data, 392, 512, 512)
    return bytes(data)


class InternalScanTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="mva-builtin-test-")
        self.root = Path(self.directory.name)
        self.path = self.root / "download.mp4"

    def tearDown(self):
        self.directory.cleanup()

    def run_scan(self, content, **options):
        self.path.write_bytes(content)
        return SCAN.scan_file(self.path, **options)

    def ids(self, result):
        return {finding["id"] for finding in result["findings"]}

    def test_benign_media_and_incidental_strings_are_not_malware(self):
        content = media((b"MZ PK\x03\x04 <script> #!/bin/sh %PDF- " * 2000))
        result = self.run_scan(content)
        self.assertEqual(result["status"], "no-signals")
        self.assertTrue(result["complete"])
        self.assertEqual(result["scannedBytes"], len(content))
        self.assertEqual(result["findings"], [])
        self.assertEqual(self.path.read_bytes(), content)

    def test_standard_harmless_test_marker_crosses_stream_boundary(self):
        content = media(b"x" * (SCAN.CHUNK_BYTES - 32 - 20) + SCAN.TEST_MARKER + b"trailing bytes")
        result = self.run_scan(content)
        self.assertEqual(result["status"], "suspicious")
        self.assertIn("eicar-test-marker", self.ids(result))
        finding = next(item for item in result["findings"] if item["id"] == "eicar-test-marker")
        self.assertEqual(content[finding["offset"]:finding["offset"] + 68], SCAN.TEST_MARKER)
        self.assertIn("시험", finding["message"])
        self.assertNotIn("content", result)

    def test_validated_pe_top_level_and_embedded_are_risk_signals(self):
        for content, expected in [(pe_fixture(), "executable-pe"), (media(b"prefix" + pe_fixture()), "embedded-pe")]:
            with self.subTest(expected=expected):
                result = self.run_scan(content)
                self.assertEqual(result["status"], "suspicious")
                self.assertIn(expected, self.ids(result))
        broken = bytearray(pe_fixture())
        struct.pack_into("<I", broken, 396, 10000000)
        self.assertNotIn("embedded-pe", self.ids(self.run_scan(media(broken))))

    def test_elf_and_mach_o_need_coherent_executable_headers(self):
        elf = bytearray(64)
        elf[:7] = b"\x7fELF\x02\x01\x01"
        struct.pack_into("<HH", elf, 16, 2, 62)
        struct.pack_into("<H", elf, 52, 64)
        self.assertIn("executable-elf", self.ids(self.run_scan(elf)))
        macho = bytearray(32)
        macho[:4] = b"\xcf\xfa\xed\xfe"
        struct.pack_into("<IIIII", macho, 4, 0x1000007, 0, 2, 1, 8)
        self.assertIn("executable-mach-o", self.ids(self.run_scan(macho)))
        self.assertNotIn("executable-elf", self.ids(self.run_scan(b"\x7fELF arbitrary text")))

    def test_disguised_archives_documents_and_scripts_are_signals(self):
        for content, expected in [(b"PK\x03\x04not-a-video", "non-media-archive"),
                                  (b"%PDF-1.7\n", "non-media-pdf"),
                                  (b"#!/bin/sh\necho harmless", "non-media-script"),
                                  (b"<!DOCTYPE html><html>harmless</html>", "non-media-script"),
                                  ("<!DOCTYPE html><html>harmless</html>".encode("utf-16"), "non-media-script"),
                                  (b"\xfe\xff" + "#!/bin/sh\necho harmless".encode("utf-16-be"), "non-media-script")]:
            with self.subTest(expected=expected):
                result = self.run_scan(content)
                self.assertEqual(result["status"], "suspicious")
                self.assertIn(expected, self.ids(result))

    def test_appended_zip_requires_valid_eof_central_and_local_records(self):
        output = io.BytesIO()
        with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
            archive.writestr("harmless.txt", "This is a harmless appended archive fixture.")
        archive = output.getvalue()
        self.assertIn("appended-zip", self.ids(self.run_scan(media(b"video") + archive)))
        self.assertIn("non-media-archive", self.ids(self.run_scan(archive)))
        for broken in [archive[:-1], archive + b"garbage", b"PK\x05\x06" + bytes(18)]:
            self.assertNotIn("appended-zip", self.ids(self.run_scan(media(broken))))

    def test_zip_comment_eocd_decoys_do_not_hide_valid_appended_zip(self):
        output = io.BytesIO()
        with zipfile.ZipFile(output, "w", zipfile.ZIP_STORED) as archive:
            archive.writestr("harmless.txt", "Harmless ZIP comment regression")
            archive.comment = b"legal comment containing PK\x05\x06decoy"
        result = self.run_scan(media(b"video") + output.getvalue())
        self.assertIn("appended-zip", self.ids(result))
        self.assertTrue(result["complete"])

    def test_incidental_mz_pairs_do_not_consume_expensive_header_budget(self):
        result = self.run_scan(media(b"MZ" * (SCAN.MAX_PE_CANDIDATES + 100)))
        self.assertEqual(result["status"], "no-signals")
        self.assertTrue(result["complete"])
        result = self.run_scan(media(b"MZ" * (SCAN.MAX_DOS_CANDIDATES + 1)))
        self.assertEqual(result["status"], "incomplete")
        self.assertFalse(result["complete"])

    def test_non_byte_coverage_reasons_omit_offsets(self):
        for content, options in [(b"", {}), (media(), {"max_bytes": 0})]:
            result = self.run_scan(content, **options)
            self.assertEqual(result["scannedBytes"], 0)
            for finding in result["findings"]:
                self.assertNotIn("offset", finding)

    def test_partial_unknown_and_empty_inputs_never_get_no_signals(self):
        for content, options, expected in [(media(b"x" * 100), {"max_bytes": 20}, "analysis-limit"),
                                            (b"unknown binary", {}, "unsupported-format"),
                                            (b"", {}, "empty-input")]:
            result = self.run_scan(content, **options)
            self.assertEqual(result["status"], "incomplete")
            self.assertFalse(result["complete"])
            self.assertIn(expected, self.ids(result))
        self.assertEqual(self.run_scan(b"ordinary data", expected_media=False)["status"], "no-signals")

    def test_pe_candidate_and_findings_limits_fail_closed(self):
        content = media(pe_fixture() * (SCAN.MAX_PE_CANDIDATES + 1))
        result = self.run_scan(content)
        self.assertEqual(result["status"], "suspicious")
        self.assertFalse(result["complete"])
        self.assertIn("analysis-limit", self.ids(result))
        self.assertLessEqual(len(result["findings"]), SCAN.MAX_FINDINGS)
        content = media((SCAN.TEST_MARKER + b"x" * SCAN.CHUNK_BYTES) * 20)
        result = self.run_scan(content)
        self.assertEqual(result["status"], "suspicious")
        self.assertLessEqual(len(result["findings"]), SCAN.MAX_FINDINGS)
        self.assertEqual(result["scannedBytes"], len(content))

    def test_reads_are_bounded_including_tail_and_random_header_checks(self):
        content = media(b"x" * 200000)
        self.path.write_bytes(content)
        real_open = Path.open
        class BoundedReader:
            def __init__(self, file): self.file = file
            def __enter__(self): return self
            def __exit__(self, *args): self.file.close()
            def seek(self, *args): return self.file.seek(*args)
            def read(self, size=-1):
                if not 0 <= size <= SCAN.CHUNK_BYTES: raise AssertionError("Unbounded scan read")
                return self.file.read(size)
        with patch.object(Path, "open", lambda path, *args, **kwargs: BoundedReader(real_open(path, *args, **kwargs))):
            result = SCAN.scan_file(self.path)
        self.assertEqual(result["status"], "no-signals")

    def test_host_builtin_is_independent_and_hash_bound_when_external_missing(self):
        payload = media(b"harmless")
        self.path.write_bytes(payload)
        request = {"version": 1, "action": "scan", "requestId": "internal-missing", "path": str(self.path)}
        with patch.object(HOST, "CONFIG_PATH", self.root / "absent-config.json"), patch.object(HOST, "select_scanner", return_value=None):
            result = HOST.scan_request(request)
        self.assertEqual(result["status"], "unavailable")
        self.assertEqual(result["internalScan"]["status"], "no-signals")
        self.assertEqual(result["sha256"], hashlib.sha256(payload).hexdigest())
        self.assertEqual(result["size"], len(payload))

    def test_external_clean_does_not_erase_suspicious_internal_evidence(self):
        payload = media(SCAN.TEST_MARKER)
        self.path.write_bytes(payload)
        request = {"version": 1, "action": "scan", "requestId": "internal-risk", "path": str(self.path)}
        with patch.object(HOST, "CONFIG_PATH", self.root / "absent-config.json"), patch.object(HOST, "select_scanner", return_value=lambda snapshot: {"status": "clean", "engine": "external-test"}):
            result = HOST.scan_request(request)
        self.assertEqual(result["status"], "clean", "External AV status must remain separate")
        self.assertEqual(result["internalScan"]["status"], "suspicious")
        self.assertIn("eicar-test-marker", self.ids(result["internalScan"]))

    def test_config_failure_still_returns_verified_builtin_evidence(self):
        self.path.write_bytes(media())
        config = self.root / "invalid-config.json"
        config.write_text('{"scanner": []}')
        request = {"version": 1, "action": "scan", "requestId": "internal-config", "path": str(self.path)}
        with patch.object(HOST, "CONFIG_PATH", config):
            result = HOST.scan_request(request)
        self.assertEqual(result["status"], "error")
        self.assertEqual(result["internalScan"]["status"], "no-signals")
        self.assertIn("sha256", result)

    def test_mutation_on_unavailable_path_has_no_hash_or_builtin_assertion(self):
        self.path.write_bytes(media())
        request = {"version": 1, "action": "scan", "requestId": "internal-mutation", "path": str(self.path)}
        def scanner(snapshot):
            self.path.write_bytes(b"mutated original")
            return {"status": "unavailable", "engine": "test"}
        with patch.object(HOST, "CONFIG_PATH", self.root / "absent-config.json"), patch.object(HOST, "select_scanner", return_value=scanner):
            result = HOST.scan_request(request)
        self.assertEqual(result["status"], "error")
        self.assertNotIn("sha256", result)
        self.assertNotIn("internalScan", result)


if __name__ == "__main__":
    unittest.main()
