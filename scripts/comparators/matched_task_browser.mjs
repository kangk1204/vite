import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {sha256,compareDisplay,validateAccessObservation} from './matched_task_contract.mjs';

export const compact=text=>String(text??'').replace(/\s+/g,' ').trim();
const filename=text=>String(text).replace(/[^a-z0-9_-]/gi,'_');

export async function openNative(browser,file,tool,delivery,output) {
  const context=await browser.newContext({offline:true,viewport:{width:1440,height:1000},acceptDownloads:true});
  const page=await context.newPage(),errors=[],remote=[];
  page.on('pageerror',error=>errors.push(error.message));
  page.on('request',request=>{if(/^https?:/.test(request.url()))remote.push(request.url());});
  await page.goto(pathToFileURL(path.resolve(file)).href,{waitUntil:'load',timeout:120000});
  const prefix=filename(tool+'-'+delivery);
  const inventory=await page.evaluate(()=>({
    title:document.title,
    headings:[...document.querySelectorAll('h1,h2,h3,h4')].map(el=>({text:el.textContent.trim(),visible:el.getClientRects().length>0})),
    tables:[...document.querySelectorAll('table')].map((el,index)=>({index,id:el.id,headers:[...el.querySelectorAll('thead th')].map(th=>th.textContent.trim()),visible:el.getClientRects().length>0})),
    controls:[...document.querySelectorAll('button,a,summary,select')].map((el,index)=>({index,tag:el.tagName,id:el.id,text:el.textContent.trim(),href:el.getAttribute('href'),visible:el.getClientRects().length>0})),
    pre:[...document.querySelectorAll('pre')].map((el,index)=>({index,text:el.textContent,visible:el.getClientRects().length>0})),
    tableInformation:[...document.querySelectorAll('.dataTables_info')].map(el=>({text:el.textContent,visible:el.getClientRects().length>0})),
  }));
  fs.writeFileSync(path.join(output,prefix+'-inventory.json'),JSON.stringify(inventory,null,2)+'\n');
  await page.screenshot({path:path.join(output,prefix+'-overview.png')});
  return {page,context,tool,delivery,prefix,inventory,errors,remote,report:{path:path.resolve(file),sha256:sha256(fs.readFileSync(file))}};
}

export async function visibleObservation(session,locator,component,output,{value,origin='supplied_upstream_result',computed=false,derivation}={}) {
  const element=typeof locator==='string'?session.page.locator(locator):locator;
  if (await element.count()!==1||!await element.isVisible()) return unavailable(session,component,'The requested value is not exposed by this visible control.');
  await element.scrollIntoViewIfNeeded();
  const text=await element.innerText(),screen=session.prefix+'-'+filename(component)+'.png';
  await session.page.screenshot({path:path.join(output,screen)});
  return validateAccessObservation({route:'visible_native_report',mechanism:'dom_text',visible:true,control:typeof locator==='string'?locator:'native rendered table cell',
    screenshot:screen,observed:value===undefined?compact(text):value,displayText:compact(text),value_origin:origin,native_computation:computed,derivation});
}

export function unavailable(session,component,reason,partial) {
  return validateAccessObservation({route:'not_exposed_in_tested_report',mechanism:'dom_inspection',reason,
    scope:'Prepared '+session.tool+' native report configuration only',observed:null,partial_inputs:partial,
    screenshot:session.prefix+'-overview.png',value_origin:null,native_computation:false});
}

export async function nativeTableRow(page,id) {
  const table=page.locator('.dataTables_wrapper').filter({has:page.locator('th').filter({hasText:/^gs_id$/})});
  if (await table.count()!==1) return null;
  await table.locator('input[type=search]').fill(id);
  const row=table.locator('tbody tr').filter({has:page.getByRole('cell',{name:id,exact:true})}).first();
  await row.waitFor({state:'visible',timeout:15000});
  const headers=(await row.locator('xpath=ancestor::table[1]').locator('thead th').allTextContents()).map(compact);
  const texts=await row.locator('td').allTextContents();
  return {table,row,headers,values:Object.fromEntries(headers.map((header,index)=>[header,compact(texts[index])]))};
}

export async function observeTableField(session,table,column,component,output,options={}) {
  const index=table?.headers.indexOf(column)??-1;
  if (index<0) return unavailable(session,component,'The prepared native table does not expose column '+column+'.');
  const cell=table.row.locator('td').nth(index);
  const record=await visibleObservation(session,cell,component,output,options);
  return {...record,control:'Native searchable enrichment table / '+column,column};
}

export async function downloadPnvEvidence(session,output) {
  const page=session.page;
  const raw=page.locator('#raw-evidence');
  if (await raw.getAttribute('open')===null) await raw.locator(':scope > summary').click();
  const button=page.locator('#download-evidence');
  await button.scrollIntoViewIfNeeded();
  const [download]=await Promise.all([page.waitForEvent('download'),button.click()]);
  const file=path.join(output,session.prefix+'-evidence-export.json');
  await download.saveAs(file);
  const screenshot=session.prefix+'-evidence-export.png';
  await page.screenshot({path:path.join(output,screenshot)});
  return {value:JSON.parse(fs.readFileSync(file,'utf8')),record:validateAccessObservation({
    route:'documented_native_export',mechanism:'user_export',control:'Source tables and analysis records > Download all evidence JSON',
    file:path.basename(file),sha256:sha256(fs.readFileSync(file)),screenshot,value_origin:'supplied_upstream_result',native_computation:false,
  })};
}

export async function pnvSourceRow(session,button,output,label) {
  await button.click();
  const table=session.page.locator('#source-table-content table');
  const headers=(await table.locator('thead th').allTextContents()).map(compact);
  const row=table.locator('tbody tr').first(),cells=(await row.locator('td').allTextContents()).map(compact);
  const record=await visibleObservation(session,row,label,output);
  return {record,values:Object.fromEntries(headers.map((header,index)=>[header,cells[index]]))};
}

export function attachNumericAgreement(observation,expected,text=observation.observed) {
  if (!['visible_native_report','documented_native_export'].includes(observation.route)) return observation;
  return {...observation,numeric_agreement:compareDisplay(text,expected)};
}
