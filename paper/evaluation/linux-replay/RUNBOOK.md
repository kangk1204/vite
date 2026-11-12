# Linux replay, operator protocol 1.0

Use the archived source snapshot `9bb30adcf4fe`, the paired `airway` dataset (four donors, eight samples), and the GSE68719 Parkinson disease contrast (73 samples). The manifest retains the PD covariates, 500 bootstrap resamples, and group-only sensitivity analysis. The frozen release provides an R 4.5.1/Bioconductor 3.22 image pinned by OCI digest. The supplemental image adds Node 25.8.0 and the archived npm dependencies so the program can generate both offline reports.

## Prepare the handoff

From the implementing team's checkout, run the following command with Python 3.11 or newer. The destination must be new. Allow roughly 5 GB of disk for the complete analysis outputs and additional space for the container build.

```bash
python3 scripts/repro/prepare.py --archive /absolute/path/public-source.zip \
  --public-receipt /absolute/path/source-snapshot.json --destination /absolute/path/pnv-linux-kit
```

The public handoff contains the reviewed public source archive, its verified extraction, the two-cohort manifest, the original public PD input bytes, compact macOS comparison tables, checksums, and the runnable supplement. The preparer checks the original execution-time hashes for the inference code, selected cohort configs, references and R lock against the new archive. `scientific-source-bindings.json` records both snapshot identities. The preparer also checks the published execution receipts for each expected table and PD input. Supply the directory and its printed `kit-manifest.json` SHA-256 to the external operator. The implementing team can use the historical source with the default `--archive` for a private replay. The historical archive includes unpublished study material and stays in controlled storage.

Create the distributable ZIP alongside its checksum receipt with `python3 scripts/repro/pack_kit.py /absolute/path/pnv-linux-kit /absolute/path/pnv-linux-operator-kit.zip --public`. The public export requires a kit built with a public receipt. The recipient unzips it and enters the included `pnv-linux-kit` directory.

## Run on Linux

Use an arm64 or amd64 Linux machine with Docker or nerdctl, Python 3.11+, 6 CPUs, and at least 10 GiB of available memory. The build needs network access to Docker Hub, the R package repositories, nodejs.org and npm. The analysis container runs with networking disabled. Select an empty result destination. Compare the supplied kit manifest checksum before execution.

```bash
cd /absolute/path/pnv-linux-kit
sha256sum kit-manifest.json
bash launch.sh /absolute/path/pnv-linux-run independent-operator
```

For rootless nerdctl set `CONTAINER_ENGINE=nerdctl`. An implementing team member running a Linux VM on the original host uses `same-host-technical`. Record the operator, hardware, OS, date, and any manual action in the handoff record. The independent-operator label is the operator's declaration. Authorship requires a separately attributable operator record before the manuscript can describe external replication.

The launcher verifies the Dockerfile's OCI index and the arm64/amd64 child manifest digests. It builds the archived Dockerfile, adds the orchestration tools, records the resulting image ID, and creates a new container. `environment.json` verifies all 128 installed R package versions. The original PD session also used `R.utils` 2.13.0, `R.oo` 1.27.1 and `R.methodsS3` 1.8.2 to read compressed counts. An initial Linux run restored all 128 locked packages and stopped at `data.table::fread()` because the lock omitted these optional I/O dependencies. The supplementary image verifies their CRAN archive SHA-256 values, installs the original versions and records them in `supplemental-gzip-reader.json`. The installed BiocVersion package provides the actual Bioconductor release. Startup probes record the SparseArray namespace diagnostic with implicit and explicit loading.

## Read and return the evidence

- `audit/status.json` records role, OS/kernel, architecture, image ID, resource limits, phase status and actual wall times. `cold-time.txt` and `cached-time.txt` contain GNU time output. Its maximum RSS means the maximum reported for the timed process and its children. The cgroup peak covers the whole container lifetime.
- `audit/cold-metadata.json` and `cached-metadata.json` preserve the two original orchestration receipts. `cache-and-parity.json` requires fresh fits and report builds on the cold run, reused fits and reports on the cached run, and all 18 direct-package comparisons for each cohort.
- `audit/input-identity.json` checks the input bytes recorded by the R execution against the original PD and airway hashes. This includes the airway count matrix and paired donor metadata regenerated on Linux.
- `audit/cross-platform.json` compares macOS and Linux by row identity, missingness, sign, numeric values, leading-edge gene sets, BH decisions, and bootstrap denominators. It measures every absolute/relative deviation above the recorded tolerance and lists examples. Differences may be informative even when the FDR decision agrees. Preserve the report and investigate differing decisions.
- `publication/publication_v2` contains the Linux tables, execution captures, full/basic reports, RO-Crates, direct reference results, and the group-only sensitivity. Keep these files with the machine-readable receipts. Add each manual intervention to `audit/manual-interventions.jsonl` with UTC time, command or action, reason and outcome. An empty file records zero manual interventions during the automated analysis.
- The final browser stage uses a disposable Linux Chromium image after the timed analysis has finished. `linux-browser/browser-verification.json` records four offline report opens (two conditions per cohort), request and page-error counts, and the SHA-256 and sizes of the actual SVG, PNG and PDF downloads. The original exported files and screenshots are under `linux-browser/artifacts`.

Return the audit directory, OCI and image records, build logs and an operator attestation. Use a new result directory for each retry. Preserve failed attempts and the recorded reason. Build-layer reuse and scientific-result reuse are measured separately. Published macOS statistics enter only the final comparison. The cold Linux fit reads public inputs and the packaged airway data.
