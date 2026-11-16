"""Verify files in the extracted reviewer package using the included SHA-256 inventory."""
from pathlib import Path
import hashlib

root = Path(__file__).resolve().parent
records = (root / 'files.sha256').read_text(encoding='utf-8').splitlines()
for line in records:
    expected, name = line.split('  ', 1)
    file = (root / name).resolve()
    if not file.is_relative_to(root) or not file.is_file():
        raise SystemExit(f'Missing or invalid file: {name}')
    with file.open('rb') as stream:
        digest = hashlib.sha256()
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
        actual = digest.hexdigest()
    if actual != expected:
        raise SystemExit(f'File differs from the inventory: {name}')
print(f'Verified {len(records)} files against files.sha256.')
