import importlib.util,json,hashlib,tempfile,unittest
from pathlib import Path
file=Path(__file__).resolve().parents[2]/'scripts/comparators/restore_pd_sources.py'
spec=importlib.util.spec_from_file_location('restore_pd',file);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
class RestoreTests(unittest.TestCase):
 def test_bound_copy_does_not_overwrite_changed_or_escaping_sources(self):
  with tempfile.TemporaryDirectory()as tmp:
   root=Path(tmp);bundle=root/'bundle';bundle.mkdir();(bundle/'data').write_bytes(b'original')
   record={'files':[{'path':'data','sourcePath':'data/input.tsv','sha256':hashlib.sha256(b'original').hexdigest(),'sizeBytes':8}]}
   manifest=bundle/'manifest.json';manifest.write_text(json.dumps(record));module.restore(root,manifest)
   self.assertEqual((root/'data/input.tsv').read_bytes(),b'original');module.restore(root,manifest)
   (root/'data/input.tsv').write_text('changed')
   with self.assertRaisesRegex(ValueError,'existing|differs'):module.restore(root,manifest)
   record['files'][0]['sourcePath']='../outside';manifest.write_text(json.dumps(record))
   with self.assertRaisesRegex(ValueError,'path|escape'):module.restore(root,manifest)
if __name__=='__main__':unittest.main()
