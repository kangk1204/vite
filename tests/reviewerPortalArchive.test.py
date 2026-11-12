import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
import zipfile

spec = importlib.util.spec_from_file_location('reviewer_archive', Path(__file__).resolve().parents[1] / 'scripts/lib/reviewer_archive.py')
archive = importlib.util.module_from_spec(spec)
spec.loader.exec_module(archive)


def fixture(root, extra=None):
    (root / 'source').mkdir()
    (root / 'index.html').write_text('<h1>Example</h1>')
    files = {'renv.lock': b'{}', 'package-lock.json': b'{}', 'scripts/analyze_neural_bulk_cohort.R': b'# fixture', 'data/reference/ReactomePathways.gmt.zip': b'fixture'}
    if extra:
        files.update(extra)
    records = [{'path': name, 'sha256': hashlib.sha256(content).hexdigest()} for name, content in files.items()]
    identity = hashlib.sha256(json.dumps(records, sort_keys=True).encode()).hexdigest()
    filename = f'pnv-source-{identity[:12]}.zip'
    with zipfile.ZipFile(root / 'source' / filename, 'w') as source:
        for name, content in files.items():
            source.writestr(name, content)
        source.writestr('SOURCE_MANIFEST.json', json.dumps({'sourceSnapshot': identity, 'files': records}))
    receipt = {'sourceSnapshot': identity, 'archive': filename, 'sha256': archive.digest(root / 'source' / filename)}
    (root / 'source/source-snapshot.json').write_text(json.dumps(receipt))


class ReviewerArchive(unittest.TestCase):
    def test_packages_only_staged_files_and_binds_the_source_receipt(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder).resolve()
            fixture(root)
            archive.pack(root)
            receipt = json.loads((root / 'reviewer-package.json').read_text())
            self.assertEqual(receipt['sha256'], archive.digest(root / receipt['archive']))
            with zipfile.ZipFile(root / receipt['archive']) as result:
                self.assertIn('index.html', result.namelist())
                self.assertIn('files.sha256', result.namelist())
                self.assertNotIn(receipt['archive'], result.namelist())
            self.assertEqual(receipt['sourceSnapshot'], json.loads((root / 'source/source-snapshot.json').read_text())['sourceSnapshot'])

    def test_refuses_private_case_material_in_nested_source(self):
        for name in ['paper/evaluation/case-manifest.seed.json', 'paper/evaluation/private/keys.json', 'paper/evaluation/responses.json']:
            with self.subTest(name=name), tempfile.TemporaryDirectory() as folder:
                root = Path(folder).resolve()
                fixture(root, {name: b'test'})
                with self.assertRaisesRegex(ValueError, 'Non-public'):
                    archive.pack(root)
                self.assertFalse((root / 'reviewer-package.json').exists())

    def test_refuses_a_source_archive_that_differs_from_its_receipt(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder).resolve()
            fixture(root)
            source = next((root / 'source').glob('*.zip'))
            source.write_bytes(source.read_bytes() + b'changed')
            with self.assertRaisesRegex(ValueError, 'receipt'):
                archive.pack(root)


if __name__ == '__main__':
    unittest.main()
