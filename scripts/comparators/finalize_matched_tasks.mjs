import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {sha256} from './matched_task_contract.mjs';
import {writeJson} from './matched_task_deliveries.mjs';
import {writeAuditIndex,writeArtifactManifest} from './matched_task_artifacts.mjs';
import {tsv} from './matched_task_results.mjs';

const output=path.resolve('paper/outputs/publication_2026_11_17/comparators/matched_tasks');
const results=JSON.parse(fs.readFileSync(path.join(output,'results.json')));
if(!results.verification.passed||results.observations.length!==111)throw new Error('The complete component audit must pass first.');
const directory=path.join(output,'supplemental-native-export'),receiptFile=path.join(directory,'receipt.json');
const receipt=JSON.parse(fs.readFileSync(receiptFile));
const metrics=JSON.parse(fs.readFileSync('paper/outputs/publication_2026_11_17/comparators/native-deliveries/D01/genetonic-matched/metrics.json'));
const stockHash=metrics.installedPackageFiles['extdata/cocktail_recipe.Rmd'];
if(sha256(fs.readFileSync(receipt.file))!==stockHash||stockHash!==receipt.sha256)throw new Error('Native Rmd export differs from the inspected stock template.');
receipt.stockTemplateSha256=stockHash;
receipt.interpretation='The downloaded Rmd is byte-identical to the installed generic cocktail_recipe.Rmd. It refers to caller-provided dds/res_de/res_enrich/annotation_obj and does not contain the complete original rank data.';
writeJson(receiptFile,receipt);
results.supplementalNativeExports=[{tool:'GeneTonic',control:receipt.control,file:receipt.file,sha256:receipt.sha256,
  receipt:path.relative(process.cwd(),receiptFile),screenshot:path.relative(process.cwd(),path.join(directory,'genetonic-code-menu.png')),
  role:'Inspected native recipe export; no additional component values retrieved.',interpretation:receipt.interpretation}];
for(const row of results.observations)if(row.tool==='GeneTonic'&&row.component_id==='original_rank_universe'){
  row.native.inspected_native_export=results.supplementalNativeExports[0];
  row.limitation='The prepared HTML shows five selected gene rows and a full-rank companion filename. Its downloaded native Rmd is the generic recipe, not a complete rank-data export. The full ordered rank array is in the common companion; other workflows were not exhaustively assessed.';
}
results.configurationLimitations={
  RNAmel:'Corrected saved parameters identify the actual covariates/contrast/shrinkage. Native generated enrichment examples are unexecuted templates and do not identify the frozen GMT or original frequency filter. Matched statistics were retrieved through the actual official saved-project export.',
  GeneTonic:'Additional supplied_ columns are upstream annotations rendered by the stock native table; they are not new GeneTonic inferential calculations or validation checks.',
};
results.closure={source:path.relative(process.cwd(),fileURLToPath(import.meta.url)),sourceSha256:sha256(fs.readFileSync(fileURLToPath(import.meta.url))),
  command:[process.execPath,...process.argv.slice(1)],note:'Closes ancillary export inspection and direct-lookup provenance tags; frozen tasks, original arrays and observed routes are unchanged.'};
writeJson(path.join(output,'results.json'),results);
const lines=fs.readFileSync(path.join(output,'observations.tsv'),'utf8').trimEnd().split('\n'),columns=lines[0].split('\t');
const rows=lines.slice(1).map(line=>Object.fromEntries(line.split('\t').map((cell,index)=>[columns[index],cell])));
for(const row of rows)if(row.tool==='GeneTonic'&&row.component_id==='original_rank_universe')row.limitation=results.observations.find(item=>item.tool===row.tool&&item.task_id===row.task_id&&item.component_id===row.component_id).limitation;
fs.writeFileSync(path.join(output,'observations.tsv'),tsv(columns,rows));
writeAuditIndex(output,results);
const observationDirectory=path.dirname(path.dirname(results.executedSources[0].path));
const manifest=writeArtifactManifest(output,results,null,observationDirectory);
for(const file of manifest.files)if(sha256(fs.readFileSync(file.path))!==file.sha256||fs.statSync(file.path).size!==file.sizeBytes)throw new Error('Final artifact changed: '+file.path);
console.log(JSON.stringify({passed:true,components:111,artifactFiles:manifest.files.length,resultsSha256:sha256(fs.readFileSync(path.join(output,'results.json'))),observationsSha256:sha256(fs.readFileSync(path.join(output,'observations.tsv'))),manifestSha256:sha256(fs.readFileSync(path.join(output,'artifact-manifest.json')))}));
