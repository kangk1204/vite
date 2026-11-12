#!/usr/bin/env python3
"""Compare actual R input hashes, including regenerated airway counts and donor labels."""
import argparse
import json
from pathlib import Path


def compare_inputs(project, plan, publication_dir=None):
    comparisons = {}
    for c in plan["cohorts"]:
        directory = (publication_dir / Path(c["outputDir"]).relative_to("paper/outputs/publication_v2")
                     if publication_dir else project / c["outputDir"])
        evidence = json.loads((directory / (c["prefix"] + "_evidence.json")).read_text())["evidence"]
        actual = {a["role"]: a["sha256"] for a in evidence["executionCapture"]["artifacts"]
                  if a["role"] in ("raw_counts", "sample_metadata")}
        expected = plan["originalInputSha256"][c["key"]]
        comparisons[c["key"]] = {"expected": expected, "actual": actual, "match": expected == actual}
    return {"schemaVersion": 1, "status": "matched" if all(x["match"] for x in comparisons.values()) else "input_differences_observed", "cohorts": comparisons}


if __name__ == "__main__":
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("project", type=Path); p.add_argument("selection", type=Path); p.add_argument("output", type=Path)
    p.add_argument("--publication-dir", type=Path, help="Use exported publication_v2 outputs from a removed container")
    args = p.parse_args(); result = compare_inputs(args.project, json.loads(args.selection.read_text()), args.publication_dir)
    args.output.write_text(json.dumps(result, indent=2) + "\n")
    if result["status"] != "matched":
        raise SystemExit("The actual input bytes differ; inspect input-identity.json before comparing statistical outputs.")
