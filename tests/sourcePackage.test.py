"""Public source must not retain imports of deliberately withheld study code."""
import importlib.util
from pathlib import Path
import re
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("source_package", ROOT / "scripts/package_source.py")
package = importlib.util.module_from_spec(spec)
spec.loader.exec_module(package)


class PublicSourceTests(unittest.TestCase):
    def test_public_modules_do_not_import_existing_withheld_files(self):
        selected = set(package.selected_files())
        missing = []
        for source in selected:
            if source.suffix not in {".js", ".mjs", ".ts", ".tsx", ".mts"}:
                continue
            for name in re.findall(r"(?:from\s*|import\s*\(\s*|import\s*)[\"']([^\"']+)[\"']", source.read_text()):
                if not name.startswith("."):
                    continue
                target = (source.parent / name.split("?", 1)[0]).resolve()
                if target.is_file() and target not in selected:
                    missing.append((str(source.relative_to(ROOT)), str(target.relative_to(ROOT))))
        self.assertEqual(missing, [])

    def test_live_case_sources_and_their_private_test_consumers_stay_withheld(self):
        names = {str(file.relative_to(ROOT)) for file in package.selected_files()}
        for name in ["scripts/study/build_case_packets.mjs", "scripts/study/case_sources.mjs",
                     "tests/studyCaseCache.test.js", "tests/studyCaseSources.test.js"]:
            self.assertFalse(name in names, f"Private study consumer was selected: {name}")
        self.assertIn("scripts/lib/delivery_inspection.mjs", names)
        self.assertIn("scripts/lib/delivery_presentation.d.mts", names)


if __name__ == "__main__":
    unittest.main()
