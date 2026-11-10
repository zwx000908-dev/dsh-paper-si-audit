import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
const hash = x => createHash('sha256').update(x).digest('hex');
const visual = /\.(pdf|docx|png|jpe?g|tiff?|webp|bmp)$/i;
async function save(file, value) { await mkdir(path.dirname(file), { recursive: true }); const tmp = file + '.' + randomUUID() + '.tmp'; await writeFile(tmp, JSON.stringify(value, null, 2)); await rename(tmp, file); }
async function signature(service, projectId) {
  const p = await service.getProject(projectId), sources = [];
  for (const d of p.documents) { try { const file = await service.sourcePath(p, d.filePath); sources.push([d.key, d.role, hash(await readFile(file))]); } catch (e) { sources.push([d.key, d.role, 'unreadable:' + e.code]); } }
  return hash(JSON.stringify([sources, p.profileRevision, p.hrmsRevision, p.scientificRevision ?? 0]));
}
export async function workflowAction(service, { projectId, action = 'status', jobId, maxSteps = 3, ocr = true, signal, executionEvidence }) {
  if (!['start', 'resume', 'status', 'cancel', 'retry_failed'].includes(action)) throw new Error('Unknown workflow action');
  if (!Number.isInteger(maxSteps) || maxSteps < 1 || maxSteps > 25 || typeof ocr !== 'boolean') throw new Error('maxSteps 1–25 and boolean ocr required');
  const dir = path.join(service.dir(projectId), 'workflow'), activeFile = path.join(dir, 'active.json');
  await service.getProject(projectId);
  async function load() { const selected = jobId ?? JSON.parse(await readFile(activeFile, 'utf8')).jobId; if (!/^[a-f0-9-]{36}$/.test(selected)) throw new Error('Invalid workflow job ID'); return { file: path.join(dir, selected + '.json'), job: JSON.parse(await readFile(path.join(dir, selected + '.json'), 'utf8')) }; }
  const summary = job => ({ ...job, counts: job.tasks.reduce((o, t) => (o[t.status] = (o[t.status] ?? 0) + 1, o), {}), nextAction: ['completed', 'completed_with_gaps', 'cancelled', 'stale'].includes(job.status) ? null : 'resume', note: 'Rendering and OCR are not scientific verification. OCR is provisional; graph traces, chemical structures, OLE, table layout and full semantics still require targeted review. Resume uses persisted checkpoints; completed means the requested bounded pipeline finished.' });
  if (action === 'status') { const { job } = await load(); if (job.signature !== await signature(service, projectId)) return summary({ ...job, status: 'stale', reason: 'Sources or rules changed; start a new workflow.' }); return summary(job); }
  return service.locked(projectId, async () => {
    let file, job;
    if (action === 'start') {
      try { const active = await load(); if (!['completed', 'completed_with_gaps', 'cancelled', 'stale'].includes(active.job.status) && active.job.signature === await signature(service, projectId)) return summary(active.job); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      const p = await service.getProject(projectId); if (!p.documents.length) throw new Error('Import sources first');
      job = { id: randomUUID(), projectId, signature: await signature(service, projectId), createdAt: new Date().toISOString(), status: 'pending', stage: 'inventory', ocr, documents: p.documents.map(d => ({ key: d.key, name: d.name, visual: visual.test(d.name), status: visual.test(d.name) ? 'pending' : 'text_only' })), tasks: [], runIds: [], failures: [], attempts: 0 };
      file = path.join(dir, job.id + '.json'); await save(file, job); await save(activeFile, { jobId: job.id });
    } else ({ file, job } = await load());
    if (action === 'cancel') { job.status = 'cancelled'; await save(file, job); return summary(job); }
    if (job.signature !== await signature(service, projectId)) { job.status = 'stale'; await save(file, job); return summary(job); }
    if (action === 'retry_failed') {
      for (const d of job.documents) if (d.status === 'failed') d.status = 'pending';
      for (const t of job.tasks) if (t.status === 'failed') { t.status = 'pending'; delete t.error; }
      (job.failureHistory ??= []).push({ at: new Date().toISOString(), failures: structuredClone(job.failures) });
      job.failures = []; job.status = 'pending'; job.stage = job.documents.some(d => d.status === 'pending') ? 'inventory' : 'materials';
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
            if (job.ocr) { const r = await service.readMaterialImage({ projectId, assetId: asset.id, signal }); t.readingId = r.id; if (r.status === 'failed') throw new Error('No readable OCR text; inspect image manually'); }
            t.status = job.ocr ? 'ocr_read_provisional' : 'rendered';
          } catch (e) { if (signal?.aborted) throw e; t.status = 'failed'; t.error = e.message; job.failures.push({ documentKey: t.documentKey, offset: t.offset, message: e.message }); }
        } else {
          job.inFlight = { kind: 'audit' }; await save(file, job);
          const run = await service.runAudit({ projectId, executionEvidence, workflowSnapshot: { jobId: job.id, signature: job.signature, ocr: job.ocr, documents: job.documents, tasks: job.tasks, failures: job.failures } }); job.runIds.push(run.id); job.latestRunId = run.id; job.coverage = run.coverage;
          if (run.coverage.imageDuplicates.nextPairOffset === null) { job.stage = 'finished'; job.status = job.failures.length || run.coverage.imageDuplicates.skipped.length || run.coverage.imageDuplicates.truncatedAssets || run.coverage.missingRoles.length || run.documents.some(d => d.coverage.status === 'failed') ? 'completed_with_gaps' : 'completed'; }
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
