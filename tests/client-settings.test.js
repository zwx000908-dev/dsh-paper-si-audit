import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {Config} from '../src/settings-schema.js';
import {readRuntimeConfig} from '../src/runtime-settings.js';

// Execute the actual page component and its handlers with a deterministic hook
// scheduler. This covers controlled input round trips, not browser layout.
async function editor(save=async()=>{}){
 let loaded,Page,props,cursor=0,pending=[],changed=false;
 const states=[],dependencies=[];
 const snapshot={status:'ready',writable:true,revision:7,value:readRuntimeConfig(Config({allowedRoots:['C:/papers']}))};
 const React={
  Fragment:'fragment',createElement:(type,props,...children)=>({type,props:props??{},children}),
  useSyncExternalStore:()=>snapshot,
  useState:initial=>{const i=cursor++;if(!(i in states))states[i]=initial;return[states[i],v=>{const next=typeof v==='function'?v(states[i]):v;if(!Object.is(next,states[i]))changed=true;states[i]=next;}];},
  useEffect:(fn,deps)=>{const i=cursor++;if(!dependencies[i]||deps.some((v,j)=>!Object.is(v,dependencies[i][j]))){pending.push(fn);dependencies[i]=deps;}},
 };
 vm.runInNewContext(await readFile(new URL('../client/index.js',import.meta.url),'utf8'),{window:{__ModuleLoader__:{load:v=>loaded=v}},structuredClone});
 loaded.factory(()=>React).apply({effect:f=>f(),configForms:{get:()=>({})},slots:{inject:(_name,f)=>f(),register:(options,page)=>{Page=page;props={...options.inject(),save:async(value,revision)=>{const result=await save(value,revision);return result??{saved:true,view:{value:structuredClone(value),revision:revision+1}};}};return()=>{};}}});
 const render=()=>{let tree;for(let attempt=0;attempt<10;attempt++){cursor=0;pending=[];changed=false;tree=Page(props);for(const fn of pending)fn();if(!changed)return tree;}throw new Error('Unstable component state');};
 function find(node,predicate){if(!node||typeof node!=='object')return;if(predicate(node))return node;for(const child of(node.children??[]).flat(Infinity)){const result=find(child,predicate);if(result)return result;}}
 const field=()=>find(render(),n=>n.props['aria-label']==='允许读取的论文目录（每行一个绝对路径）');
 const button=label=>find(render(),n=>n.type==='button'&&n.children.includes(label));
 return{snapshot,field,button,render,find,type:text=>field().props.onChange({target:{value:text}})};
}
test('directory editing preserves Enter, spaces and blank lines until Save',async()=>{
 let saved,revision;const ui=await editor(async(value,rev)=>{saved=value;revision=rev;});
 ui.type('C:/papers\n');assert.equal(ui.field().props.value,'C:/papers\n');
 ui.type('C:/papers\nC:/My ');assert.equal(ui.field().props.value,'C:/papers\nC:/My ');
 ui.type('C:/papers\r\n\r\n  C:/My Papers  \r\n');
 assert.equal(ui.field().props.value,'C:/papers\r\n\r\n  C:/My Papers  \r\n');
 await ui.button('保存设置').props.onClick();
 assert.deepEqual(Array.from(saved.allowedRoots),['C:/papers','C:/My Papers']);assert.equal(revision,7);
 assert.deepEqual(ui.snapshot.value.allowedRoots,['C:/papers']);
});
test('rejected save preserves draft for correction; Reload restores the host value',async()=>{
 const ui=await editor(async()=>{throw new Error('目录不存在');});
 ui.type('C:/wrong\nC:/My ');await ui.button('保存设置').props.onClick();
 assert.equal(ui.field().props.value,'C:/wrong\nC:/My ');
 assert.ok(ui.find(ui.render(),n=>n.props.role==='status'&&n.children.includes('保存失败：目录不存在')));
 assert.equal(ui.button('保存设置').props.disabled,false);
 ui.button('重新读取').props.onClick();assert.equal(ui.field().props.value,'C:/papers');
 assert.equal(ui.button('保存设置').props.disabled,true);
});
test('clearing all directory lines saves an empty allow list',async()=>{
 let saved;const ui=await editor(async value=>{saved=value;});ui.type('\r\n  \n');
 await ui.button('保存设置').props.onClick();assert.equal(saved.allowedRoots.length,0);
});
test('save response wins over a delayed mirror; consecutive saves use the new revision',async()=>{
 const revisions=[];const ui=await editor(async(value,revision)=>{revisions.push(revision);});
 ui.type('C:/first');await ui.button('保存设置').props.onClick();
 assert.equal(ui.field().props.value,'C:/first');assert.equal(ui.button('保存设置').props.disabled,true);
 ui.button('重新读取').props.onClick();assert.equal(ui.field().props.value,'C:/first');
 ui.type('C:/second');await ui.button('保存设置').props.onClick();
 assert.deepEqual(revisions,[7,8]);assert.equal(ui.field().props.value,'C:/second');
 ui.snapshot.value={...ui.snapshot.value,allowedRoots:['C:/first']};ui.snapshot.revision=8;
 assert.equal(ui.field().props.value,'C:/second');
 ui.snapshot.value={...ui.snapshot.value,allowedRoots:['C:/external']};ui.snapshot.revision=10;
 assert.equal(ui.field().props.value,'C:/external');
 ui.snapshot.value={...ui.snapshot.value,allowedRoots:['C:/restarted']};ui.snapshot.revision=0;
 assert.equal(ui.field().props.value,'C:/restarted');
});
test('mirror arriving before save response and external edits preserve revision fencing',async()=>{
 const ui=await editor(async(value,revision)=>{ui.snapshot.value=structuredClone(value);ui.snapshot.revision=revision+1;ui.render();});
 ui.type('C:/saved');await ui.button('保存设置').props.onClick();assert.equal(ui.field().props.value,'C:/saved');
 ui.type('C:/unsaved');ui.snapshot.value={...ui.snapshot.value,allowedRoots:['C:/elsewhere']};ui.snapshot.revision=9;
 assert.equal(ui.field().props.value,'C:/unsaved');assert.ok(ui.find(ui.render(),n=>n.props.role==='alert'));
 ui.button('重新读取').props.onClick();assert.equal(ui.field().props.value,'C:/elsewhere');
});
