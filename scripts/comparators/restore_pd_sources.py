"""Restore only manifest-bound original PD inputs; preserve differing existing files."""
import hashlib,json
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
def safe(root,name):
    relative=Path(name)
    if relative.is_absolute()or'..'in relative.parts:raise ValueError('Unsafe restoration path')
    file=(root/relative).resolve()
    if not file.is_relative_to(root.resolve()):raise ValueError('Restoration path escapes root')
    return file
def restore(root,manifest):
    root=Path(root).resolve();manifest=Path(manifest).resolve();copied=[]
    for item in json.loads(manifest.read_text())['files']:
        if not item.get('sourcePath'):continue
        source=safe(manifest.parent,item['path']);destination=safe(root,item['sourcePath']);data=source.read_bytes()
        if len(data)!=item['sizeBytes']or hashlib.sha256(data).hexdigest()!=item['sha256']:raise ValueError('Companion bytes differ')
        if destination.exists():
            if hashlib.sha256(destination.read_bytes()).hexdigest()!=item['sha256']:raise ValueError('An existing source differs; it was preserved')
        else:
            destination.parent.mkdir(parents=True,exist_ok=True);destination.write_bytes(data)
        copied.append(item['sourcePath'])
    return copied
if __name__=='__main__':
    result=restore(ROOT,ROOT/'paper/outputs/publication_2026_11_17/comparators/shared-evidence/manifest.json')
    print(json.dumps({'verifiedOrRestored':len(result)}))
