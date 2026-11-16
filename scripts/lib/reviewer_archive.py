"""Assemble an offline public reviewer ZIP from the generated staging directory."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import sys
import zipfile


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def audit_source(archive_path):
    with zipfile.ZipFile(archive_path) as archive:
        names = archive.namelist()
        if len(names) != len(set(names)):
            raise ValueError('Duplicate source archive entries')
        for info in archive.infolist():
            name = info.filename
            member = PurePosixPath(name)
            if (member.is_absolute() or '..' in member.parts or '\\' in name or stat.S_ISLNK(info.external_attr >> 16) or
                    re.search(r'(?:^|/)(?:\.git|\.cache|private|enrollment|heldout|held-out|answer[-_]keys?)(?:/|$)', name, re.I) or
                    re.search(r'(?:^|/)(?:\.env(?:\..*)?|id_rsa|id_ed25519|credentials\.json|case-manifest\.seed\.json|(?:participants|ratings|responses)\.json|.*\.(?:pem|key))$', name, re.I)):
                raise ValueError(f'Non-public source archive entry: {name}')
        for needed in ['SOURCE_MANIFEST.json', 'renv.lock', 'package-lock.json', 'scripts/analyze_neural_bulk_cohort.R', 'data/reference/ReactomePathways.gmt.zip']:
            if needed not in archive.namelist():
                raise ValueError(f'Incomplete runnable source archive: missing {needed}')
        manifest = json.loads(archive.read('SOURCE_MANIFEST.json'))
        records = manifest['files']
        if {r['path'] for r in records} | {'SOURCE_MANIFEST.json'} != set(archive.namelist()):
            raise ValueError('Source archive manifest coverage differs from archive entries')
        for record in records:
            with archive.open(record['path']) as stream:
                if hashlib.file_digest(stream, 'sha256').hexdigest() != record['sha256']:
                    raise ValueError(f"Source digest mismatch for {record['path']}")
        return manifest['sourceSnapshot']


def pack(directory):
    source = json.loads((directory / 'source/source-snapshot.json').read_text())
    archive_path = directory / 'source' / source['archive']
    if digest(archive_path) != source['sha256'] or audit_source(archive_path) != source['sourceSnapshot']:
        raise ValueError('Source snapshot differs from its receipt')
    files = sorted(p for p in directory.rglob('*') if p.is_file())
    if any(p.is_symlink() or not p.resolve().is_relative_to(directory) for p in files):
        raise ValueError('Reviewer package contains a linked file')
    inventory = ''.join(f"{digest(p)}  {p.relative_to(directory).as_posix()}\n" for p in files)
    inventory_path = directory / 'files.sha256'
    inventory_path.write_text(inventory, encoding='utf-8')
    identity = digest(inventory_path)
    output = directory / f"pnv-reviewer-{identity[:12]}.zip"
    with zipfile.ZipFile(output, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=6, allowZip64=True) as archive:
        for file in sorted(files + [inventory_path]):
            info = zipfile.ZipInfo(file.relative_to(directory).as_posix(), date_time=(1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            with file.open('rb') as src, archive.open(info, 'w') as dest:
                shutil.copyfileobj(src, dest, length=1024 * 1024)
    receipt = {'schemaVersion': 1, 'builder': 'scripts/build_reviewer_portal.mjs', 'archive': output.name,
               'sha256': digest(output), 'bytes': output.stat().st_size, 'entries': len(files) + 1,
               'inventorySha256': identity, 'sourceSnapshot': source['sourceSnapshot'], 'sourceArchiveSha256': source['sha256']}
    (directory / 'reviewer-package.json').write_text(json.dumps(receipt, indent=2) + '\n')


if __name__ == '__main__':
    pack(Path(sys.argv[1]).resolve())
