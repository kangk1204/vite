#!/usr/bin/env python3
"""Execute the frozen publication entrypoint twice inside the Linux image."""
import argparse
import hashlib
import json
import os
import platform
import resource
import shutil
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path


def now():
    return datetime.now(timezone.utc).isoformat()


def dump(path, value):
    temp = path.with_suffix(path.suffix + ".tmp")
    temp.write_text(json.dumps(value, indent=2, allow_nan=False) + "\n")
    temp.replace(path)


def digest(path):
    h = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def timed(command, label, project, audit, limit):
    start = time.monotonic()
    receipt = {"phase": label, "startedAt": now(), "command": command}
    with (audit / f"{label}.log").open("w") as log:
        proc = subprocess.run(["/usr/bin/time", "-v", "-o", str(audit / f"{label}-time.txt"),
                               "timeout", "--kill-after=45s", str(limit), *command],
                              cwd=project, stdout=log, stderr=subprocess.STDOUT)
    stats = (audit / f"{label}-time.txt").read_text()
    rss = next((int(line.rsplit(":", 1)[1]) for line in stats.splitlines() if "Maximum resident set size" in line), None)
    receipt.update(endedAt=now(), elapsedSeconds=time.monotonic() - start, maxRssKiB=rss, exitCode=proc.returncode)
    dump(audit / f"{label}-receipt.json", receipt)
    if proc.returncode:
        raise RuntimeError(f"{label} exited {proc.returncode}. Inspect {label}.log.")
    return receipt


def verify_files(base, records):
    for name, expected in records.items():
        path = base / name
        if not path.is_file() or digest(path) != expected:
            raise ValueError(f"Digest mismatch or missing input {name}")


def run(project, kit, audit, role, phase_limit):
    if platform.system() != "Linux":
        raise RuntimeError("This runner requires a Linux guest or native Linux host")
    audit.mkdir(parents=True, exist_ok=True)
    if any(audit.iterdir()):
        raise ValueError("Use a fresh audit directory for each replay")
    if (project / "paper/outputs/publication_v2").exists() or (project / ".cache/bootstrap").exists():
        raise ValueError("The cold run requires an empty publication-output and bootstrap cache")
    spec = json.loads((kit / "selection.json").read_text())
    metadata = {"schemaVersion": 1, "status": "running", "operatorRole": role,
                "startedAt": now(), "baseImage": spec["baseImage"], "archiveSha256": spec["sourceArchiveSha256"],
                "sourceSnapshot": spec["sourceSnapshot"], "historicalReferenceSnapshot": spec.get("historicalReferenceSnapshot", spec["sourceSnapshot"]),
                "imageId": os.environ.get("PNV_ANALYSIS_IMAGE_ID"), "platform": platform.uname()._asdict(),
                "osRelease": Path("/etc/os-release").read_text(), "nodeVersion": subprocess.check_output(["node", "--version"], text=True).strip(),
                "cpuCount": os.cpu_count(), "cpuQuota": read_optional("/sys/fs/cgroup/cpu.max"),
                "memoryLimitBytes": read_optional("/sys/fs/cgroup/memory.max"),
                "manualInterventionsFile": "manual-interventions.jsonl", "phases": []}
    dump(audit / "status.json", metadata)
    (audit / "manual-interventions.jsonl").touch()
    try:
        verify_files(project, {v["path"]: v["sha256"] for v in json.loads((kit / "source-records.json").read_text())["files"]})
        verify_files(kit, json.loads((kit / "supplement-sha256.json").read_text()))
        if metadata["nodeVersion"] != "v" + spec["node"] or digest(project / "renv.lock") != spec["renvLockSha256"]:
            raise ValueError("Node version or R lock differs from frozen selection")
        shutil.copytree(kit / "inputs", project, dirs_exist_ok=True)
        manifest = "paper/manifests/linux-replay.json"
        shutil.copyfile(kit / "linux-replay.json", project / manifest)
        check_environment(project, audit, spec)
        for phase in ("cold", "cached"):
            metadata["currentPhase"] = phase; dump(audit / "status.json", metadata)
            metadata["phases"].append(timed(["node", "scripts/run_paper_benchmark.mjs", manifest], phase, project, audit, phase_limit))
            shutil.copyfile(project / "paper/outputs/publication_v2/benchmarks/run_metadata.json", audit / f"{phase}-metadata.json")
        subprocess.run([sys.executable, str(kit / "replay_receipts.py"), str(project), str(kit), str(audit)], check=True)
        subprocess.run([sys.executable, str(kit / "input_identity.py"), str(project), str(kit / "selection.json"), str(audit / "input-identity.json")], check=True)
        subprocess.run([sys.executable, str(kit / "compare_runs.py"), str(project), str(kit), str(audit / "cross-platform.json")], check=True)
        metadata.update(status="completed", crossPlatform=json.loads((audit / "cross-platform.json").read_text())["status"])
    except Exception as exc:
        metadata.update(status="failed", error=str(exc))
        raise
    finally:
        metadata.update(endedAt=now(), cgroupPeakBytes=read_optional("/sys/fs/cgroup/memory.peak"),
                        maxChildRssKiB=resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss)
        dump(audit / "status.json", metadata)


def read_optional(name):
    path = Path(name)
    return path.read_text().strip() if path.is_file() else None


def check_environment(project, audit, spec):
    with (audit / "environment.json").open("w") as out, (audit / "environment.stderr.log").open("w") as err:
        subprocess.run(["Rscript", "scripts/verify_analysis_env.R"], cwd=project, stdout=out, stderr=err, check=True)
    env = json.loads((audit / "environment.json").read_text())
    versions = {p["package"]: p["actual"] for p in env["packages"]}
    if env["R"]["actual"] != spec["R"] or not env["allPackagesMatch"] or versions.get("BiocVersion", "").split(".")[:2] != spec["Bioconductor"].split("."):
        raise ValueError("Actual R or Bioconductor release differs from the frozen environment")
    code = "p<-c('R.methodsS3','R.oo','R.utils');cat(jsonlite::toJSON(setNames(lapply(p,function(x)as.character(packageVersion(x))),p),auto_unbox=TRUE))"
    extras = json.loads(subprocess.check_output(["Rscript", "-e", code], cwd=project, text=True))
    dump(audit / "supplemental-gzip-reader.json", extras)
    if extras != spec["supplementalGzipReader"]:
        raise ValueError("The gzip-reader packages differ from the original PD execution session")
    probes = {}
    for name, preload in (("implicit", ""), ("preloaded", "stopifnot(requireNamespace('SparseArray',quietly=TRUE));")):
        code = preload + "f<-function(){x<-asNamespace('SparseArray');invisible(NULL)};f();cat('SparseArray',as.character(packageVersion('SparseArray')),'returned\\n')"
        probe = subprocess.run(["Rscript", "-e", code], cwd=project, capture_output=True, text=True, timeout=120)
        log = probe.stdout + probe.stderr
        (audit / f"sparsearray-{name}.log").write_text(log)
        probes[name] = {"exitCode": probe.returncode, "stackImbalance": "stack imbalance" in log.lower()}
        if probe.returncode:
            raise RuntimeError(f"SparseArray {name} probe failed")
    dump(audit / "sparsearray.json", probes)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project", type=Path, default=Path("/opt/pnv"))
    parser.add_argument("--kit", type=Path, default=Path("/replay"))
    parser.add_argument("--audit", type=Path, default=Path("/audit"))
    parser.add_argument("--role", choices=["same-host-technical", "independent-operator"], required=True)
    parser.add_argument("--phase-limit", type=int, default=14400)
    args = parser.parse_args()
    run(args.project.resolve(), args.kit.resolve(), args.audit.resolve(), args.role, args.phase_limit)
