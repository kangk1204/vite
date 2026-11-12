# Reproducibility and evidence boundaries

The accepted workflow uses local R inference and offline reports. Counts, metadata, contrasts, reference contents, code and environments require explicit identifiers; a displayed Git commit alone is insufficient in a dirty working tree.

## Analysis reruns

```bash
npm run paper:benchmark
```

Run `bash scripts/setup_case_study_env.sh` to restore the statistical environment and check compressed GEO inputs. The independent-operator instructions are in `evaluation/linux-replay/RUNBOOK.md`. The README documents the local-input CLI. Standard DESeq2 Wald inference, apeglm display effects and fgsea outputs are separate from CAMERA/sample-resampling sensitivity. Preserve all tested pathways and the original testing family.

Rerun evidence includes actual content hashes, exact code/package versions, seeds, fitted design, exclusions/mapping records and output hashes. A container digest must be real. Environment pinning and availability of a container runtime are separate facts.

## Verification states

- `verified_against_supplied_artifacts`: supplied files were actually compared with recorded hashes.
- `internally_consistent`: report contents agree; original files were not rechecked.
- `unverifiable`: required evidence is absent.
- `mismatch`: supplied values/files contradict the record.

None proves biological annotation truth. Legacy imports without explicit methods remain unverified; methods are not inferred from prose.

## Evaluation tools

```bash
npx vitest run tests/studyProtocol.test.js
node scripts/study/run_study.mjs status --protocol paper/evaluation/protocol.json
node scripts/study/smoke.mjs
Rscript scripts/study/power_study.R paper/evaluation/power-config.json /tmp/pnv-power-smoke.json --smoke
```

Smoke outputs are synthetic and cannot pass main-study origin checks. Smoke power output cannot define recruitment. Full commands and gates are in `evaluation/README.md`.

## Archival outputs

Existing `results/` and `paper/outputs/ymeth_pivot/` contain older outputs, not automatically validated v2 results. Old replication filenames are retained for compatibility; their heterogeneous-cohort metrics are conditional cross-context summaries. Historical feature scores are not comparative-performance evidence.

Institutional determination/consent, expert adjudication, pilot/main collection, preregistration and independent environment execution require real external records. Scripts and AI reviewer notes do not satisfy those gates.
