import { resolveSettings, mergeSettings } from './settings.js';
import { VERSION } from './version.js';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
const hash = x => createHash('sha256').update(x).digest('hex');
const visual = /\.(pdf|docx|png|jpe?g|tiff?|webp|bmp)$/i;
async function save(file, value) { await mkdir(path.dirname(file), { recursive: true }); const tmp = file + '.' + randomUUID() + '.tmp'; await writeFile(tmp, JSON.stringify(value, null, 2)); await rename(tmp, file); }
async function signature(service, projectId) {
  const p = await service.getProject(projectId), sources = [];
  for (const d of p.documents) { try { const file = await service.sourcePath(p, d.filePath); sources.push([d.key, d.role, hash(await readFile(file))]); } catch (e) { sources.push([d.key, d.role, 'unreadable:' + e.code]); } }
  return hash(JSON.stringify([VERSION, sources, p.profileRevision, p.hrmsRevision, p.scientificRevision ?? 0, p.settingsRevision ?? 0]));
}
export async function workflowAction(service, { projectId, action = 'status', jobId, maxSteps, ocr, settings = {}, signal, executionEvidence }) {
  if (!['start', 'resume', 'status', 'cancel', 'retry_failed'].includes(action)) throw new Error('Unknown workflow action');
  const project = await service.getProject(projectId);
  if(action!=='start' && (Object.keys(settings).length || ocr!==undefined))throw new Error('Settings and OCR overrides are start-only; resume uses captured settings');
  const taskSettings = ocr===undefined ? settings : mergeSettings(settings,{workflow:{ocr}});
  const appliedSettings = resolveSettings(project,taskSettings);
  if (maxSteps!==undefined && (!Number.isInteger(maxSteps) || maxSteps < 1 || maxSteps > 25)) throw new Error('maxSteps 1–25 and boolean ocr required');
  const dir = path.join(service.dir(projectId), 'workflow'), activeFile = path.join(dir, 'active.json');
  await service.getProject(projectId);
  async function load() { const selected = jobId ?? JSON.parse(await readFile(activeFile, 'utf8')).jobId; if (!/^[a-f0-9-]{36}$/.test(selected)) throw new Error('Invalid workflow job ID'); return { file: path.join(dir, selected + '.json'), job: JSON.parse(await readFile(path.join(dir, selected + '.json'), 'utf8')) }; }
  const handoff=job=>({primaryMethod:'multimodal_source_images',ocrRole:'optional_text_aid',modelReviewPerformedByWorkflow:false,preparedAssetIds:job.tasks.filter(t=>t.assetId&&['rendered','rendered_with_ocr_gap','ocr_read_provisional'].includes(t.status)).map(t=>t.assetId),tools:['paper_audit_visual_image',...(job.appliedSettings?.effective.checks.visualReview===false?[]:['paper_audit_visual_review','paper_audit_visual_pair'])],note:'Inspect originals and detail crops with the current multimodal model. Preparation/OCR completion is not image review. Use the visual queue for requested duplicate review; read its current status and disclose omissions.'});
  const summary = job => ({ ...job, reviewHandoff:handoff(job), counts: job.tasks.reduce((o, t) => (o[t.status] = (o[t.status] ?? 0) + 1, o), {}), nextAction: ['completed', 'completed_with_gaps', 'cancelled', 'stale'].includes(job.status) ? null : 'resume', note: 'Rendering and OCR are not scientific verification. OCR is provisional; graph traces, chemical structures, OLE, table layout and full semantics still require targeted review. Resume uses persisted checkpoints; completed means the requested bounded pipeline finished.' });
  if (action === 'status') { const { job } = await load(); if (job.signature !== await signature(service, projectId)) return summary({ ...job, status: 'stale', reason: 'Sources or rules changed; start a new workflow.' }); return summary(job); }
  return service.locked(projectId, async () => {
    let file, job;
    if (action === 'start') {
      try { const active = await load(); if (!['completed', 'completed_with_gaps', 'cancelled', 'stale'].includes(active.job.status) && active.job.signature === await signature(service, projectId) && JSON.stringify(active.job.taskSettings??{})===JSON.stringify(taskSettings)) return summary(active.job); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      const p = await service.getProject(projectId); const appliedSettings=resolveSettings(p,taskSettings); if (!p.documents.length) throw new Error('Import sources first');
      job = { id: randomUUID(), projectId, signature: await signature(service, projectId), createdAt: new Date().toISOString(), status: 'pending', stage: 'inventory', taskSettings, appliedSettings, ocr: appliedSettings.effective.workflow.ocr, excludedDocuments:p.documents.filter(d=>appliedSettings.effective.scope==='si'&&d.role!=='si').map(d=>d.key), documents: p.documents.filter(d=>appliedSettings.effective.scope!=='si'||d.role==='si').map(d => ({ key: d.key, name: d.name, visual: visual.test(d.name), status: visual.test(d.name) ? 'pending' : 'text_only' })), tasks: [], runIds: [], failures: [], ocrFailures: [], attempts: 0 };
      file = path.join(dir, job.id + '.json'); await save(file, job); await save(activeFile, { jobId: job.id });
    } else ({ file, job } = await load());
    maxSteps ??= job.appliedSettings?.effective.workflow.maxSteps ?? 3;
    if (action === 'cancel') { job.status = 'cancelled'; await save(file, job); return summary(job); }
    if (job.signature !== await signature(service, projectId)) { job.status = 'stale'; await save(file, job); return summary(job); }
    if (action === 'retry_failed') {
      for (const d of job.documents) if (d.status === 'failed') d.status = 'pending';
      for (const t of job.tasks) if (t.status === 'failed' || t.ocrStatus==='failed') { t.status = 'pending'; delete t.error; delete t.ocrError; delete t.ocrStatus; }
      (job.failureHistory ??= []).push({ at: new Date().toISOString(), failures: structuredClone(job.failures),ocrFailures:structuredClone(job.ocrFailures??[]) });
      job.failures = []; job.ocrFailures=[]; job.status = 'pending'; job.stage = job.documents.some(d => d.status === 'pending') ? 'inventory' : 'materials';
    }
    if (['completed', 'completed_with_gaps', 'cancelled', 'stale'].includes(job.status)) return summary(job);
    job.status = 'running'; job.attempts++; await save(file, job);
    try {
      for (let step = 0; step < maxSteps; step++) {
        signal?.throwIfAborted();
        if (await signature(service, projectId) !== job.signature) { job.status = 'stale'; break; }
        if (job.stage === 'inventory') {
          const d = job.documents.find(d => d.status === 'pending');
          if (!d) { job.stage = 'materials'; step--; continue; }
          job.inFlight = { kind: 'inventory', documentKey: d.key }; await save(file, job);
          try { const r = await service.prepareVisuals({ projectId, documentKey: d.key, signal }); d.status = 'inventoried'; d.sha256 = r.source.sha256; d.total = r.assets.length; for (let i = 0; i < r.assets.length; i++) if (!job.tasks.some(t => t.documentKey === d.key && t.offset === i)) job.tasks.push({ documentKey: d.key, offset: i, originKey: r.assets[i].originKey, status: 'pending' }); }
          catch (e) { if (signal?.aborted) throw e; d.status = 'failed'; d.error = e.message; job.failures.push({ documentKey: d.key, message: e.message }); }
        } else if (job.stage === 'materials') {
          const t = job.tasks.find(t => t.status === 'pending');
          if (!t) { job.stage = 'audit'; step--; continue; }
          job.inFlight = { kind: 'material', documentKey: t.documentKey, offset: t.offset }; await save(file, job);
          try {
            const p = await service.getProject(projectId);
            let asset = (p.visualAssets ?? []).find(a => t.originKey && a.originKey === t.originKey && a.documentKey === t.documentKey && !a.parentAssetId && p.activeVisuals?.[a.originKey] === a.id && a.sourceSha256 === job.documents.find(d => d.key === t.documentKey)?.sha256);
            // prepareImageAudit preserves registered content and persists before checkpoint advancement.
            if (!asset || asset.status !== 'ready') { const r = await service.prepareImageAudit({ projectId, documentKey: t.documentKey, offset: t.offset, limit: 1, signal }); asset = r.selectedAssets[0]; }
            if (!asset || asset.status !== 'ready') throw new Error(asset?.error ?? 'Asset could not be rendered');
            t.assetId = asset.id;
            t.status='rendered';
            if (job.ocr) {
              try { const r=await service.readMaterialImage({projectId,assetId:asset.id,signal});t.readingId=r.id;if(r.status==='failed')throw new Error('No readable OCR text');t.status='ocr_read_provisional';t.ocrStatus='provisional'; }
              catch(e){if(signal?.aborted)throw e;t.status='rendered_with_ocr_gap';t.ocrStatus='failed';t.ocrError=e.message;(job.ocrFailures??=[]).push({documentKey:t.documentKey,assetId:asset.id,offset:t.offset,message:e.message});}
            }
          } catch (e) { if (signal?.aborted) throw e; t.status = 'failed'; t.error = e.message; job.failures.push({ documentKey: t.documentKey, offset: t.offset, message: e.message }); }
        } else {
          job.inFlight = { kind: 'audit' }; await save(file, job);
          const run = await service.runAudit({ projectId, settings: job.taskSettings ?? {}, executionEvidence, workflowSnapshot: { jobId: job.id, signature: job.signature, ocr: job.ocr, documents: job.documents, tasks: job.tasks, failures: job.failures, ocrFailures:job.ocrFailures??[], reviewHandoff:handoff(job) } }); job.runIds.push(run.id); job.latestRunId = run.id; job.coverage = run.coverage;
          if (run.coverage.imageDuplicates.nextPairOffset === null) { job.stage = 'finished'; job.status = job.failures.length || job.ocrFailures?.length || run.coverage.imageDuplicates.skipped.length || run.coverage.imageDuplicates.truncatedAssets || run.coverage.missingRoles.length || run.documents.some(d => d.coverage.status === 'failed') ? 'completed_with_gaps' : 'completed'; }
        }
        job.inFlight = null; job.updatedAt = new Date().toISOString(); await save(file, job);
        if (job.stage === 'finished') break;
      }
      if (job.status === 'running') job.status = 'pending';
    } catch (e) { job.status = signal?.aborted ? 'interrupted' : 'failed'; job.lastError = e.message; }
    if (await signature(service, projectId) !== job.signature) job.status = 'stale';
    await save(file, job); return summary(job);
  }, 'workflow.lock');
}
