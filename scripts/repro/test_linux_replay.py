"""Focused invariants for the external replay supplement (stdlib only)."""
import json
import tempfile
import unittest
from pathlib import Path

from compare_runs import compare_table, compare_bootstrap
from replay_receipts import check_cache, check_scope
from prepare import reject_withheld_members, verify_scientific_sources
from pack_kit import pack
from input_identity import compare_inputs


class ComparisonTests(unittest.TestCase):
    def test_magnitude_direction_missing_and_decision_changes(self):
        with tempfile.TemporaryDirectory() as tmp:
            baseline, replay = [Path(tmp) / x for x in ("a.tsv", "b.tsv")]
            baseline.write_text("gene\tstat\tpadj\tlog2FoldChange\n001\t-2\t0.049\t-1.2\n002\tNA\t\t0\n")
            replay.write_text("gene\tstat\tpadj\tlog2FoldChange\n002\t0\t\t0\n001\t2\t0.051\t-1.2\n")
            result = compare_table(baseline, replay, "genes", columns=["stat", "padj", "log2FoldChange"])
            self.assertEqual(result["ids"]["shared"], 2)
            self.assertEqual(result["numeric"]["stat"]["missingChanges"], 1)
            self.assertEqual(result["numeric"]["stat"]["directionChanges"], 1)
            self.assertEqual(result["decisions"]["bh05"], 1)
            self.assertEqual(result["decisions"]["bh05_abs_lfc_gt1"], 1)

    def test_duplicate_ids_fail_and_leading_edge_order_is_irrelevant(self):
        with tempfile.TemporaryDirectory() as tmp:
            a, b = [Path(tmp) / x for x in ("a.tsv", "b.tsv")]
            header = "pathway_id\tNES\tpadj\tleadingEdge\n"
            a.write_text(header + "R1\t1\t.1\tA;B\n")
            b.write_text(header + "R1\t1\t0.1\tB;A\n")
            self.assertEqual(compare_table(a, b, "pathways", columns=["NES", "padj"])["sets"]["changed"], 0)
            b.write_text(b.read_text() + "R1\t1\t.1\tC\n")
            with self.assertRaisesRegex(ValueError, "duplicate"):
                compare_table(a, b, "pathways", columns=["NES", "padj"])

    def test_bootstrap_absent_and_conditional_denominators_are_distinguished(self):
        expected = {"R1": {"bootstrap": {"requested": 500, "valid": 400, "selected": 200, "directionMatches": 300}}}
        changed = {"R1": {"bootstrap": {"requested": 500, "valid": 500, "selected": 200, "directionMatches": 300}}}
        self.assertEqual(compare_bootstrap(expected, changed)["changedPathways"], 1)
        self.assertEqual(compare_bootstrap({}, {})["expectedPathways"], 0)


class CacheTests(unittest.TestCase):
    def test_cached_stage_requires_both_job_and_report_reuse(self):
        cold = {"jobs": {"a": {"skipped": False}}, "cohorts": {"c": {"finalization": {"reused": False},
                "artifacts": [{"path": "c.tsv", "sha256": "123"}]}}}
        warm = json.loads(json.dumps(cold)); warm["jobs"]["a"]["skipped"] = True
        self.assertFalse(check_cache(cold, warm, ["a"], ["c"])["pass"])
        warm["cohorts"]["c"]["finalization"]["reused"] = True
        self.assertTrue(check_cache(cold, warm, ["a"], ["c"])["pass"])
        warm["cohorts"]["c"]["artifacts"][0]["sha256"] = "changed"
        self.assertFalse(check_cache(cold, warm, ["a"], ["c"])["pass"])

    def test_all_requested_resamples_must_be_accounted_for(self):
        cohort = {"samples": 2, "bootstrap": 500}
        e = {"sourceTables":{"metadata":{"rows":[[], []]}}, "pathways":{"p":{}},
             "analysis":{"pathwayHypothesisCount":1}, "bootstrap":{"requested":500,"completed":499,"failures":[]}}
        self.assertFalse(check_scope(e, cohort)["pass"])
        e["bootstrap"]["failures"].append({"iteration": 17, "reason": "singular"})
        self.assertTrue(check_scope(e, cohort)["pass"])


class HandoffTests(unittest.TestCase):
    def test_public_handoff_rejects_withheld_documents_and_original_zip(self):
        for name in ("paper/evaluation/case-manifest.seed.json", "paper/manuscript.md", "nested/pnv-source-9bb30adcf4fe.zip"):
            with self.assertRaisesRegex(ValueError, "Private material"):
                reject_withheld_members([name])

    def test_successor_source_requires_exact_original_scientific_bindings(self):
        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp); (source / "core.R").write_text("changed")
            evidence = {"executionCapture": {"artifacts": [{"role": role,"path":"project:core.R","sha256":"original"}
                for role in ("analysis_code", "analysis_config", "reference", "environment")]}}
            with self.assertRaisesRegex(ValueError, "differs from original"):
                verify_scientific_sources(evidence, source)

    def test_changed_file_cannot_leave_distributable_partial_zip(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); kit = root / "kit"; kit.mkdir()
            (kit / "input").write_text("changed")
            (kit / "kit-manifest.json").write_text(json.dumps({"files": {"input": "wrong"}, "distribution": "public-source-handoff"}))
            with self.assertRaisesRegex(ValueError, "Changed kit file"):
                pack(kit, root / "operator.zip", True)
            self.assertFalse((root / "operator.zip").exists())

    def test_changed_regenerated_input_is_visible_even_with_same_sample_count(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); out = root / "airway"; out.mkdir()
            (out / "paired_evidence.json").write_text(json.dumps({"evidence":{"executionCapture":{"artifacts":[
                {"role":"raw_counts","sha256":"new"}, {"role":"sample_metadata","sha256":"same"}]}}}))
            plan = {"cohorts":[{"key":"a","outputDir":"airway","prefix":"paired"}],
                    "originalInputSha256":{"a":{"raw_counts":"old","sample_metadata":"same"}}}
            self.assertEqual(compare_inputs(root, plan)["status"], "input_differences_observed")


if __name__ == "__main__":
    unittest.main()
