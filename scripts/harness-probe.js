/** Synthetic tool probe loaded only by scripts/harness-smoke.js. No model request. */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createToolDefinitions } from '../src/plugin.js';

const expectedToolNames = createToolDefinitions({}).map(tool => tool.name);

export const name = 'paper-audit-smoke-probe';
export const inject = ['tools'];

export async function apply(ctx, config) {
  const deadline = Date.now() + 20000;
  while (!expectedToolNames.every(name => ctx.tools.schemas().some(tool => tool.name === name))) {
    if (Date.now() > deadline) throw new Error('Paper audit native tools did not become available');
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  let sequence = 0;
  const invoke = async (name, args) => {
    const batch = await ctx.tools.execute({
      calls: [{ type: 'tool-call', id: `paper-smoke-${++sequence}`, name, arguments: JSON.stringify(args) }],
      signal: new AbortController().signal,
    });
    const result = batch.results[0]?.result;
    if (!result || result.isError) throw new Error(`${name}: ${result?.error?.message ?? 'missing canonical result'}`);
    return result.value;
  };
  const project = await invoke('paper_audit_create', { name: 'Synthetic native release smoke' });
  const mass = await invoke('paper_audit_hrms_calculate', { formula: 'C2H6O', ion: '[M+H]+', formulaBasis: 'neutral' });
  if (!Array.isArray(mass.candidates) || !mass.candidates.length) throw new Error('Native HRMS calculation did not return an explicit candidate');
  await invoke('paper_audit_add_document', { projectId: project.id, filePath: path.join(config.sourceDir, 'main.txt'), role: 'main' });
  await invoke('paper_audit_add_document', { projectId: project.id, filePath: path.join(config.sourceDir, 'si.txt'), role: 'si' });
  const sourceImage = path.join(config.sourceDir, 'table.png');
  const sourceHash = createHash('sha256').update(await readFile(sourceImage)).digest('hex');
  await invoke('paper_audit_add_document', { projectId: project.id, filePath: sourceImage, role: 'si' });
  await invoke('paper_audit_add_document', { projectId: project.id, filePath: sourceImage, role: 'source' });
  await invoke('paper_audit_add_document', { projectId: project.id, filePath: path.join(config.sourceDir, 'spectrum.png'), role: 'source' });
  const importedProject = await invoke('paper_audit_project', { projectId: project.id });
  const imageDocument = importedProject.documents.find(document => document.name === 'table.png');
  if (!imageDocument?.key) throw new Error('Imported image source key missing');
  const prepared = await invoke('paper_audit_prepare_visuals', { projectId: project.id, documentKey: imageDocument.key });
  const duplicateDocument = importedProject.documents.find(document => document.name === 'table.png' && document.role === 'source');
  const duplicatePrepared = await invoke('paper_audit_prepare_image_audit', { projectId: project.id, documentKey: duplicateDocument.key, limit: 1 });
  if (duplicatePrepared.nextOffset !== null || duplicatePrepared.selectedAssets[0]?.status !== 'ready') throw new Error('Native duplicate-image preparation failed');
  const asset = prepared.assets.find(image => image.status === 'ready');
  if (!asset?.sha256 || asset.sourceSha256 !== sourceHash || asset.imageWidth !== 1600 || asset.imageHeight !== 500) throw new Error('Native image preparation lost source hash or pixel dimensions');
  const listedVisuals = await invoke('paper_audit_visuals', { projectId: project.id });
  if (!listedVisuals.items.some(image => image.id === asset.id)) throw new Error('Prepared image was not registered');
  const imageResult = await invoke('paper_audit_visual_image', { projectId: project.id, assetId: asset.id });
  if (imageResult.imageDelivered !== false || !imageResult.reason) throw new Error('No-model smoke must explicitly avoid delivering an image to an unknown model');
  const table = await invoke('paper_audit_read_image_table', { projectId: project.id, assetId: asset.id });
  if (table.status !== 'needs_review' || table.review.status !== 'needs_review' || table.layout !== 'detected_grid' || table.rows.length !== 4 || !table.rows.every(row => row.cells.length === 6)) throw new Error(`Actual native OCR did not recover a provisional 4-row, 6-column table: ${JSON.stringify({ status: table.status, rows: table.rows, notes: table.notes })}`);
  if (table.provider.route !== 'local_wasm' || table.provider.networkRequestsRequired !== false || table.source.sourceSha256 !== sourceHash || table.source.rasterSha256 !== asset.sha256) throw new Error('Native OCR provenance or offline route missing');
  const expectedTable = JSON.parse(await readFile(path.join(config.sourceDir, 'expected-table.json'), 'utf8'));
  // Verify values using the source fixture, independently of the OCR result.
  for (const [row, column] of [[2, 3], [2, 4], [3, 3], [3, 4], [4, 5], [4, 6]]) {
    if (table.rows[row - 1].cells[column - 1].text !== expectedTable[row - 1][column - 1]) throw new Error(`OCR fixture value mismatch at row ${row}, column ${column}`);
  }
  for (const row of table.rows) for (const cell of row.cells) if (!cell.bbox || cell.bbox.x < 0 || cell.bbox.y < 0 || cell.bbox.width <= 0 || cell.bbox.height <= 0 || cell.bbox.x + cell.bbox.width > asset.imageWidth || cell.bbox.y + cell.bbox.height > asset.imageHeight) throw new Error('OCR pixel box is outside the source image');
  await invoke('paper_audit_set_profile', { projectId: project.id, profileText: JSON.stringify({
    schema_version: 1,
    profile: { id: 'smoke-custom', name: 'Synthetic user rule, not journal standard', version: '1.0.0', source_type: 'user_defined', journal: null },
    rules: [{ id: 'smoke-h1', field: 'nmr.h1.chemical_shift', scope: 'si.characterization', number_format: { mode: 'decimal_places', digits: 3, rounding: 'half_up' } }],
  }) });
  await invoke('paper_audit_hrms_configure', { projectId: project.id, formulaBasis: 'neutral', ppmTolerance: 5 });
  const provisionalRun = await invoke('paper_audit_run', { projectId: project.id });
  const dossiers = await invoke('paper_audit_compounds', { projectId: project.id, runId: provisionalRun.id, records: true, limit: 100 });
  const compoundRecord = dossiers.items.find(r => r.kinds.includes('h1_text'));
  if (!compoundRecord) throw new Error('Native compound registry has no textual NMR record');
  const spectrumDocument = importedProject.documents.find(d => d.name === 'spectrum.png');
  const preparedSpectrum = await invoke('paper_audit_prepare_image_audit', { projectId: project.id, documentKey: spectrumDocument.key });
  const panel = await invoke('paper_audit_extract_panels', { projectId: project.id, assetId: preparedSpectrum.selectedAssets[0].id, rectanglesJson: JSON.stringify([{ x: 20, y: 20, width: 1460, height: 350 }]) });
  const spectrumReading = await invoke('paper_audit_read_spectrum', { projectId: project.id, runId: provisionalRun.id, recordId: compoundRecord.id, assetId: panel.assets[0].id });
  if (spectrumReading.fields.integralSum !== 2 || spectrumReading.review.status !== 'needs_review') throw new Error('Native spectrum OCR did not retain a provisional explicit label');
  await invoke('paper_audit_set_compound', { projectId: project.id, runId: provisionalRun.id, decisionJson: JSON.stringify({ compoundLabel: '3a', classification: 'new', links: [{ recordId: compoundRecord.id }], reason: 'Synthetic decision-state fixture only; not a decision about user research data' }) });
  await invoke('paper_audit_set_requirements', { projectId: project.id, requirementsJson: JSON.stringify({ name: 'Synthetic lab checklist', version: '1', source_type: 'user_defined', rules: [{ classification: 'new', allOf: ['h1_text', 'c13_spectrum'] }] }) });
  await invoke('paper_audit_scientific_configure', { projectId: project.id, optionsJson: '{}' });
  const experimental = await invoke('paper_audit_calculate_experiment', { inputJson: JSON.stringify({ kind: 'yield', limitingAmountMmol: 0.2, productMassMg: 48, molarMassGmol: 300, stoichiometricFactor: 1, reportedYieldPercent: 90 }) });
  if (experimental.calculated !== '80' || experimental.status !== 'needs_review') throw new Error('Native experimental yield arithmetic failed');
  if (provisionalRun.coverage.imageTables.provisionalTables !== 1 || provisionalRun.coverage.imageTables.acceptedTables !== 0) throw new Error('Unreviewed OCR was silently accepted');
  const review = await invoke('paper_audit_review_image_table', {
    projectId: project.id, tableId: table.id, status: 'accepted',
    reason: 'Synthetic release fixture only: scripted review-state transition against known source cells; this is not human validation or approval of real user data.',
    corrections: [{ row: 2, column: 3, text: expectedTable[1][2] }],
  });
  if (review.status !== 'accepted' || review.corrections?.[0]?.after !== '92') throw new Error('Explicit fixture review/correction transition was not recorded');
  const listedTables = await invoke('paper_audit_image_tables', { projectId: project.id });
  if (!listedTables.items.some(t => t.id === table.id && t.active && t.review.status === 'accepted')) throw new Error('Table list lost accepted review state');
  const run = await invoke('paper_audit_run', { projectId: project.id });
  if (run.execution?.entryPoint !== 'harness_native_tools' || !run.execution.toolCallId) throw new Error('Native execution route or host tool-call reference was not recorded');
  if (!run.id || run.documents.length !== 6 || run.factCount < 10 || run.issueCount < 2) {
    throw new Error('Synthetic conflict fixture did not produce expected audit evidence');
  }
  if (run.coverage.imageTables.acceptedTables !== 1 || run.coverage.imageTables.provisionalTables !== 0 || run.coverage.hrms.calculatedRecords !== 1) throw new Error('Reviewed OCR or configured HRMS was not included in the native run');
  const imageTableDocument = run.documents.find(document => document.format === 'image_table');
  const imageBlocks = await invoke('paper_audit_blocks', { projectId: project.id, runId: run.id, documentId: imageTableDocument.id });
  const imageEvidence = await invoke('paper_audit_evidence', { projectId: project.id, runId: run.id, evidenceId: imageBlocks.items[1].id });
  const imageMetadata = imageEvidence.block.metadata;
  if (imageMetadata.evidenceOrigin !== 'image_table_ocr' || imageMetadata.visualReviewStatus !== 'accepted' || imageMetadata.originalSourceSha256 !== sourceHash || imageMetadata.rasterSha256 !== asset.sha256 || imageMetadata.cells.length !== 6 || imageMetadata.cells[2].text !== '92' || !imageMetadata.cells[2].bbox) throw new Error('Frozen native image evidence lost cells, review state, source hashes or pixel boxes');
  const issues = await invoke('paper_audit_issues', { projectId: project.id, runId: run.id, limit: 10 });
  const firstIssue = issues.items.find(issue => issue.evidenceIds?.length);
  if (!firstIssue) throw new Error('No evidence-backed issue returned');
  const evidence = await invoke('paper_audit_evidence', { projectId: project.id, runId: run.id, evidenceId: firstIssue.evidenceIds[0] });
  if (!evidence.block?.text || !evidence.block?.locator) throw new Error('Evidence locator missing');
  const report = await invoke('paper_audit_export', { projectId: project.id, runId: run.id, format: 'md' });
  const reportText = await readFile(report.path, 'utf8');
  if (!reportText.includes('Paper–SI Audit') || !reportText.includes(run.id)) throw new Error('Report export invalid');
  const jsonReport = await invoke('paper_audit_export', { projectId: project.id, runId: run.id, format: 'json' });
  const exported = JSON.parse(await readFile(jsonReport.path, 'utf8'));
  if (!exported.issues.some(i => i.category === 'image_duplicate' && i.calculation.kind === 'exact_pixels') || !exported.issues.some(i => i.category === 'nmr_formula' && i.evidenceStatus === 'needs_review') || run.coverage.imageDuplicates.comparedPairs < 1 || !run.coverage.nmrFormula.comparedRecords) throw new Error('Native NMR and duplicate-image checks did not survive report export');
  if (!exported.compoundRegistry?.compounds.length || !exported.issues.some(i => i.category === 'nmr_image') || !exported.issues.some(i => i.category === 'compound_completeness')) throw new Error('Native dossier, spectrum comparison or checklist missing');
  if (exported.imageTables[0]?.review.status !== 'accepted' || exported.imageTables[0]?.rows[1].cells[2].originalOCRText !== '92' || !exported.facts.some(fact => fact.evidenceOrigin === 'image_table_ocr') || !exported.hrmsRecords.length) throw new Error('JSON export lost original OCR, user correction history, visual facts or HRMS records');
  if (createHash('sha256').update(await readFile(sourceImage)).digest('hex') !== sourceHash) throw new Error('Original synthetic image was modified');

  let wholeJob = await invoke('paper_audit_workflow', { projectId: project.id, action: 'start', maxSteps: 10 });
  for (let i = 0; i < 10 && wholeJob.nextAction; i++) wholeJob = await invoke('paper_audit_workflow', { projectId: project.id, action: 'resume', maxSteps: 10 });
  if (!['completed', 'completed_with_gaps'].includes(wholeJob.status) || !wholeJob.latestRunId) throw new Error('Native durable workflow did not finish');
  const materialText = await invoke('paper_audit_material_text', { projectId: project.id });
  if (materialText.total !== 3) throw new Error('Whole-project OCR did not read all source images');
  const materialWords = await invoke('paper_audit_material_text', { projectId: project.id, readingId: materialText.items[0].id });
  if (!materialWords.items.length) throw new Error('Native material OCR word evidence absent');
  const revisionProject = await invoke('paper_audit_create', { name: 'Synthetic revision and claim checks' });
  const revisionMain = path.join(config.sourceDir, 'revision-main.md'), revisionSI = path.join(config.sourceDir, 'revision-si.md');
  const oldText = 'Compound 3a: formula: C2H6O; 1H NMR δ 1.0 (s, 8H).\nThe isolated yield reached up to 98% yield (Table S1).\nThe limiting reagent 1a (0.20 mmol) was used; product molar mass is 300 g/mol and stoichiometric factor is 1. Purification afforded 3b (48 mg, 90% yield).';
  await writeFile(revisionMain, oldText); await writeFile(revisionSI, 'Table S1. Optimization.\n| Entry | Product | isolated yield |\n|---|---|---|\n| 1 | 3a | 92 |');
  await invoke('paper_audit_add_document', { projectId: revisionProject.id, filePath: revisionMain, role: 'main' });
  await invoke('paper_audit_add_document', { projectId: revisionProject.id, filePath: revisionSI, role: 'si' });
  await invoke('paper_audit_run', { projectId: revisionProject.id });
  const refs = await invoke('paper_audit_cross_references', { projectId: revisionProject.id });
  if (!refs.items.some(r => r.kind === 'maximum' && r.status === 'needs_review' && r.actual === 92)) throw new Error('Native conclusion/table mismatch absent');
  const prose = await invoke('paper_audit_experiments', { projectId: revisionProject.id });
  if (!prose.items.some(r => r.origin === 'experimental_prose' && r.calculation?.calculated === '80')) throw new Error('Native prose arithmetic absent');
  await writeFile(revisionMain, oldText.replace('8H', '6H'));
  const revised = await invoke('paper_audit_run', { projectId: revisionProject.id });
  const lineage = await invoke('paper_audit_revisions', { projectId: revisionProject.id });
  const resolved = lineage.items.find(r => r.state === 'candidate_resolved');
  if (!resolved) throw new Error('Native revision tracking lost corrected issue');
  await invoke('paper_audit_revalidate', { projectId: revisionProject.id, runId: revised.id, trackingId: resolved.id, status: 'fixed', reason: 'Synthetic explicit-user-state fixture; not human review of research data', citationsJson: JSON.stringify(resolved.currentCitations) });
  const closed = await invoke('paper_audit_revisions', { projectId: revisionProject.id });
  if (!closed.items.some(r => r.id === resolved.id && r.state === 'closed_by_user')) throw new Error('Native explicit revalidation not recorded');

  // Emit only after this apply returns, so Loader can finish this probe's activation.
  setImmediate(() => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'paper-audit.smoke', params: {
    passed: true, nativeToolCount: expectedToolNames.length, projectId: project.id, runId: run.id,
    documents: run.documents.length, facts: run.factCount, issues: run.issueCount,
    engineVersion: run.engineVersion, execution: run.execution,
    evidenceRead: true, reportExported: true, semanticStatus: run.coverage.semanticStatus,
    modelCalls: 0, syntheticDataOnly: true,
    crossReferencesChecked: true, proseExtractionChecked: true, revisionRevalidationChecked: true, wholeProjectWorkflowChecked: true,
    exactMassCalculated: true, webPanelIncluded: false,
    nmrFormulaChecked: true, duplicateImagesChecked: true,
    compoundRegistryChecked: true, panelExtractionChecked: true, spectrumLabelsCompared: true, experimentalYieldCalculated: true,
    imageTableOcr: { provider: table.provider, rows: table.rows.length, columns: table.rows[0].cells.length, sourceHash, rasterHash: asset.sha256, sourcePixels: [asset.imageWidth, asset.imageHeight], exactFixtureValuesChecked: 6, imageEvidenceRead: true, originalUnchanged: true, provisionalRunId: provisionalRun.id, acceptedInFinalRun: true, syntheticReviewTransition: true, humanReviewPerformed: false, imageDeliveredToModel: false },
  } }) + '\n'));
}
