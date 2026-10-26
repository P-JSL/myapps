"""Safe Chrome user-profile extension-ID discovery fixtures."""
from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("youtube_installer_detection", Path(__file__).with_name("install_youtube.py"))
INSTALLER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(INSTALLER)
DEFAULT = INSTALLER.DEFAULT_EXTENSION_ID
ALTERNATE = "abcdefghijklmnopabcdefghijklmnop"


def app_entry(state=1):
    return {"state": state, "manifest": {"name": "My Video App", "short_name": "My Video App",
            "manifest_version": 3, "version": "1.16.0", "optional_permissions": ["nativeMessaging"]}}


class AutoExtensionIdTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.profile = self.root / "Default"
        self.profile.mkdir()

    def tearDown(self):
        self.temp.cleanup()

    def preferences(self, settings):
        (self.profile / "Preferences").write_text(
            json.dumps({"extensions": {"settings": settings}}), encoding="utf-8")

    def detect(self):
        with patch.object(INSTALLER, "profile_root", return_value=self.root):
            return INSTALLER.extension_ids_for_install("chrome", [])

    def test_default_id_has_priority(self):
        self.preferences({DEFAULT: app_entry(), ALTERNATE: app_entry()})
        self.assertEqual(self.detect(), [DEFAULT])

    def test_fallback_to_real_installed_id(self):
        self.preferences({ALTERNATE: app_entry()})
        self.assertEqual(self.detect(), [ALTERNATE])
        self.assertEqual(INSTALLER.manifest_data(Path("/host"), self.detect())["allowed_origins"],
                         ["chrome-extension://" + ALTERNATE + "/"])

    def test_disabled_or_unrelated_extension_is_not_authorized(self):
        self.preferences({DEFAULT: app_entry(state=0), ALTERNATE: {"state": 1, "manifest": {"name": "Other"}}})
        with self.assertRaises(ValueError):
            self.detect()

    def test_multiple_fallbacks_require_explicit_choice(self):
        self.preferences({ALTERNATE: app_entry(), "b" * 32: app_entry()})
        with self.assertRaisesRegex(ValueError, "Multiple matching"):
            self.detect()

    def test_explicit_override(self):
        self.assertEqual(INSTALLER.extension_ids_for_install("chrome", ["a" * 32]), ["a" * 32])


if __name__ == "__main__":
    unittest.main()
