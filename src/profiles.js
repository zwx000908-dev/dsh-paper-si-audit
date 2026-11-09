import { parse as parseYaml } from 'yaml';

const FIELDS = new Set(['yield.percent', 'stereo.ee', 'stereo.er', 'stereo.dr', 'reaction.temperature', 'reaction.time', 'reaction.scale', 'reaction.concentration', 'nmr.h1.chemical_shift', 'nmr.c13.chemical_shift', 'nmr.other.chemical_shift', 'nmr.coupling_constant', 'nmr.frequency', 'nmr.integral', 'hrms.mass_to_charge']);
const SCOPES = new Set(['all', 'main', 'si', 'source', 'si.characterization']);
const REQUIREMENTS = new Set(['user_preference', 'journal_recommended', 'journal_mandatory']);
const UNITS = new Set(['%', 'ppm', 'Hz', 'MHz', '°C', 'K', 'h', 'min', 's', 'mol', 'mmol', 'umol', 'µmol', 'M', 'mM', 'm/z']);
const FIELD_UNITS = {
  'yield.percent': ['%'], 'stereo.ee': ['%'], 'stereo.er': [], 'stereo.dr': [],
  'reaction.temperature': ['°C', 'K'], 'reaction.time': ['h', 'min', 's'], 'reaction.scale': ['mol', 'mmol', 'umol', 'µmol'], 'reaction.concentration': ['M', 'mM'],
  'nmr.h1.chemical_shift': ['ppm'], 'nmr.c13.chemical_shift': ['ppm'], 'nmr.other.chemical_shift': ['ppm'], 'nmr.coupling_constant': ['Hz'], 'nmr.frequency': ['MHz', 'Hz'], 'nmr.integral': [], 'hrms.mass_to_charge': ['m/z'],
};
const SOURCE_TYPES = new Set(['user_defined', 'official_requirement', 'official_recommendation', 'template_example', 'laboratory']);
const fail = message => { throw new Error(`格式配置无效：${message}`); };
const object = (v, where) => { if (!v || typeof v !== 'object' || Array.isArray(v)) fail(`${where} 必须是对象`); };
function keys(v, allowed, where) { for (const k of Object.keys(v)) if (!allowed.includes(k)) fail(`${where} 含未知字段 ${k}`); }
function string(v, where, max = 200) { if (typeof v !== 'string' || !v.trim() || v.length > max) fail(`${where} 必须是非空字符串（最多 ${max} 字符）`); return v; }
function source(v, where) {
  if (v === undefined) return undefined;
  object(v, where); keys(v, ['type', 'status', 'url', 'file', 'quote', 'checked_at', 'article_type'], where);
  if (v.type !== undefined && !SOURCE_TYPES.has(v.type)) fail(`${where}.type 不支持`);
  if (!['verified', 'unverified', 'superseded'].includes(v.status)) fail(`${where}.status 必须是 verified/unverified/superseded`);
  for (const k of ['url', 'file', 'quote', 'checked_at', 'article_type']) if (v[k] !== undefined) string(v[k], `${where}.${k}`, k === 'quote' ? 4000 : 1000);
  if (v.url && !/^https?:\/\//i.test(v.url)) fail(`${where}.url 必须是 HTTP(S) 来源`);
  return { ...v };
}

/** Strict declaration-only profile. Unknown operations are rejected rather than silently ignored. */
export function validateProfile(value) {
  object(value, 'root'); keys(value, ['schema_version', 'profile', 'rules'], 'root');
  if (value.schema_version !== 1) fail('schema_version 必须为 1');
  object(value.profile, 'profile');
  keys(value.profile, ['id', 'name', 'version', 'source_type', 'journal', 'article_type', 'source'], 'profile');
  for (const k of ['id', 'name', 'version']) string(value.profile[k], `profile.${k}`);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(value.profile.id)) fail('profile.id 只能含字母、数字、点、下划线和连字符');
  if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(value.profile.version)) fail('profile.version 需要语义版本');
  const sourceType = value.profile.source_type ?? 'user_defined';
  if (!SOURCE_TYPES.has(sourceType)) fail('profile.source_type 不支持');
  if (value.profile.journal != null) string(value.profile.journal, 'profile.journal');
  if (value.profile.article_type !== undefined) string(value.profile.article_type, 'profile.article_type');
  const profileSource = source(value.profile.source, 'profile.source');
  if (!Array.isArray(value.rules) || value.rules.length > 200) fail('rules 必须为最多 200 条的数组');
  const seen = new Set(); const overlaps = new Set();
  const rules = value.rules.map((r, index) => {
    const where = `rules[${index}]`; object(r, where);
    keys(r, ['id', 'field', 'scope', 'requirement', 'number_format', 'expected_unit', 'action', 'source', 'enabled', 'override_of', 'reason', 'entity', 'block_id'], where);
    string(r.id, `${where}.id`); if (seen.has(r.id)) fail(`重复规则 ID ${r.id}`); seen.add(r.id);
    if (!FIELDS.has(r.field)) fail(`${where}.field 不支持：${r.field}`);
    const scope = r.scope ?? 'all'; if (!SCOPES.has(scope)) fail(`${where}.scope 不支持`);
    const requirement = r.requirement ?? 'user_preference'; if (!REQUIREMENTS.has(requirement)) fail(`${where}.requirement 不支持`);
    const s = source(r.source, `${where}.source`) ?? profileSource;
    if (requirement === 'journal_mandatory' && (!s || s.status !== 'verified' || !s.quote || !(s.url || s.file) || !s.checked_at)) fail(`${where} 的期刊强制规则必须有已核实来源、摘录、日期与链接/文件`);
    if (r.enabled !== undefined && typeof r.enabled !== 'boolean') fail(`${where}.enabled 必须是布尔值`);
    if (requirement === 'journal_mandatory' && r.enabled === false) fail('不可静默停用期刊强制规则；可更换模板并在报告说明');
    if (r.action !== undefined && !['preview_only', 'check_only'].includes(r.action)) fail(`${where}.action 仅支持 preview_only/check_only`);
    if (r.expected_unit !== undefined && !UNITS.has(r.expected_unit)) fail(`${where}.expected_unit 不支持`);
    if (r.expected_unit !== undefined && !FIELD_UNITS[r.field].includes(r.expected_unit)) fail(`${where}.expected_unit 与字段量纲不匹配`);
    let numberFormat;
    if (r.number_format !== undefined) {
      const n = r.number_format; object(n, `${where}.number_format`); keys(n, ['mode', 'digits', 'rounding'], `${where}.number_format`);
      if (!['decimal_places', 'significant_figures'].includes(n.mode)) fail(`${where} 的数字模式不支持`);
      if (!Number.isInteger(n.digits) || n.digits < (n.mode === 'significant_figures' ? 1 : 0) || n.digits > 12) fail(`${where}.digits 超出允许范围`);
      if (n.rounding !== undefined && !['half_up', 'half_even', 'truncate'].includes(n.rounding)) fail(`${where}.rounding 不支持`);
      numberFormat = { mode: n.mode, digits: n.digits, rounding: n.rounding ?? 'half_up' };
    }
    if (!numberFormat && !r.expected_unit) fail(`${where} 至少设置数字格式或单位`);
    for (const k of ['override_of', 'reason', 'entity', 'block_id']) if (r[k] !== undefined) string(r[k], `${where}.${k}`, k === 'reason' ? 1000 : 200);
    if ((r.override_of || r.entity || r.block_id) && !r.reason) fail(`${where} 的覆盖或局部例外需要 reason`);
    const signature = [r.field, scope, r.entity ?? '', r.block_id ?? '', requirement].join('|');
    if (r.enabled !== false && overlaps.has(signature) && !r.override_of) fail(`${where} 与同字段同范围规则重叠，需要显式 override_of`);
    if (r.enabled !== false) overlaps.add(signature);
    return { ...r, scope, requirement, enabled: r.enabled ?? true, action: r.action ?? 'preview_only', ...(numberFormat ? { number_format: numberFormat } : {}), ...(s ? { source: s } : {}) };
  });
  for (const r of rules) if (r.override_of) {
    const prior = rules.find(x => x.id === r.override_of);
    if (!prior || prior.id === r.id || prior.field !== r.field) fail(`规则 ${r.id} 的 override_of 无效`);
    const chain = new Set([r.id]); let cursor = prior;
    while (cursor) { if (chain.has(cursor.id)) fail('规则覆盖存在循环'); chain.add(cursor.id); cursor = rules.find(x => x.id === cursor.override_of); }
  }
  return { schema_version: 1, profile: { ...value.profile, source_type: sourceType, journal: value.profile.journal ?? null, ...(profileSource ? { source: profileSource } : {}) }, rules };
}

export function parseProfile(text, filename = '') {
  if (typeof text !== 'string' || text.length > 1024 * 1024) fail('配置内容必须是最多 1 MiB 的文本');
  let value;
  try { value = filename.toLowerCase().endsWith('.json') || text.trimStart().startsWith('{') ? JSON.parse(text) : parseYaml(text, { maxAliasCount: 0, uniqueKeys: true }); }
  catch (error) { fail(`无法解析 JSON/YAML：${error.message}`); }
  return validateProfile(value);
}

export function defaultProfile() { return { schema_version: 1, profile: { id: 'unconfigured', name: '未指定期刊或格式要求', version: '1.0.0', source_type: 'user_defined', journal: null }, rules: [] }; }
export function exampleProfile() {
  return validateProfile({ schema_version: 1, profile: { id: 'custom-demo', name: '用户自定义演示（非期刊标准）', version: '1.0.0', source_type: 'user_defined', journal: null }, rules: [
    { id: 'h1-shift', field: 'nmr.h1.chemical_shift', scope: 'si.characterization', number_format: { mode: 'decimal_places', digits: 3, rounding: 'half_up' }, expected_unit: 'ppm' },
    { id: 'c13-shift', field: 'nmr.c13.chemical_shift', scope: 'si.characterization', number_format: { mode: 'decimal_places', digits: 4, rounding: 'half_up' }, expected_unit: 'ppm' },
    { id: 'coupling', field: 'nmr.coupling_constant', scope: 'si.characterization', number_format: { mode: 'decimal_places', digits: 1, rounding: 'half_up' }, expected_unit: 'Hz' },
    { id: 'hrms', field: 'hrms.mass_to_charge', scope: 'si.characterization', number_format: { mode: 'decimal_places', digits: 4, rounding: 'half_up' } },
  ] });
}

export const supportedFields = Object.freeze([...FIELDS]);
