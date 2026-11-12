#!/usr/bin/env python3
"""Preserve inspectable records and derive a compact outcome table from a finished replay."""
import argparse
import gzip
import json
import shutil
from pathlib import Path

from input_identity import compare_inputs
from replay_receipts import check_scope


def read(path):
    return json.loads(path.read_text())


def collect(run, spec, destination):
    audit = run / "audit"
    status = read(audit / "status.json")
    if status["status"] != "completed":
        raise ValueError("Calculation has not completed. Keep the original attempt records.")
    parity, comparison = [read(audit / n) for n in ("cache-and-parity.json", "cross-platform.json")]
    if not parity["pass"]:
        raise ValueError("Cache/direct-package parity gate did not pass")
    inputs = compare_inputs(Path("."), spec, run / "publication/publication_v2")
    destination.mkdir(parents=True, exist_ok=True)
    (destination / "input-identity.json").write_text(json.dumps(inputs, indent=2) + "\n")
    for name in ("status.json", "cache-and-parity.json", "cross-platform.json", "environment.json",
                 "supplemental-gzip-reader.json", "sparsearray.json", "sparsearray-implicit.log", "sparsearray-preloaded.log",
                 "cold-time.txt", "cached-time.txt", "cold-receipt.json", "cached-receipt.json", "manual-interventions.jsonl"):
        shutil.copy2(audit / name, destination / name)
    for name in ("cold.log", "cached.log", "cold-metadata.json", "cached-metadata.json"):
        (destination / (name + ".gz")).write_bytes(gzip.compress((audit / name).read_bytes(), mtime=0))
    for name in ("oci-manifest.json", "analysis-image-id.txt", "container-engine.txt", "build-started-utc.txt", "build-ended-utc.txt"):
        shutil.copy2(run / name, destination / name)
    env = read(audit / "environment.json")
    rows = []
    for c in spec["cohorts"]:
        key = c["key"]; result = comparison["cohorts"][key]; t = result["tables"]
        genes, paths = t["genes"], t["pathways"]
        directory = run / "publication" / Path(c["outputDir"]).relative_to("paper/outputs")
        e = read(directory / (c["prefix"] + "_evidence.json"))["evidence"]
        scope = check_scope(e, c)
        if not scope["pass"]:
            raise ValueError(f"Unexpected sample/replicate/pathway scope for {key}: {scope}")
        rows.append({"cohort": key, "genes": genes["ids"]["shared"], "pathways": paths["ids"]["shared"],
                     "allIdSetsMatch": all(v["ids"]["onlyReference"] == v["ids"]["onlyReplay"] == 0 for v in t.values()),
                     "sampleLabelChanges": t["samples"]["labelChanges"], "geneBhStatusChanges": genes["decisions"]["bh05"],
                     "geneBhAndLfcStatusChanges": genes["decisions"]["bh05_abs_lfc_gt1"], "pathwayBhStatusChanges": paths["decisions"]["bh05"],
                     "waldMaxAbsoluteDifference": genes["numeric"]["stat"]["maxAbsoluteDifference"],
                     "waldSignChanges": genes["numeric"]["stat"]["directionChanges"],
                     "nesMaxAbsoluteDifference": paths["numeric"]["NES"]["maxAbsoluteDifference"],
                     "nesSignChanges": paths["numeric"]["NES"]["directionChanges"],
                     "leadingEdgeSetChanges": paths["sets"]["changed"],
                     "missingStatisticCellChanges": sum(n["missingChanges"] for v in t.values() for n in v["numeric"].values()),
                     "bootstrapRequested": e["bootstrap"]["requested"], "bootstrapCompleted": e["bootstrap"]["completed"],
                     "bootstrapPathwayCountChanges": result["bootstrap"]["changedPathways"]})
    summary = {"schemaVersion": 1, "operatorRole":status["operatorRole"],"archiveSha256":status["archiveSha256"],
               "R": env["R"], "lockedPackages": len(env["packages"]), "allLockedPackageVersionsMatch":env["allPackagesMatch"],
               "sameImageDirectParityAndCache":parity["pass"], "inputBytes":inputs["status"],
               "macToLinuxComparison":comparison["status"], "phases":status["phases"], "cohorts":rows}
    (destination / "technical-summary.json").write_text(json.dumps(summary, indent=2) + "\n")
    return summary


if __name__ == "__main__":
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument("run", type=Path); p.add_argument("selection", type=Path); p.add_argument("destination", type=Path)
    args=p.parse_args(); print(json.dumps(collect(args.run, read(args.selection), args.destination), indent=2))
