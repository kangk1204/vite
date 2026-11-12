#!/usr/bin/env python3
"""Prepare an offline handoff kit from the archived source and hashed public reference outputs."""
import argparse
import gzip
import hashlib
import json
import shutil
import stat
import tempfile
import zipfile
from pathlib import Path, PurePosixPath

from compare_runs import TABLES

ROOT = Path(__file__).resolve().parents[2]


def digest(path):
    with path.open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def write(path, value):
    path.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n")


def extract_verified(archive, destination, spec, *, public=False):
    if digest(archive) != spec["sourceArchiveSha256"]:
        raise ValueError("The archive SHA-256 does not match the registered source snapshot")
    with zipfile.ZipFile(archive) as source:
        manifest = json.loads(source.read("SOURCE_MANIFEST.json"))
        if manifest["sourceSnapshot"] != spec["sourceSnapshot"]:
            raise ValueError("The archive internal source identity does not match the selection")
        records = manifest["files"]
        if hashlib.sha256(json.dumps(records, sort_keys=True).encode()).hexdigest() != spec["sourceSnapshot"]:
            raise ValueError("The recorded snapshot identity differs from the hashed file manifest")
        if public:
            if manifest.get("distribution") != "public-software":
                raise ValueError("Public handoff requires a source manifest marked public-software")
            reject_withheld_members([row["path"] for row in records])
        if len(source.namelist()) != len(records) + 1 or len(set(source.namelist())) != len(source.namelist()):
            raise ValueError("Unexpected or duplicate archive members")
        for record in records:
            name = PurePosixPath(record["path"])
            info = source.getinfo(str(name))
            if name.is_absolute() or ".." in name.parts or stat.S_ISLNK(info.external_attr >> 16):
                raise ValueError(f"Unsafe archive member {name}")
            data = source.read(info)
            if len(data) != record["bytes"] or hashlib.sha256(data).hexdigest() != record["sha256"]:
                raise ValueError(f"Archived bytes differ for {name}")
            target = destination / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
            target.chmod(int(record["mode"], 8) & 0o777)
        write(destination / "SOURCE_MANIFEST.json", manifest)


def reject_withheld_members(paths):
    for name in paths:
        path = PurePosixPath(name)
        if (path.name in {"case-manifest.seed.json", "manuscript.md", "pnv-source-9bb30adcf4fe.zip"}
                or name.startswith(("paper/novelty_submission_loop/", "paper/evaluation/private/"))):
            raise ValueError(f"Private material in requested public source archive: {name}")


def verify_scientific_sources(evidence, source):
    bindings = {}
    roles = {"analysis_code", "environment", "reference", "analysis_config"}
    artifacts = evidence["executionCapture"]["artifacts"]
    if not roles.issubset({a["role"] for a in artifacts}):
        raise ValueError("Incomplete historical scientific execution capture")
    for item in artifacts:
        if item["role"] not in roles:
            continue
        location = item["path"]
        name = PurePosixPath(location.removeprefix("project:"))
        if not location.startswith("project:") or name.is_absolute() or ".." in name.parts:
            raise ValueError(f"Unresolvable original execution binding {location}")
        candidate = source / name
        if not candidate.is_file() or digest(candidate) != item["sha256"]:
            raise ValueError(f"Scientific source/config/reference differs from original capture: {name}")
        bindings[str(name)] = item["sha256"]
    return bindings


def baseline_for(cohort, project, source, recorded, destination):
    key, prefix = cohort["key"], cohort["prefix"]
    target = destination / "expected" / key
    target.mkdir(parents=True)
    hashes = {a["path"]: a["sha256"] for a in recorded["cohorts"][key]["analysisArtifacts"]}
    def checked(suffix):
        name = str(Path(cohort["outputDir"]) / (prefix + suffix))
        path = project / name
        if hashes.get(name) != digest(path):
            raise ValueError(f"Published reference table differs from execution receipt: {name}")
        return path
    for kind, (_, suffix, _) in TABLES.items():
        data = checked(suffix).read_bytes()
        (target / f"{kind}.tsv.gz").write_bytes(gzip.compress(data, mtime=0))
    evidence = json.loads(checked("_evidence.json").read_text())["evidence"]
    bindings = verify_scientific_sources(evidence, source)
    inputs = {a["role"]: a["sha256"] for a in evidence["executionCapture"]["artifacts"]
              if a["role"] in ("raw_counts", "sample_metadata")}
    if inputs != cohort["originalInputs"]:
        raise ValueError(f"Published inputs differ from the registered original capture: {key}")
    fields = ("method", "contrast", "designFormula", "seed", "alpha", "filterRule", "rankMetric",
              "lfcMethod", "adjustment", "geneHypothesisCount", "pathwayHypothesisCount")
    pathways = {k: {"bootstrap": v["bootstrap"]} for k, v in evidence["pathways"].items() if v.get("bootstrap")}
    write(target / "evidence-summary.json", {"analysis": {f: evidence["analysis"].get(f) for f in fields},
                                             "pathways": pathways, "bootstrap": evidence.get("bootstrap", {})})
    if key == "gse68719_pd_primary":
        for a in evidence["executionCapture"]["artifacts"]:
            if a["role"] not in ("raw_counts", "sample_metadata"):
                continue
            name = a["path"].removeprefix("project:")
            if not name.startswith("data/raw/") or ".." in Path(name).parts or digest(project / name) != a["sha256"]:
                raise ValueError(f"Public PD input does not match the execution capture: {name}")
            copied = destination / "inputs" / name
            copied.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(project / name, copied)
    return bindings


def prepare(project, archive, destination, public_receipt=None):
    spec_path = ROOT / "paper/evaluation/linux-replay/cohorts.json"
    spec = json.loads(spec_path.read_text())
    for cohort in spec["cohorts"]:
        cohort["originalInputs"] = spec["originalInputSha256"][cohort["key"]]
    spec["historicalReferenceSnapshot"] = spec["sourceSnapshot"]
    spec["historicalReferenceArchiveSha256"] = spec["sourceArchiveSha256"]
    if public_receipt:
        receipt = json.loads(public_receipt.read_text())
        if receipt["sha256"] == spec["historicalReferenceArchiveSha256"]:
            raise ValueError("The historical archive contains withheld material. Supply the reviewed public snapshot.")
        spec["sourceSnapshot"], spec["sourceArchiveSha256"] = receipt["sourceSnapshot"], receipt["sha256"]
    spec["distribution"] = "public-source-handoff" if public_receipt else "private-historical-replay"
    if destination.exists():
        raise ValueError("Choose a new kit directory to preserve earlier evidence")
    destination.parent.mkdir(parents=True, exist_ok=True)
    stage = Path(tempfile.mkdtemp(prefix=".pnv-kit-", dir=destination.parent))
    try:
        source = stage / "project"
        extract_verified(archive, source, spec, public=bool(public_receipt))
        if digest(source / "renv.lock") != spec["renvLockSha256"] or spec["baseImage"] not in (source / "Dockerfile").read_text():
            raise ValueError("Archived environment pins differ from the registered selection")
        if any(digest(source / name) != value for name, value in spec["inputPreparationSources"].items()):
            raise ValueError("Airway input preparation code differs from the registered historical source")
        supplement = stage / "supplement"
        supplement.mkdir(); write(supplement / "selection.json", spec)
        shutil.copyfile(source / "SOURCE_MANIFEST.json", supplement / "source-records.json")
        manifest = json.loads((source / "paper/manifests/publication_v2.json").read_text())
        keys = {c["key"] for c in spec["cohorts"]}; jobs = {c["jobKey"] for c in spec["cohorts"]}
        manifest["cohorts"] = [c for c in manifest["cohorts"] if c["key"] in keys]
        manifest["jobs"] = [j for j in manifest["jobs"] if j["key"] in jobs]
        manifest["ablations"] = [a for a in manifest.get("ablations", []) if a["cohortKey"] in keys]
        if len(manifest["cohorts"]) != len(keys) or len(manifest["jobs"]) != len(jobs):
            raise ValueError("Publication manifest lacks the registered cohorts")
        write(supplement / "linux-replay.json", manifest)
        metadata = json.loads((project / "paper/outputs/publication_v2/benchmarks/run_metadata.json").read_text())
        bindings = {cohort["key"]: baseline_for(cohort, project, source, metadata, supplement) for cohort in spec["cohorts"]}
        write(supplement / "scientific-source-bindings.json", {"historicalSnapshot": spec["historicalReferenceSnapshot"],
              "selectedSnapshot": spec["sourceSnapshot"], "cohorts": bindings})
        root_tools = ("Supplement.Dockerfile", "Browser.Dockerfile", "launch.sh", "browser_qa.sh")
        for name in ("compare_runs.py", "replay_receipts.py", "input_identity.py", "execute.py", *root_tools):
            shutil.copy2(ROOT / "scripts/repro" / name, (stage if name in root_tools else supplement) / name)
        write(supplement / "supplement-sha256.json", {str(p.relative_to(supplement)): digest(p)
              for p in sorted(supplement.rglob("*")) if p.is_file()})
        shutil.copyfile(ROOT / "paper/evaluation/linux-replay/RUNBOOK.md", stage / "RUNBOOK.md")
        for name in ("record.schema.json", "intervention.schema.json", "operator-attestation.template.json"):
            shutil.copyfile(ROOT / "paper/evaluation/linux-replay" / name, stage / name)
        shutil.copyfile(archive, stage / archive.name)
        files = {str(p.relative_to(stage)): digest(p) for p in sorted(stage.rglob("*")) if p.is_file()}
        write(stage / "kit-manifest.json", {"schemaVersion": 1, "sourceArchiveSha256": spec["sourceArchiveSha256"],
              "historicalReferenceArchiveSha256": spec["historicalReferenceArchiveSha256"],
              "distribution": spec["distribution"], "files": files})
        stage.rename(destination)
        print(f"Prepared {destination}. kit-manifest.json SHA256 {digest(destination / 'kit-manifest.json')}")
    finally:
        if stage.exists():
            shutil.rmtree(stage)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--destination", required=True, type=Path)
    parser.add_argument("--baseline-project", type=Path, default=ROOT)
    parser.add_argument("--archive", type=Path, default=ROOT / "paper/outputs/publication_v2/release/pnv-source-9bb30adcf4fe.zip")
    parser.add_argument("--public-receipt", type=Path, help="Explicit receipt for a reviewed public-safe ZIP with the same scientific execution bindings")
    args = parser.parse_args()
    prepare(args.baseline_project.resolve(), args.archive.resolve(), args.destination.resolve(), args.public_receipt)
