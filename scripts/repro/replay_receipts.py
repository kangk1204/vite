#!/usr/bin/env python3
"""Summarize cold/cached publication receipts and same-image direct R parity."""
import argparse
import hashlib
import json
from pathlib import Path


def read(path):
    return json.loads(path.read_text())


def check_cache(cold, cached, jobs, cohorts):
    fitted = {k: cold.get("jobs", {}).get(k, {}).get("skipped") is False for k in jobs}
    reused = {k: cached.get("jobs", {}).get(k, {}).get("skipped") is True for k in jobs}
    fresh = {k: cold.get("cohorts", {}).get(k, {}).get("finalization", {}).get("reused") is False for k in cohorts}
    reports = {k: cached.get("cohorts", {}).get(k, {}).get("finalization", {}).get("reused") is True for k in cohorts}
    def artifact_hashes(metadata, key):
        return {a["path"]: a["sha256"] for a in metadata.get("cohorts", {}).get(key, {}).get("artifacts", [])}
    same = {k: bool(artifact_hashes(cold, k)) and artifact_hashes(cold, k) == artifact_hashes(cached, k) for k in cohorts}
    return {"coldJobsFitted": fitted, "cachedJobsReused": reused, "coldReportsBuilt": fresh,
            "cachedReportsReused": reports, "recordedOutputHashesIdentical": same,
            "pass": all(all(group.values()) for group in (fitted, reused, fresh, reports, same))}


def check_scope(evidence, cohort):
    b = evidence["bootstrap"]
    samples = len(evidence["sourceTables"]["metadata"]["rows"])
    failed = len(b.get("failures", []))
    passed = (samples == cohort["samples"] and b["requested"] == cohort["bootstrap"]
              and b["completed"] + failed == b["requested"]
              and len(evidence["pathways"]) == evidence["analysis"]["pathwayHypothesisCount"])
    return {"samples": samples, "requested": b["requested"], "completed": b["completed"], "failed": failed,
            "testedPathways": evidence["analysis"]["pathwayHypothesisCount"], "pass": passed}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("project", type=Path)
    parser.add_argument("kit", type=Path)
    parser.add_argument("audit", type=Path)
    args = parser.parse_args()
    plan = read(args.kit / "selection.json")
    cold = read(args.audit / "cold-metadata.json")
    cached = read(args.audit / "cached-metadata.json")
    cohorts = plan["cohorts"]
    result = check_cache(cold, cached, [c["jobKey"] for c in cohorts], [c["key"] for c in cohorts])
    result["directPackageParity"] = {}
    result["cohortScope"] = {}
    for cohort in cohorts:
        path = args.project / cohort["outputDir"] / "reference_validation.json"
        parity = read(path)
        evidence = read(args.project / cohort["outputDir"] / (cohort["prefix"] + "_evidence.json"))["evidence"]
        result["cohortScope"][cohort["key"]] = check_scope(evidence, cohort)
        checks = parity.get("checks", [])
        result["directPackageParity"][cohort["key"]] = {
            "passed": parity.get("status") == "pass" and len(checks) == 18 and all(c.get("pass") is True for c in checks),
            "checks": len(checks), "absoluteTolerance": parity.get("absoluteTolerance"),
            "relativeTolerance": parity.get("relativeTolerance"), "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}
    result["pass"] = (result["pass"] and all(c["passed"] for c in result["directPackageParity"].values())
                      and all(c["pass"] for c in result["cohortScope"].values()))
    (args.audit / "cache-and-parity.json").write_text(json.dumps(result, indent=2) + "\n")
    if not result["pass"]:
        raise SystemExit("Cold/cached orchestration or same-image direct-package parity failed. See cache-and-parity.json.")


if __name__ == "__main__":
    main()
