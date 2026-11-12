#!/usr/bin/env python3
"""Archive the actual working source with hashes, excluding data and participant records."""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import zipfile

ROOT = Path(__file__).resolve().parents[1]
SOURCE_SUFFIXES = {".ts", ".tsx", ".js", ".mjs", ".R", ".py", ".css", ".html", ".json", ".sh"}
ROOT_FILES = ["package.json", "package-lock.json", "renv.lock", "requirements.txt", "requirements.lock.txt",
              "README.md", "Dockerfile", ".dockerignore", ".Renviron", "vite.config.ts", "tsconfig.json",
              "index.html", "builder.html", ".gitignore", "CITATION.cff", "LICENSE", "THIRD_PARTY_NOTICES.md"]
EVALUATION_FILES = ["README.md", "PROTOCOL.md", "protocol.json", "power-config.json", "response.schema.json",
                    "participants.template.json", "responses.template.json", "ratings.template.json"]
PUBLIC_PAPER_DOCS = ["implementation_status.md", "reproducibility.md", "tool_comparison.md"]
# Keep the analysis, visualization and statistical model runnable while the live
# instrument, native task bookmarks and private answer-generating recipes stay with the study team.
PRIVATE_CODE = {
    "scripts/study/build_case_packets.mjs", "scripts/study/adjudicate_cases.mjs",
    "scripts/study/expert_review_form.mjs", "scripts/study/smoke.mjs",
    "scripts/comparators/build_study_genetonic.R", "tests/comparators/study-genetonic.R",
    "tests/e2e/case-packets.mjs", "tests/studyCasePackets.test.js", "tests/studyAdjudication.test.js",
    "tests/casePacketBrowserQA.test.js",
}


def selected_files() -> list[Path]:
    candidates = [ROOT / name for name in ROOT_FILES]
    for directory in ["src", "scripts", "tests"]:
        for p in (ROOT / directory).rglob("*"):
            name = p.relative_to(ROOT).as_posix()
            if name in PRIVATE_CODE or name.startswith(("scripts/study/case_", "scripts/study/expert_", "tests/studyCasePackets", "tests/studyAdjudication")):
                continue
            if p.is_file() and (p.suffix in SOURCE_SUFFIXES or p.name in {"Supplement.Dockerfile", "Browser.Dockerfile"}):
                candidates.append(p)
    candidates.extend(ROOT / "paper" / name for name in PUBLIC_PAPER_DOCS)
    candidates.append(ROOT / "paper/cohort_manifest.json")
    for directory in ["paper/configs", "paper/manifests", "data/reference", "vendor"]:
        candidates.extend(p for p in (ROOT / directory).rglob("*") if p.is_file())
    candidates.extend(ROOT / "paper/reviewer" / name for name in ("README.md", "reviewer.css", "verify_bundle.py"))
    candidates.extend(ROOT / "paper/evaluation/linux-replay" / name for name in (
        "RUNBOOK.md", "cohorts.json", "record.schema.json", "intervention.schema.json", "operator-attestation.template.json"))
    candidates.extend(ROOT / "paper/evaluation" / name for name in EVALUATION_FILES)
    files = []
    for path in sorted(set(candidates)):
        if not path.is_file():
            raise ValueError(f"Required source file is missing: {path.relative_to(ROOT)}")
        if path.is_symlink() or path.resolve() != path.absolute() or ROOT not in path.resolve().parents:
            raise ValueError(f"Refusing linked source outside the snapshot: {path}")
        files.append(path)
    return files


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", default="paper/outputs/publication_v2/release")
    args = parser.parse_args()
    if (ROOT / ".Renviron").read_text().strip() != "R_LIBS_USER=.cache/R/library":
        raise ValueError("Review .Renviron before packaging: only the project library setting may be archived.")
    files = selected_files()
    payloads = [(p.relative_to(ROOT).as_posix(), p.read_bytes()) for p in files]
    modes = {p.relative_to(ROOT).as_posix(): p.stat().st_mode & 0o777 for p in files}
    records = [{"path": name, "sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data), "mode": oct(modes[name])}
               for name, data in payloads]
    identity = hashlib.sha256(json.dumps(records, sort_keys=True).encode()).hexdigest()
    commit = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip()
    dirty = bool(subprocess.check_output(["git", "status", "--porcelain"], cwd=ROOT, text=True).strip())
    manifest = {"schemaVersion": 1, "distribution": "public-software", "sourceSnapshot": identity, "baseGitCommit": commit,
                "workingTreeDirty": dirty, "files": records,
                "excluded": ["raw counts", "live study cases and answer keys", "participant observations", "unpublished manuscript and correspondence", "generated reports", "credentials", "local caches"],
                "note": "This captures working files; the base commit alone does not identify their contents."}
    destination = (ROOT / args.output).resolve()
    destination.mkdir(parents=True, exist_ok=True)
    archive_path = destination / f"pnv-source-{identity[:12]}.zip"
    with zipfile.ZipFile(archive_path, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for name, data in payloads + [("SOURCE_MANIFEST.json", json.dumps(manifest, indent=2).encode())]:
            info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = (0o100000 | modes.get(name, 0o644)) << 16
            archive.writestr(info, data)
    with zipfile.ZipFile(archive_path) as archive:
        for record in records:
            if hashlib.sha256(archive.read(record["path"])).hexdigest() != record["sha256"]:
                raise RuntimeError(f"Archive integrity failure: {record['path']}")
    archive_name = str(archive_path.relative_to(ROOT)) if archive_path.is_relative_to(ROOT) else str(archive_path)
    receipt = {"sourceSnapshot": identity, "archive": archive_name,
               "sha256": hashlib.sha256(archive_path.read_bytes()).hexdigest(), "files": len(records),
               "workingTreeDirty": dirty, "uploaded": False}
    (destination / "source-snapshot.json").write_text(json.dumps(receipt, indent=2) + "\n")
    print(json.dumps(receipt, indent=2))


if __name__ == "__main__":
    main()
