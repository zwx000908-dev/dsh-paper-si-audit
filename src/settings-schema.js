import Schema from '@deepseek-ai/schemastery';
import { homedir } from 'node:os';
import path from 'node:path';
const number=(value,min,max,label,integer=false)=>{let s=Schema.number().min(min).max(max);if(integer)s=s.step(1);return s.default(value).description(label);};
const flag=(value,label)=>Schema.boolean().default(value).description(label);
export const Config=Schema.object({
 dataDir:Schema.string().default(path.join(homedir(),'.paper-si-audit')).description('项目保存目录（绝对路径；更改不会自动搬迁旧项目）'),
 allowedRoots:Schema.array(Schema.string()).default([]).description('允许读取的论文目录（绝对路径；空列表禁止导入）'),
 defaults:Schema.object({
  scope:Schema.union(['all','si']).default('all').description('默认核对范围：all=全部已导入材料，si=仅补充信息'),
  checks:Schema.object(Object.fromEntries(Object.entries({crossDocument:'正文与 SI 数值比较',stoichiometry:'用量/当量检查',hrms:'HRMS 精确质量告警',nmr:'核磁文字与分子式核对',experiments:'实验段落复算',crossReferences:'图表与结论引用核对',pixelDuplicates:'程序图片查重',visualReview:'视觉 Agent 复核入口'}).map(([k,label])=>[k,flag(true,label)]))).description('默认启用的检查').default({}),
  formatting:Schema.object({enabled:flag(false,'启用自定义小数位模板（不代表期刊要求）'),h1Digits:number(2,0,10,'¹H 化学位移小数位',true),c13Digits:number(1,0,10,'¹³C 化学位移小数位',true),couplingDigits:number(1,0,10,'J 偶合常数小数位',true),hrmsDigits:number(4,0,10,'MS 数值小数位',true),profileText:Schema.string().role('textarea').default('').description('高级：完整 JSON/YAML 格式模板，含有效数字/单位/来源；填写后优先于上面的小数位模板')}).description('格式模板').default({}),
  scientific:Schema.object({nmrIntegralTolerance:number(.05,0,2,'氢积分总数容差'),nmrShiftTolerance:number(.03,0,5,'化学位移比较容差 ppm'),frequencyToleranceMHz:number(1,0,100,'核磁频率容差 MHz'),yieldTolerancePercent:number(1,0,20,'收率差值容差（百分点）'),amountRelativeTolerance:number(.02,0,.5,'质量/mmol 相对容差'),imageRmse:number(.1,.001,.5,'整图相似阈值（非概率）'),localImageRmse:number(.08,.001,.3,'局部相似阈值（非概率）'),localImages:flag(true,'启用有限网格局部匹配'),maxImageAssets:number(1000,1,5000,'程序查重图片上限',true),imagePairBudget:number(2000,1,100000,'程序每次比较对数',true)}).description('数值容差与程序图片查重').default({}),
  hrms:Schema.object({ppmTolerance:number(5,.001,10000,'HRMS ppm 告警容差'),mDaTolerance:Schema.union([Schema.const(null).description('不设置绝对 mDa 阈值'),number(1,.001,1000,'绝对 mDa 告警容差')]).default(null)}).description('HRMS 容差（不设置分子式口径）').default({}),
  imageTypeRulesJson:Schema.string().role('textarea').default('').description('高级：按图片类型覆盖查重规则的 JSON；空白采用内置分类规则'),
  visual:Schema.object({mode:Schema.union(['all','same_type']).default('all').description('视觉配对：全部或同类型（unknown 仍参与比较）'),includeSelf:flag(true,'检查同一图片内部的不同区域'),maxAssets:number(200,1,500,'视觉图片上限',true),maxPairs:number(2000,1,10000,'视觉每批任务上限',true)}).description('视觉 Agent 任务预算；模型由 Harness 管理').default({}),
  workflow:Schema.object({ocr:flag(true,'整篇准备时运行本地 OCR（结果保持未确认）'),maxSteps:number(3,1,25,'每次工作流执行步数',true)}).description('材料读取与任务推进').default({}),
  report:Schema.object({format:Schema.union(['md','json','csv']).default('md').description('默认导出格式'),includeImages:flag(true,'Markdown 中展示对照图片'),includeEvidence:flag(true,'Markdown 中展示完整逐条证据区块；关闭仅缩短展示，不删除 JSON 证据')}).description('报告展示').default({}),
 }).description('新项目默认设置（已有项目保留原设置；单次任务可覆盖）').default({}),
});
