import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateExactMass, parseFormula, massError, checkHrms, HRMS_DATA_INFO } from '../src/hrms.js';

const close = (value, expected, tolerance = 1e-10) => assert.ok(Math.abs(Number(value) - expected) < tolerance, `${value} vs ${expected}`);
const documents = text => [{ id: 'si', role: 'si', blocks: [{ id: 'b1', text, locator: { label: 'SI paragraph' } }] }];

test('pinned isotope table uses neutral isotope masses, exact carbon-12, and CODATA electron mass', () => {
  assert.equal(HRMS_DATA_INFO.electronMassU, '0.0005485799090441');
  assert.match(HRMS_DATA_INFO.electronMassSource, /physics\.nist\.gov/);
  assert.equal(calculateExactMass({ formula: 'C', formulaBasis: 'neutral' }).candidates[0].neutralMonoisotopicMassDa, '12');
  close(calculateExactMass({ formula: 'H2O', formulaBasis: 'neutral' }).candidates[0].neutralMonoisotopicMassDa, 18.01056468403);
  assert.equal(calculateExactMass({ formula: 'H2O', formulaBasis: 'neutral' }).candidates[0].mz, null);
});
test('formula parser expands parentheses, hydrates, isotopes and D without interpreting average atomic weights', () => {
  assert.deepEqual(parseFormula('C6H5(OH)3').counts, { C: 6, H: 8, O: 3 });
  assert.deepEqual(parseFormula('CuSO4·5H2O').counts, { Cu: 1, S: 1, O: 9, H: 10 });
  assert.deepEqual(parseFormula('[13C]2C4H12O6').counts, { '[13C]': 2, C: 4, H: 12, O: 6 });
  assert.deepEqual(parseFormula('C₆H₁₂O₆').counts, { C: 6, H: 12, O: 6 });
  assert.deepEqual(parseFormula('CD3OD').counts, { C: 1, '[2H]': 4, O: 1 });
  close(calculateExactMass({ formula: 'B', formulaBasis: 'neutral' }).candidates[0].ionMassDa, 11.00930536);
});
test('neutral adducts, deprotonation, dimers and multiply charged ions apply atoms and electron correction once', () => {
  const c = args => calculateExactMass({ formula: 'C6H12O6', formulaBasis: 'neutral', ...args }).candidates[0];
  close(c({ ion: '[M+H]+' }).mz, 181.07066455650096);
  close(c({ ion: '[M+Na]+' }).mz, 203.05260880627096);
  close(c({ ion: '[M-H]-' }).mz, 179.05611165185905);
  close(c({ ion: '[2M+H]+' }).mz, 361.13405266068096);
  close(c({ ion: '[M+2H]2+' }).mz, 91.03897050441096);
  close(c({ ion: '[M]+' }).electronCorrectionDa, -0.0005485799090441);
  close(c({ ion: '[M]-' }).electronCorrectionDa, 0.0005485799090441);
  assert.equal(c({ ion: '[M+NH4]+' }).ionFormula, 'C6H16NO6');
  assert.equal(c({ ion: '[M+H-H2O]+' }).ionFormula, 'C6H11O5');
});
test('ion formula interpretation never double-adds a proton or multiplies a final ion formula', () => {
  const neutral = calculateExactMass({ formula: 'C6H12O6', ion: '[M+H]+', formulaBasis: 'neutral' }).candidates[0];
  const ion = calculateExactMass({ formula: 'C6H13O6', ion: '[M+H]+', formulaBasis: 'ion' }).candidates[0];
  assert.equal(ion.mz, neutral.mz);
  assert.equal(calculateExactMass({ formula: 'C12H25O12', ion: '[2M+H]+', formulaBasis: 'ion' }).candidates[0].ionFormula, 'C12H25O12');
  assert.equal(parseFormula('[C6H14O6]2+').charge, 2);
  assert.equal(calculateExactMass({ formula: 'C6H14O6^2+' }).status, 'calculated');
  assert.equal(parseFormula('C6H14O6²⁺').charge, 2);
});
test('final ion formulas must be atom-consistent with the stated adduct and multimer', () => {
  assert.throws(() => calculateExactMass({ formula: 'C2H7O+', ion: '[M+Na]+', formulaBasis: 'ion' }), /inconsistent/);
  assert.throws(() => calculateExactMass({ formula: 'C3H7O+', ion: '[2M+H]+', formulaBasis: 'ion' }), /integer/);
  const consistent = calculateExactMass({ formula: 'C12H25O12', ion: '[2M+H]+', formulaBasis: 'ion' }).candidates[0];
  assert.equal(consistent.adductCompositionCheck.moleculeFormula, 'C6H12O6');
  const loss = calculateExactMass({ formula: 'C6H11O5', ion: '[M+H-H2O]+', formulaBasis: 'ion' }).candidates[0];
  assert.equal(loss.adductCompositionCheck.moleculeFormula, 'C6H12O6');
  for (const [formula, ion] of [['C2H7O+', '[M+Na]+'], ['C3H7O+', '[2M+H]+']]) {
    const result = checkHrms(documents(`HRMS calcd for ${formula} ${ion} 47.0491; found 47.0490.`), { formulaBasis: 'ion' });
    assert.equal(result.records[0].status, 'unsupported');
    assert.equal(result.issues[0].type, 'coverage');
  }
});
test('ambiguous uncharged formula returns two candidates without selecting the one nearest reported mass', () => {
  const result = calculateExactMass({ formula: 'C18H22NO3', ion: '[M+H]+' });
  assert.equal(result.status, 'ambiguous'); assert.deepEqual(result.candidates.map(c => c.basis), ['neutral', 'ion']);
  assert.equal(result.candidates[0].ionFormula, 'C18H23NO3'); assert.equal(result.candidates[1].ionFormula, 'C18H22NO3');
  assert.notEqual(result.candidates[0].mz, result.candidates[1].mz);
  const check = checkHrms(documents('EI-MS: calculated C18H22NO3 [M+H]+ 300.1600; Found 300.1605.'));
  assert.equal(check.records.length, 1); assert.equal(check.records[0].status, 'ambiguous');
  assert.equal(check.records[0].foundReported, '300.1605'); assert.equal(check.records[0].reportedResolution, 'unspecified');
  assert.equal(check.issues[0].evidenceStatus, 'needs_review'); assert.match(check.issues[0].title, /口径待确认/);
  assert.equal(check.records[0].candidates.length, 2);
});
test('explicit ionic formula text and user-neutral configuration support distinct calculated and found comparisons', () => {
  const input = documents('HRMS (ESI) calculated for neutral formula C6H12O6 [M+H]+ 181.0707; found 181.0708.');
  const result = checkHrms(input);
  assert.equal(result.records[0].status, 'calculated');
  assert.equal(result.records[0].candidates[0].calcdRoundingCompatible, true);
  assert.equal(result.records[0].candidates[0].foundWithinTolerance, true);
  assert.notEqual(result.records[0].candidates[0].calcdError.ppm, result.records[0].candidates[0].foundError.ppm);
  assert.equal(result.issues.length, 0);
  const miscalculated = checkHrms(documents('HRMS calculated for C6H12O6 [M+H]+ 181.1707; found 181.0708.'), { formulaBasis: 'neutral' });
  assert.match(miscalculated.issues[0].title, /计算质量/);
  const measurement = checkHrms(documents('HRMS calculated for C6H12O6 [M+H]+ 181.0707; found 181.0908.'), { formulaBasis: 'neutral', ppmTolerance: 5 });
  assert.match(measurement.issues[0].title, /偏差超过/);
});
test('all formula, ion and calculated/found citations point to exact original source spans', () => {
  const docs = documents('Prefix. HRMS: calcd for C7H8O [M+Na]+: 131.0467; Found: 131.0468. Next text.');
  const result = checkHrms(docs, { formulaBasis: 'neutral' }); assert.equal(result.records.length, 1);
  const record = result.records[0];
  for (const c of Object.values(record.citations)) assert.equal(docs[0].blocks[0].text.slice(c.start, c.end), c.quote);
  assert.equal(record.citations.formula.quote, 'C7H8O'); assert.equal(record.citations.ion.quote, '[M+Na]+');
  assert.equal(record.citations.calculated.quote, '131.0467'); assert.equal(record.citations.found.quote, '131.0468');
});
test('found only accepts an adjacent numeric value and never borrows a later NMR or sentence number', () => {
  for (const suffix of ['found not detected. 1H NMR 7.26 ppm.', 'found not detected.', 'found. 181.0708.', 'found: not detected; 181.0708.', 'Found not available. Compound B has 181.0708.', 'Found for C8H10O2 [M+H]+ 181.0708.', 'found 1H NMR 7.26 ppm.', 'found 181.0708e; 1H NMR 7.26 ppm.']) {
    const result = checkHrms(documents(`HRMS calcd for C6H12O6 [M+H]+ 181.0707; ${suffix}`), { formulaBasis: 'neutral' });
    const record = result.records[0];
    assert.equal(record.status, 'calculated', suffix);
    assert.equal(record.foundReported, null, suffix);
    assert.equal(record.foundStatus, 'unreadable', suffix);
    assert.equal(record.foundCheckStatus, 'not_checked', suffix);
    assert.equal(record.candidates[0].foundError, null, suffix);
    assert.equal(record.candidates[0].foundWithinTolerance, null, suffix);
    assert.equal(result.coverage.foundUnreadableRecords, 1, suffix);
    assert.equal(result.coverage.foundCheckedRecords, 0, suffix);
    assert.equal(result.issues.length, 1, suffix);
    assert.equal(result.issues[0].type, 'coverage', suffix);
    assert.match(result.issues[0].title, /未能读取/);
    assert.equal(record.citations.foundMarker.quote.toLowerCase(), 'found');
    assert.equal(record.citations.found, undefined);
  }
});
test('adjacent found decimal, colon, m/z notation and scientific values retain exact source evidence', () => {
  for (const [foundText, expected] of [['found 181.0708.', '181.0708'], ['Found: 181.0708.', '181.0708'], ['found m/z = 181.0708.', '181.0708'], ['found: m/z: 181.0708.', '181.0708'], ['found 1.810708e2.', '1.810708e2'], ['found:\n+1.810708E+2.', '+1.810708E+2']]) {
    const docs = documents(`HRMS calcd for C6H12O6 [M+H]+ 181.0707; ${foundText}`);
    const result = checkHrms(docs, { formulaBasis: 'neutral' });
    const record = result.records[0];
    assert.equal(record.foundReported, expected, foundText);
    assert.equal(record.foundStatus, 'reported', foundText);
    assert.equal(record.foundCheckStatus, 'checked', foundText);
    assert.equal(record.candidates[0].foundError.observed, '181.0708', foundText);
    assert.equal(record.candidates[0].foundWithinTolerance, true, foundText);
    assert.equal(record.citations.found.quote, expected, foundText);
    for (const citation of Object.values(record.citations)) assert.equal(docs[0].blocks[0].text.slice(citation.start, citation.end), citation.quote);
    assert.equal(result.coverage.foundCheckedRecords, 1, foundText);
    assert.equal(result.issues.length, 0, foundText);
  }
});
test('calculated scientific notation uses its exponent when determining reported rounding precision', () => {
  for (const calcd of ['1.810707e2', '1810707e-4', '+1.810707E+2', '1.8107e2']) {
    const result = checkHrms(documents(`HRMS calcd for C6H12O6 [M+H]+ ${calcd}; found 1.810708e2.`), { formulaBasis: 'neutral' });
    assert.equal(result.records[0].calculatedReported, calcd);
    assert.equal(result.records[0].citations.calculated.quote, calcd);
    assert.equal(result.records[0].candidates[0].calcdRoundingCompatible, true, calcd);
    assert.equal(result.issues.length, 0, calcd);
  }
  const wrong = checkHrms(documents('HRMS calcd for C6H12O6 [M+H]+ 1.810708e2; found 1.810708e2.'), { formulaBasis: 'neutral' });
  assert.equal(wrong.records[0].candidates[0].calcdRoundingCompatible, false);
  assert.match(wrong.issues[0].title, /计算质量/);
});
test('calculated values cannot be borrowed through calibration or another analytical field', () => {
  for (const suffix of ['m/z at 100 ppm calibration 181.0707', 'm/z at 100.00 ppm calibration 181.0707', 'was not measured. 1H NMR 7.26', '; NMR 181.0707']) {
    const result = checkHrms(documents(`HRMS calcd for C6H12O6 [M+H]+ ${suffix}; found 181.0708.`), { formulaBasis: 'neutral' });
    assert.equal(result.records[0].status, 'unsupported', suffix);
    assert.equal(result.issues[0].type, 'coverage', suffix);
    assert.equal(result.records[0].calculatedReported, undefined, suffix);
  }
});
test('absence of a found marker is disclosed separately from a calculated theoretical mass', () => {
  const result = checkHrms(documents('HRMS calcd for C6H12O6 [M+H]+ 181.0707. 1H NMR 7.26 ppm.'), { formulaBasis: 'neutral' });
  assert.equal(result.records[0].status, 'calculated');
  assert.equal(result.records[0].foundStatus, 'not_reported');
  assert.equal(result.records[0].foundCheckStatus, 'not_checked');
  assert.equal(result.records[0].foundReported, null);
  assert.equal(result.records[0].candidates[0].foundWithinTolerance, null);
  assert.equal(result.coverage.foundNotReportedRecords, 1);
  assert.equal(result.coverage.foundCheckedRecords, 0);
});
test('unsupported or incomplete records are explicit rather than passing or inventing a missing mass', () => {
  const unknown = checkHrms(documents('HRMS calculated for XeF2 [M]+ 169.9012; found 169.9010.'));
  assert.equal(unknown.coverage.unsupportedRecords, 1); assert.equal(unknown.issues[0].type, 'coverage');
  const missing = checkHrms(documents('HRMS calculated for C6H12O6 [M+H]+; Found 181.0708.'));
  assert.equal(missing.records[0].status, 'unsupported'); assert.equal(missing.records[0].calculatedReported, undefined);
  assert.equal(checkHrms(documents('EI-MS: m/z 300.16 (100), 145 (30).')).records.length, 0);
  assert.equal(checkHrms(documents('HRMS calculated for C6H12O6 or C6H14O6 [M+H]+ 181.0707; found 181.0708.')).records[0].status, 'unsupported');
  const noCharge = checkHrms(documents('HRMS calculated for C6H12O6 180.0634; found 180.0635.'), { formulaBasis: 'neutral' });
  assert.match(noCharge.issues[0].title, /电荷/);
});
test('invalid, huge, conflicting and ambiguous syntax is rejected with no code execution or guessed atoms', () => {
  for (const formula of ['R2CO', 'XxH2', 'C0H2', 'H99999999', '(CH2', 'C6H12O6)', 'Fe3+', '[99C]H4', 'C2H5 OH', '2H2O', 'C1.5H2', 'C6H12O6;process.exit()']) assert.throws(() => parseFormula(formula), /HRMS/);
  assert.throws(() => calculateExactMass({ formula: 'C6H12O6', ion: '[M+H]+', charge: -1 }), /conflicts/);
  assert.throws(() => calculateExactMass({ formula: 'C6H12O6+', formulaBasis: 'neutral' }), /charged/);
  assert.throws(() => calculateExactMass({ formula: 'C', ion: '[M-H]-', formulaBasis: 'neutral' }), /losses/);
  assert.throws(() => calculateExactMass({ formula: 'H2O', ion: '[M+H]' }), /charge/);
  assert.throws(() => checkHrms([], { ppmTolerance: -1 }), /configuration/);
  assert.throws(() => checkHrms([], { formulaBasis: 'closest_reported' }), /configuration/);
});
test('ppm and mDa errors are signed and explicit, not a fabricated confidence score', () => {
  assert.deepEqual(massError('100.0005', '100'), { observed: '100.0005', theoretical: '100', deltaDa: '0.0005', deltaMDa: '0.5', ppm: '5' });
  assert.equal(massError('99.9995', '100').ppm, '-5');
  assert.throws(() => massError('NaN', '100'), /positive/);
  assert.throws(() => massError('1e999999', '100'), /bounded/);
});
