import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';

export const AUDIT_TOOLS = ['PNV','GeneTonic','RNAmel'];
export const sha256 = value => createHash('sha256').update(value).digest('hex');

export function numericValue(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' && typeof value !== 'number') throw new Error('Expected a numeric source value.');
  const text = String(value).trim();
  if (!text || /^(?:NA|N\/A|NaN|[+-]?Inf(?:inity)?)$/i.test(text)) return null;
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(text)) throw new Error(`Invalid numeric source token: ${text}`);
  const number = Number(text);
  return Number.isFinite(number) ? number : null;
}

export function compareNumeric(observed, expected, tolerance = 1e-8) {
  const left = numericValue(observed), right = numericValue(expected);
  if (left === null || right === null) return left === right;
  return Math.abs(left - right) <= tolerance + tolerance * Math.abs(right);
}

export function compareDisplay(displayText, expected) {
  const text=String(displayText??'').trim().replace(/[−–]/g,'-');
  const displayed=numericValue(text),source=numericValue(expected);
  if (displayed===null||source===null) return {displayText:text,displayed,expected:source,unit:null,matches:displayed===source};
  const parts=/^[+-]?(?:\d+)(?:\.(\d*))?(?:e([+-]?\d+))?$/i.exec(text);
  if (!parts) throw new Error('Display precision cannot be inferred from the visible numeric token.');
  const unit=10**(Number(parts[2]||0)-(parts[1]?.length||0));
  const tolerance=unit/2+Math.abs(source)*Number.EPSILON*4;
  return {displayText:text,displayed,expected:source,unit,tolerance,matches:Math.abs(displayed-source)<=tolerance};
}

export function sameFormula(left,right) {
  const terms=value=>String(value).replace(/\x60|\s/g,'').replace(/^~/,'').split('+').sort().join('+');
  return terms(left)===terms(right);
}

export function compareRanks(observed,expected) {
  if(observed.length!==expected.length)return{matches:false,reason:'Ranked universe length differs.'};
  let maximumAbsoluteDifference=0;
  for(let index=0;index<expected.length;index++){
    if(observed[index].gene!==expected[index].gene)return{matches:false,reason:'Ordered gene identifiers differ.',index};
    const left=numericValue(observed[index].metric),right=numericValue(expected[index].metric);
    if(left===null||right===null||!compareNumeric(left,right))return{matches:false,reason:'Original rank metric differs.',index};
    maximumAbsoluteDifference=Math.max(maximumAbsoluteDifference,Math.abs(left-right));
  }
  return{matches:true,orderedIdentifiersExact:true,maximumAbsoluteDifference,absoluteTolerance:1e-8,relativeTolerance:1e-8};
}

export function reconstructEs(ranks, members) {
  const positions = new Map(ranks.map((entry,index)=>[entry.gene,index]));
  if (positions.size !== ranks.length || new Set(members).size !== members.length) throw new Error('Rank or membership identifiers are duplicate.');
  if (members.some(gene=>!positions.has(gene))) throw new Error('Tested member is absent from the original ranked universe.');
  if (ranks.some(entry=>numericValue(entry.metric)===null)) throw new Error('The original ranked universe must have finite statistics.');
  if (!members.length || members.length === ranks.length) return null;
  const hits = new Set(members), total = members.reduce((sum,gene)=>sum+Math.abs(Number(ranks[positions.get(gene)].metric)),0);
  const miss = 1/(ranks.length-members.length);
  let running=0,maximum=0,minimum=0;
  for (const entry of ranks) {
    running += hits.has(entry.gene) ? (total ? Math.abs(Number(entry.metric))/total : 1/members.length) : -miss;
    maximum=Math.max(maximum,running);minimum=Math.min(minimum,running);
  }
  return Math.abs(maximum+minimum)<1e-14 ? 0 : maximum>-minimum ? maximum : minimum;
}

export function parseTsv(text) {
  const lines = String(text).replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').split('\n');
  while (lines.at(-1) === '') lines.pop();
  if (!lines.length) throw new Error('Source table has no header.');
  const columns = lines[0].split('\t');
  if (columns.some(column => !column.trim()) || new Set(columns).size !== columns.length) throw new Error('Source table has empty or duplicate headers.');
  const rows = lines.slice(1).map((line,index) => {
    const cells = line.split('\t');
    if (cells.length !== columns.length) throw new Error(`Source row ${index+1} width differs from header.`);
    return {row:index+1,values:Object.fromEntries(columns.map((column,i)=>[column,cells[i]]))};
  });
  return {columns,rows};
}

export function findSourceRow(table, column, target) {
  if (!table.columns.includes(column)) throw new Error(`Missing source column ${column}.`);
  const rows = table.rows.filter(row => row.values[column] === target);
  if (rows.length !== 1) throw new Error(`Expected a unique source row for ${target}; found ${rows.length}.`);
  return rows[0];
}

export function assertFairEvidence(allocations) {
  if (Object.keys(allocations).sort().join() !== [...AUDIT_TOOLS].sort().join()) throw new Error('All three tools require the same shared evidence.');
  const identity = artifacts => JSON.stringify(artifacts.map(file => {
    if (!file.role || !/^[a-f0-9]{64}$/i.test(file.sha256) || !Number.isSafeInteger(file.sizeBytes) || file.sizeBytes < 0) throw new Error('Invalid shared evidence identity.');
    return [file.role,file.sha256.toLowerCase(),file.sizeBytes,file.present !== false];
  }).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b))));
  const reference = identity(allocations.PNV);
  for (const tool of AUDIT_TOOLS) if (identity(allocations[tool]) !== reference) throw new Error(`${tool} did not receive the same evidence bytes and availability.`);
}

export function validateAccessObservation(observation) {
  const {route,mechanism} = observation;
  if (route === 'visible_native_report') {
    if (mechanism !== 'dom_text') throw new Error('Hidden extraction cannot establish native-visible support.');
    if (observation.visible !== true || !observation.control || !observation.screenshot) throw new Error('Native support requires a visible control and screenshot.');
  } else if (route === 'documented_native_export') {
    if (mechanism !== 'user_export' || !observation.control || !observation.file) throw new Error('Native export requires the actual user-facing export and downloaded file.');
  } else if (route === 'shared_companion') {
    if (mechanism !== 'source_file' || !observation.file || !observation.key) throw new Error('Companion observations require a file and source key.');
  } else if (route === 'embedded_machine_record') {
    if (mechanism !== 'embedded_json' || !observation.key) throw new Error('Embedded observations require a machine-readable key.');
  } else if (['not_exposed_in_tested_report','not_assessed','execution_error','missing_from_delivery','not_required'].includes(route)) {
    if (!observation.reason) throw new Error('Unavailable observations need a scoped reason.');
  } else throw new Error('Unknown observation access route.');
  return observation;
}

export function freezeContract(contractFile, outputDirectory) {
  const bytes = fs.readFileSync(contractFile);
  JSON.parse(bytes);
  const digest = sha256(bytes), snapshot = path.join(outputDirectory,'task-contract.json'), receipt = path.join(outputDirectory,'task-contract-freeze.json');
  fs.mkdirSync(outputDirectory,{recursive:true});
  if (fs.existsSync(snapshot) && sha256(fs.readFileSync(snapshot)) !== digest) throw new Error('Task contract changed after the audit was frozen.');
  if (fs.existsSync(receipt)) {
    const existing = JSON.parse(fs.readFileSync(receipt,'utf8'));
    if (existing.sha256 !== digest) throw new Error('Task contract changed after freezing.');
    return existing;
  }
  if (!fs.existsSync(snapshot)) fs.writeFileSync(snapshot,bytes,{flag:'wx'});
  const value = {sourcePath:path.relative(process.cwd(),path.resolve(contractFile)),sha256:digest,snapshotPath:'task-contract.json',frozenAt:new Date().toISOString()};
  fs.writeFileSync(receipt,JSON.stringify(value,null,2)+'\n',{flag:'wx'});
  return value;
}
