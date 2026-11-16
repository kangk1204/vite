# Reproducibility and evidence boundaries

The accepted workflow uses local R inference and offline reports. Counts, metadata, contrasts, reference contents, code and environments require explicit identifiers; a displayed Git commit alone is insufficient in a dirty working tree.

The current revision uses paper/manifests/publication_2026_11_16.json and paper/outputs/publication_2026_11_16. Earlier publication_v2 results retain their original execution identities.

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
Rscript scripts/study/power_study.R paper/evaluation/power-config.json /tmp/pnv-power-smoke.json --smoke
```

Live-task study operations run in the coordinator workspace with a frozen case file. The protocol status command and public diagnostic examples are available in the software distribution. Smoke power checks execution; final recruitment uses the calibrated result after the pilot. Full commands and data requirements are in `evaluation/README.md`.

## Archival outputs

Existing `results/` and `paper/outputs/ymeth_pivot/` contain older outputs, not automatically validated v2 results. Old replication filenames are retained for compatibility; their heterogeneous-cohort metrics are conditional cross-context summaries. Historical feature scores are not comparative-performance evidence.

Institutional determination/consent, expert adjudication, pilot/main collection, preregistration and independent environment execution require real external records. Scripts and AI reviewer notes do not satisfy those gates.
