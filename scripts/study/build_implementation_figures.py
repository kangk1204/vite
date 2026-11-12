#!/usr/bin/env python3
"""Code-backed architecture and finalized, hash-verified integration-check figures."""
import argparse
import csv
import hashlib
import json
import os
import re
import shutil
import subprocess
import tempfile
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from xml.sax.saxutils import escape

SUPPLEMENTARY_STEMS = ("supplementary_figure_s1_evidence_workflow", "supplementary_figure_s2_integration_checks")

CHECK_IDS = ["gene-identifiers", "genes-stat", "genes-pvalue", "genes-padj", "genes-log2FoldChangeUnshrunk",
             "genes-log2FoldChange", "genes-lfcSE", "pathway-identifiers", "pathways-ES", "pathways-NES",
             "pathways-pval", "pathways-padj", "pathways-size", "leading-edge-sets", "camera-identifiers",
             "camera-pvalue", "camera-padj", "camera-direction"]
CHECK_LABELS = ["Gene identifiers", "Wald statistic", "Gene p-value", "Gene adjusted p-value", "Unshrunk log2FC",
                "Shrunk log2FC", "LFC standard error", "Pathway identifiers", "Enrichment score (ES)", "Normalized ES",
                "Pathway p-value", "Pathway adjusted p-value", "Pathway size", "Leading-edge gene sets",
                "CAMERA identifiers", "CAMERA p-value", "CAMERA adjusted p-value", "CAMERA direction"]
COHORT_LABELS = {"gse68719_pd_primary": "PD\nGSE68719", "gse159699_ad_replication": "AD\nGSE159699",
                 "gse102556_mdd_extension": "MDD\nGSE102556", "gse290452_akap11_model_extension": "AKAP11\nGSE290452",
                 "airway_paired_reference": "Airway\nGSE52778"}
COLORS = {"pass": "#127c83", "pending": "#e2e8f0", "ink": "#183244", "blue": "#eaf3fa", "amber": "#fff3d1"}


def sha256(file):
    digest = hashlib.sha256()
    with Path(file).open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def verify_artifact(artifact, root):
    relative = artifact.get("path", "")
    if relative.startswith("project:"):
        relative = relative[8:]
    file = (root / relative).resolve()
    if not relative or Path(relative).is_absolute() or not file.is_relative_to(root.resolve()):
        raise ValueError("Artifact path escapes the project root.")
    if not file.is_file() or file.stat().st_size != artifact.get("sizeBytes") or sha256(file) != artifact.get("sha256"):
        raise ValueError(f"Missing or stale artifact: {relative}")
    return file


def read_parity(file):
    data = json.loads(Path(file).read_text())
    checks = data.get("checks", [])
    if data.get("status") != "pass" or len(checks) != len(CHECK_IDS) or {c.get("id") for c in checks} != set(CHECK_IDS) or any(c.get("pass") is not True for c in checks):
        raise ValueError(f"Expected exactly eighteen passing standard-package integration checks: {file}")
    if data.get("absoluteTolerance") != 1e-8 or data.get("relativeTolerance") != 1e-8:
        raise ValueError("The recorded numerical comparison tolerance differs from the figure contract.")
    return data


# This read-only verifier mirrors finalize_publication_v2.mjs's input descriptor.
# Reusing its hash primitives avoids a Python/JavaScript JSON ordering mismatch.
NODE_VERIFY = r"""
import fs from 'node:fs'; import path from 'node:path';
import {fingerprintFiles,sha256,artifactManifestMatches,resolveArtifactPath} from './scripts/lib/provenance.mjs';
import {listFiles} from './scripts/lib/provenance_pipeline.mjs';
import {captureRuntimeEnvironment} from './scripts/lib/provenance_run.mjs';
import {verifyExecutionCapture} from './scripts/finalize_publication_v2.mjs';
const manifestPath=process.argv[1],root=process.cwd();
const manifest=JSON.parse(fs.readFileSync(manifestPath,'utf8'));
const receipt=JSON.parse(fs.readFileSync(path.join(root,manifest.outputRoot,'benchmarks/finalization.json'),'utf8'));
const environment=captureRuntimeEnvironment(root); const cohorts=[];
for(const cohort of manifest.cohorts.filter(c=>c.enabled!==false)){
 const finalized=receipt.cohorts?.[cohort.key];
 if(!finalized||finalized.verification!=='verified_against_supplied_artifacts'||finalized.referenceParity!=='pass'||finalized.fullBasicEvidenceIdentical!==true)throw new Error('Missing or incomplete finalization: '+cohort.key);
 if(!artifactManifestMatches(finalized.artifacts,{root}))throw new Error('Stale finalized outputs: '+cohort.key);
 const required=[cohort.evidencePath,cohort.workbookPath,cohort.referenceInputPath,cohort.degTablePath,cohort.pathwayTablePath,cohort.sampleMetadataPath,cohort.summaryTablePath].filter(Boolean);
 const ablation=(manifest.ablations||[]).find(a=>a.cohortKey===cohort.key);
 const extras=ablation?[`${ablation.patch.outputDir}/${ablation.patch.resultPrefix}_fgsea_reactome.tsv`,`${ablation.patch.outputDir}/${ablation.patch.resultPrefix}_sample_metadata.tsv`,`${ablation.patch.outputDir}/${ablation.patch.resultPrefix}_evidence.json`,`${ablation.patch.outputDir}/${ablation.patch.resultPrefix}_run.log`]:[];
 const descriptor=fingerprintFiles([...required,...extras,'scripts/build_report_from_workbook.mjs','scripts/finalize_publication_v2.mjs','scripts/validate_analysis_reference.R','package-lock.json',...listFiles(root,'src'),...listFiles(root,'scripts/lib',f=>/provenance.*\.mjs$/.test(f))],{root});
 if(!descriptor.complete||descriptor.fingerprint!==finalized.fingerprint)throw new Error('Stale finalization input/code fingerprint: '+cohort.key);
 const evidencePath=resolveArtifactPath(cohort.evidencePath,{root});
 const evidence=JSON.parse(fs.readFileSync(evidencePath,'utf8')).evidence;
 const capture=verifyExecutionCapture(evidence,{root:path.dirname(evidencePath),projectRoot:root});
 if(capture.status!=='verified_against_supplied_artifacts')throw new Error('Execution input hashes are not fully verified: '+cohort.key);
 const validation=path.join(path.dirname(resolveArtifactPath(cohort.referenceInputPath,{root})),'reference_validation.json');
 const binding=JSON.parse(fs.readFileSync(validation+'.binding.json','utf8'));
 const ref=fingerprintFiles([cohort.referenceInputPath,'scripts/validate_analysis_reference.R','renv.lock'],{root});
 if(!ref.complete||sha256(JSON.stringify({inputs:ref.inputs,environment}))!==binding.fingerprint||!artifactManifestMatches(binding.artifacts,{root}))throw new Error('Stale reference validation binding/environment: '+cohort.key);
 cohorts.push({key:cohort.key,validationPath:path.relative(root,validation),bindingPath:path.relative(root,validation)+'.binding.json',fingerprint:finalized.fingerprint,referenceFingerprint:binding.fingerprint});
}
console.log(JSON.stringify({cohorts,externalUserStudy:receipt.externalUserStudy,independentExternalRerun:receipt.independentExternalRerun}));
"""


def collect_sources(root, manifest_file, preview=False):
    manifest = json.loads(manifest_file.read_text())
    cohorts = [c for c in manifest.get("cohorts", []) if c.get("enabled") is not False]
    if manifest.get("manifestVersion") != 2 or len(cohorts) != 5 or len({c.get("key") for c in cohorts}) != 5:
        raise ValueError("The figure requires the five-cohort publication-v2 manifest.")
    receipt_file = root / manifest["outputRoot"] / "benchmarks/finalization.json"
    inputs = [{"path": str(manifest_file.relative_to(root)), "sha256": sha256(manifest_file)}]
    if not preview:
        if not receipt_file.is_file():
            raise ValueError("A complete finalization receipt is required before drawing final figures.")
        receipt = json.loads(receipt_file.read_text())
        if (root/receipt.get("manifestPath", "")).resolve() != manifest_file.resolve():
            raise ValueError("The finalization receipt belongs to a different manifest.")
        if any(c["key"] not in receipt.get("cohorts", {}) for c in cohorts):
            raise ValueError("The finalization receipt is incomplete; all five cohorts must be finalized.")
        checked = subprocess.run(["node", "--input-type=module", "-e", NODE_VERIFY, str(manifest_file)], cwd=root, text=True, capture_output=True)
        if checked.returncode:
            raise ValueError("Release evidence validation failed: " + checked.stderr.strip())
        bound = json.loads(checked.stdout)
        if bound["externalUserStudy"] != "pending_real_participants":
            raise ValueError("The architecture's pending-study annotation must be revised to match the release state.")
        inputs.append({"path": str(receipt_file.relative_to(root)), "sha256": sha256(receipt_file)})
    records = []
    for cohort in cohorts:
        report = root / Path(cohort["referenceInputPath"]).parent / "reference_validation.json" if cohort.get("referenceInputPath") else None
        data = None
        if report and report.is_file():
            data = read_parity(report)
            inputs.append({"path": str(report.relative_to(root)), "sha256": sha256(report)})
        elif not preview:
            raise ValueError(f"Missing parity report for {cohort['key']}")
        if not preview:
            binding_file = Path(str(report) + ".binding.json")
            inputs.append({"path": str(binding_file.relative_to(root)), "sha256": sha256(binding_file)})
        for check_id, label in zip(CHECK_IDS, CHECK_LABELS):
            records.append({"cohort": cohort["key"], "dataset": cohort.get("datasetIdentifier", cohort["key"]),
                "check_id": check_id, "check_label": label, "state": "pass" if data else "pending",
                "source": str(report.relative_to(root)) if report else "unavailable",
                "source_key": f"checks[id={check_id}].pass", "release_verified": not preview})
    return cohorts, records, inputs


def architecture_sources(root):
    rows = [
        ("input", "GEO / local inputs\nCounts + metadata\nCurated design", "src/App.tsx", "local"),
        ("wald", "DESeq2 Wald statistics\n→ fgsea NES / FDR", "scripts/lib/analysis_core.R", "fgseaMultilevel"),
        ("effects", "apeglm\nDisplay log2 fold changes", "scripts/lib/analysis_core.R", 'type = "apeglm"'),
        ("camera", "TMM + voom + CAMERA\nSeparate method sensitivity", "scripts/lib/analysis_core.R", "limma::camera"),
        ("bootstrap", "Sample bootstrap\nDescriptive selection / direction", "scripts/lib/analysis_bootstrap.R", "pnv_bootstrap_pathways"),
        ("evidence", "Evidence record\nMethods · source rows\nArtifact hashes\nVerification state", "scripts/lib/provenance_run.mjs", "verification"),
        ("views", "Full / basic reports\nSame raw evidence\nLinked / plain view", "src/report/runtime.js", "raw-evidence"),
        ("study", "External user evaluation\nPENDING", "paper/evaluation/protocol.json", '"pending"'),
        ("engine-group", "ONE LOCAL R ENGINE", "scripts/lib/analysis_core.R", "pnv_analyze_counts"),
        ("input→engine", "Curated input feeds the local analysis engine", "scripts/run_local_analysis.R", "pnv_analyze_counts"),
        ("engine→evidence", "Analysis results populate evidence records", "scripts/lib/analysis_evidence.R", "pnv_build_evidence"),
        ("evidence→views", "Same evidence enters the selected report condition", "src/lib/reportHtml.ts", "reportCondition"),
        ("views→study", "Planned external comparison; not observed user benefit", "scripts/study/protocol.mjs", "CONDITIONS"),
    ]
    for _, _, source, anchor in rows:
        if anchor not in (root / source).read_text():
            raise ValueError(f"Architecture source anchor is missing: {source}: {anchor}")
    return [{"node": node, "label": label.replace("\n", " | "), "source": source, "source_key": anchor} for node, label, source, anchor in rows]


def write_tsv(file, rows):
    with file.open("w", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(rows[0]), delimiter="\t")
        writer.writeheader(); writer.writerows(rows)


def write_legend_docx(file, title, legend):
    # A single-paragraph, valid OOXML legend avoids introducing a new dependency.
    document = f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:rPr><w:b/></w:rPr><w:t>{escape(title)}</w:t></w:r></w:p><w:p><w:r><w:t xml:space="preserve">{escape(legend)}</w:t></w:r></w:p><w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>'
    with zipfile.ZipFile(file, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("[Content_Types].xml", '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>')
        archive.writestr("_rels/.rels", '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>')
        archive.writestr("word/document.xml", document)


def canonical_zip(file):
    with zipfile.ZipFile(file) as archive:
        entries={name:archive.read(name) for name in archive.namelist()}
    if "docProps/core.xml" in entries:
        entries["docProps/core.xml"]=re.sub(rb"(<dcterms:modified[^>]*>).*?(</dcterms:modified>)",rb"\g<1>2000-01-01T00:00:00Z\g<2>",entries["docProps/core.xml"])
    with zipfile.ZipFile(file,"w",zipfile.ZIP_DEFLATED) as archive:
        for name in sorted(entries):
            entry=zipfile.ZipInfo(name,date_time=(2000,1,1,0,0,0)); entry.compress_type=zipfile.ZIP_DEFLATED
            archive.writestr(entry,entries[name])


def write_source_xlsx(file, rows):
    def column_name(index):
        result=""
        while index:
            index,remainder=divmod(index-1,26);result=chr(65+remainder)+result
        return result
    table=[list(rows[0])]+[list(row.values()) for row in rows]
    xml_rows=[]
    for number,values in enumerate(table,1):
        cells=[]
        for index,value in enumerate(values,1):
            address=f"{column_name(index)}{number}"
            if isinstance(value,bool): cells.append(f'<c r="{address}" t="b"><v>{int(value)}</v></c>')
            elif isinstance(value,(int,float)): cells.append(f'<c r="{address}"><v>{value}</v></c>')
            else: cells.append(f'<c r="{address}" t="inlineStr"><is><t xml:space="preserve">{escape(str(value))}</t></is></c>')
        xml_rows.append(f'<row r="{number}">{"".join(cells)}</row>')
    with zipfile.ZipFile(file,"w",zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("[Content_Types].xml",'<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>')
        archive.writestr("_rels/.rels",'<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>')
        archive.writestr("xl/workbook.xml",'<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="plotted_data" sheetId="1" r:id="rId1"/></sheets></workbook>')
        archive.writestr("xl/_rels/workbook.xml.rels",'<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>')
        dimension=f"A1:{column_name(len(table[0]))}{len(table)}"
        archive.writestr("xl/worksheets/sheet1.xml",f'<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="{dimension}"/><sheetData>{"".join(xml_rows)}</sheetData></worksheet>')
    canonical_zip(file)


def save_figure(fig, stem, rows, inputs, legend, preview, claims, transformations, published_root):
    import matplotlib.pyplot as plt
    outputs = []
    for extension in ["png", "pdf", "svg"]:
        target = stem.with_suffix("." + extension)
        metadata={"Date":None} if extension=="svg" else {"CreationDate":None,"ModDate":None,"Creator":"Pathway Network Viewer"} if extension=="pdf" else {"Software":"Pathway Network Viewer"}
        fig.savefig(target, dpi=300, facecolor="white", metadata=metadata)
        outputs.append(target)
    plt.close(fig)
    source = Path(str(stem) + ".source.tsv"); write_tsv(source, rows)
    xlsx = Path(str(stem) + ".source.xlsx"); write_source_xlsx(xlsx,rows)
    docx = Path(str(stem) + ".legend.docx"); write_legend_docx(docx, stem.name.replace("_", " "), legend); canonical_zip(docx)
    text = Path(str(stem) + ".legend.txt"); text.write_text(legend + "\n")
    outputs.extend([docx, text])
    displayed = lambda file: str(published_root / file.name)
    validation = Path(str(stem) + ".validation.txt")
    validation.write_text("Source rows match plotted cells/nodes. All exports use the same deterministic plotting function.\n" +
        ("DEVELOPMENT PREVIEW: release receipt/environment binding not certified.\n" if preview else "Final release artifacts, execution hashes, parity bindings and current runtime environment verified before rendering.\n"))
    manifest = {"figure_id": stem.name, "generated_at": datetime.now(timezone.utc).isoformat(),
        "script": str(Path(__file__).resolve()), "script_sha256": sha256(__file__), "inputs": inputs,
        "outputs": [{"path": displayed(file), "sha256": sha256(file), "sizeBytes": file.stat().st_size} for file in outputs],
        "source_data": [{"path": displayed(file), "sha256": sha256(file)} for file in [source, xlsx]],
        "panel_claims": claims, "transformations": transformations,
        "validation": {"preview": preview, "notes": displayed(validation), "plotted_rows": len(rows)},
        "known_limitations": ["No raw numerical error magnitudes inferred from pass flags.", "Standard-package integration checks do not establish statistical-method accuracy, calibration or external user benefit.", "External user study and independent external rerun remain pending."]}
    Path(str(stem) + ".manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")


def draw_architecture(preview):
    import matplotlib.pyplot as plt
    from matplotlib.patches import FancyBboxPatch
    fig, ax = plt.subplots(figsize=(8.6, 5.3)); ax.set(xlim=(0, 1), ylim=(0, 1)); ax.axis("off")
    def box(x, y, w, h, text, color=COLORS["blue"], size=10.5, dashed=False):
        ax.add_patch(FancyBboxPatch((x, y), w, h, boxstyle="round,pad=0.008,rounding_size=0.012", facecolor=color, edgecolor="#94a9b8", linewidth=1, linestyle="--" if dashed else "-"))
        ax.text(x+w/2, y+h/2, text, ha="center", va="center", fontsize=size, color=COLORS["ink"], linespacing=1.5)
    box(.025, .37, .17, .25, "GEO / local inputs\nCounts + metadata\nCurated design", size=9.5)
    box(.24, .13, .31, .72, "", "#f5f8fb")
    ax.text(.395, .81, "ONE LOCAL R ENGINE", ha="center", fontsize=11, fontweight="bold", color=COLORS["ink"])
    for y, text in [(.64, "DESeq2 Wald statistics\n→ fgsea NES / FDR"), (.48, "apeglm\nDisplay log2 fold changes"), (.32, "TMM + voom + CAMERA\nSeparate method sensitivity"), (.16, "Sample bootstrap\nDescriptive selection / direction")]:
        box(.26, y, .27, .125, text, "white", 10)
    box(.60, .37, .16, .25, "Evidence record\nMethods ·\nsource rows\nArtifact hashes\nVerification state", size=9.5)
    box(.81, .37, .17, .25, "Full / basic reports\nSame raw evidence\nLinked / plain view", size=10)
    box(.81, .105, .17, .15, "External user\nevaluation\nPENDING", COLORS["amber"], 10, True)
    for x1, x2 in [(.197, .235), (.555, .595), (.765, .805)]:
        ax.annotate("", xy=(x2,.495), xytext=(x1,.495), arrowprops={"arrowstyle":"-|>", "lw":1.5, "color":"#527086"})
    ax.annotate("", xy=(.895,.26), xytext=(.895,.365), arrowprops={"arrowstyle":"-|>","lw":1.2,"color":"#a27724","linestyle":"--"})
    ax.text(.025,.95,"S1   Evidence-linked reporting workflow", fontsize=17, fontweight="bold", color=COLORS["ink"])
    ax.text(.025,.025,"Statistical significance, method sensitivity and resampling stability\nremain separate quantities.", fontsize=9, color="#526570")
    if preview: ax.text(.5,.895,"DEVELOPMENT PREVIEW — release finalization pending", ha="center", fontsize=11, color="#ad5e00", fontweight="bold")
    fig.subplots_adjust(left=.02,right=.98,top=.98,bottom=.02)
    return fig


def draw_checks(cohorts, records, preview):
    import matplotlib.pyplot as plt
    from matplotlib.patches import Rectangle, Patch
    fig, ax = plt.subplots(figsize=(8.6, 7.2))
    lookup = {(r["cohort"],r["check_id"]): r["state"] for r in records}
    for x, cohort in enumerate(cohorts):
        for y, check in enumerate(CHECK_IDS):
            state = lookup[(cohort["key"], check)]
            ax.add_patch(Rectangle((x-.46,y-.43),.92,.86,facecolor=COLORS[state],edgecolor="white",linewidth=.7))
            ax.text(x,y,"✓" if state=="pass" else "—",ha="center",va="center",fontsize=12,color="white" if state=="pass" else "#64748b")
    ax.set_xlim(-.55,len(cohorts)-.45); ax.set_ylim(17.55,-.55)
    ax.set_xticks(range(len(cohorts)),[COHORT_LABELS.get(c["key"],c["key"]) for c in cohorts],fontsize=9)
    ax.set_yticks(range(18),CHECK_LABELS,fontsize=9)
    ax.tick_params(axis="both",length=0,pad=8); [spine.set_visible(False) for spine in ax.spines.values()]
    for y in [6.5,13.5]:ax.axhline(y,color="#8da1ad",linewidth=1)
    fig.text(.04,.965,"S2   Standard-package integration checks",fontsize=16,fontweight="bold",color=COLORS["ink"])
    subtitle="18 recorded checks × 5 finalized datasets; all source bindings verified" if not preview else "DEVELOPMENT PREVIEW — available flags are not release-certified"
    fig.text(.04,.925,subtitle,fontsize=10,color="#ad5e00" if preview else "#526570")
    legend=[Patch(facecolor=COLORS["pass"],label="Recorded pass")]
    if preview:legend.append(Patch(facecolor=COLORS["pending"],label="Not yet available"))
    fig.legend(handles=legend,loc="lower center",bbox_to_anchor=(.57,.047),ncol=len(legend),frameon=False,fontsize=9)
    fig.text(.04,.018,"Same-environment comparisons: absolute / relative tolerance 10⁻⁸ where applicable.\nPass flags do not report numerical error magnitudes or validate the statistical methods.",fontsize=8.5,color="#526570")
    fig.subplots_adjust(left=.32,right=.97,top=.88,bottom=.16)
    return fig


def main():
    parser=argparse.ArgumentParser(); parser.add_argument("--project-root",type=Path,default=Path(__file__).resolve().parents[2])
    parser.add_argument("--manifest",type=Path,default=Path("paper/manifests/publication_v2.json")); parser.add_argument("--output",type=Path)
    parser.add_argument("--dev-preview",action="store_true"); args=parser.parse_args()
    root=args.project_root.resolve(); manifest=(args.manifest if args.manifest.is_absolute() else root/args.manifest).resolve()
    output=(args.output if args.output and args.output.is_absolute() else root/args.output) if args.output else root/(".cache/implementation-figure-preview" if args.dev_preview else "paper/outputs/publication_v2/figures")
    if args.dev_preview and not output.resolve().is_relative_to(root/".cache"):
        raise ValueError("Development previews must stay under the project .cache directory.")
    cohorts,records,inputs=collect_sources(root,manifest,args.dev_preview)
    architecture=architecture_sources(root)
    source_paths=sorted({row["source"] for row in architecture})
    code_inputs=[{"path":p,"sha256":sha256(root/p)} for p in source_paths]
    code_inputs.append({"path":str(Path(__file__).resolve().relative_to(root)),"sha256":sha256(__file__)})
    import matplotlib
    matplotlib.use("Agg"); matplotlib.rcParams.update({"font.family":"DejaVu Sans","svg.fonttype":"none","svg.hashsalt":"pnv-publication-v2","pdf.fonttype":42})
    output.parent.mkdir(parents=True,exist_ok=True)
    prefix="DEV_PREVIEW_" if args.dev_preview else ""
    legend1="Supplementary Figure S1. Evidence-linked reporting workflow. Curated counts and metadata enter one local R engine. Wald-based fgsea inference, apeglm display effects, CAMERA sensitivity and sample-resampling summaries remain distinct. Evidence records connect methods, source rows and artifact identities to full and basic reports exposing identical raw evidence. External user evaluation is pending; arrows denote software data flow, not biological causation."
    legend2="Supplementary Figure S2. Standard-package integration checks. Each cell records one boolean check from an independent direct-package reference report for a dataset. Gene, pathway and CAMERA checks are separated by horizontal rules. Final figures require verified execution-input hashes, reference-validation bindings and finalized report receipts. Numerical comparisons use absolute and relative tolerances of 10⁻⁸; identifiers and leading-edge sets are compared directly. Pass flags do not quantify numerical discrepancies or establish statistical-method accuracy or calibration."
    if args.dev_preview: legend1="Development preview, not a finalized release figure. "+legend1; legend2="Development preview; gray cells are unavailable and displayed pass flags are not release-certified. "+legend2
    stage=Path(tempfile.mkdtemp(prefix=".pnv-figures-",dir=output.parent))
    backups=[]; promoted=[]
    try:
        save_figure(draw_architecture(args.dev_preview),stage/(prefix+SUPPLEMENTARY_STEMS[0]),architecture,inputs+code_inputs,legend1,args.dev_preview,["Implemented data flow; human benefit not established"],{"arrows":"documented software dependencies","colors":COLORS},output)
        save_figure(draw_checks(cohorts,records,args.dev_preview),stage/(prefix+SUPPLEMENTARY_STEMS[1]),records,inputs,legend2,args.dev_preview,["Recorded standard-package integration outcomes only"],{"ordering":CHECK_IDS,"cohort_order":[c["key"] for c in cohorts],"values":"pass/pending flags; no numerical errors imputed","colors":COLORS},output)
        for artifact in inputs+code_inputs:
            if sha256(root/artifact["path"])!=artifact["sha256"]:
                raise ValueError("Figure inputs changed during rendering; staged outputs discarded.")
        if not args.dev_preview:
            _,current_records,current_inputs=collect_sources(root,manifest,False)
            if current_records!=records or current_inputs!=inputs:
                raise ValueError("Release evidence changed during rendering; staged outputs discarded.")
        output.mkdir(parents=True,exist_ok=True)
        files=list(stage.iterdir())
        for index,file in enumerate(files):
            target=output/file.name
            if target.exists():
                backup=stage/f".previous-{index}";os.replace(target,backup);backups.append((backup,target))
            os.replace(file,target);promoted.append(target)
    except Exception:
        for target in promoted:
            target.unlink(missing_ok=True)
        for backup,target in backups:
            os.replace(backup,target)
        raise
    finally:
        shutil.rmtree(stage,ignore_errors=True)
    print(json.dumps({"output":str(output),"preview":args.dev_preview,"datasets":len(cohorts),"check_cells":len(records)}))


if __name__=="__main__":
    try: main()
    except (ValueError,FileNotFoundError,KeyError) as error: raise SystemExit(str(error))
