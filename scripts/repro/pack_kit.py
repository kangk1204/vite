#!/usr/bin/env python3
"""Make a deterministic transport ZIP of an already verified operator kit."""
import argparse
import hashlib
import json
import os
import tempfile
import zipfile
from pathlib import Path


def pack(kit, output, public):
    manifest_path = kit / "kit-manifest.json"
    manifest = json.loads(manifest_path.read_text())
    if public and manifest.get("distribution") != "public-source-handoff":
        raise ValueError("Public export requires a reviewed public-source handoff kit")
    records = manifest["files"]
    expected = set(records) | {"kit-manifest.json"}
    actual = {p.relative_to(kit).as_posix() for p in kit.rglob("*") if p.is_file()}
    if actual != expected:
        raise ValueError("Kit contents differ from kit-manifest.json")
    if output.resolve().is_relative_to(kit.resolve()):
        raise ValueError("Write the transport ZIP outside the kit directory")
    if output.exists() or output.with_suffix(".receipt.json").exists():
        raise ValueError("Choose a new archive name")
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=output.parent, prefix=".pnv-zip-") as directory:
        staging = Path(directory) / "kit.zip"
        with zipfile.ZipFile(staging, "x", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
            for name in sorted(expected):
                source = kit / name
                if source.is_symlink() or not source.resolve().is_relative_to(kit.resolve()):
                    raise ValueError(f"Unsafe kit member {name}")
                data = source.read_bytes()
                if name in records and hashlib.sha256(data).hexdigest() != records[name]:
                    raise ValueError(f"Changed kit file {name}")
                info = zipfile.ZipInfo("pnv-linux-kit/" + name, date_time=(1980, 1, 1, 0, 0, 0))
                info.compress_type = zipfile.ZIP_DEFLATED
                info.external_attr = (0o100000 | (source.stat().st_mode & 0o777)) << 16
                archive.writestr(info, data)
        os.link(staging, output)
    result = {"archive": output.name, "bytes": output.stat().st_size,
              "sha256": hashlib.sha256(output.read_bytes()).hexdigest(),
              "kitManifestSha256": hashlib.sha256(manifest_path.read_bytes()).hexdigest(),
              "sourceArchiveSha256": manifest["sourceArchiveSha256"],
              "distribution": manifest.get("distribution", "private-historical-replay")}
    output.with_suffix(".receipt.json").write_text(json.dumps(result, indent=2) + "\n")
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("kit", type=Path); parser.add_argument("output", type=Path)
    parser.add_argument("--public", action="store_true")
    args = parser.parse_args()
    print(json.dumps(pack(args.kit, args.output, args.public), indent=2))
