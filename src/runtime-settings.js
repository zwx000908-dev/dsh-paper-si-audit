import path from 'node:path';
import {access, stat} from 'node:fs/promises';
import {constants} from 'node:fs';
import { Config } from './settings-schema.js';
import { defaultsFromConfig } from './settings.js';
import { AuditService } from './service.js';
const value=x=>typeof x?.get==='function'?x.get():x;
export function readRuntimeConfig(config){return Object.fromEntries(['dataDir','allowedRoots','defaults'].map(k=>[k,value(config[k])]));}
export function validateRuntimeConfig(input){
 if(!input||Array.isArray(input)||Object.keys(input).some(k=>!['dataDir','allowedRoots','defaults'].includes(k)))throw new Error('Unknown plugin configuration field');
 const parsed=readRuntimeConfig(Config(input));
 if(!path.isAbsolute(parsed.dataDir)||parsed.allowedRoots.some(r=>!path.isAbsolute(r)))throw new Error('项目目录和允许读取的目录必须使用绝对路径');
 defaultsFromConfig(parsed.defaults);
 return parsed;
}
/** Validate paths without creating folders or changing the saved configuration. */
export async function validateRuntimePaths({dataDir,allowedRoots}){
 for(const root of allowedRoots){
  try{
   if(!(await stat(root)).isDirectory())throw new Error('不是文件夹');
   await access(root,constants.R_OK);
  }catch(e){throw new Error(`允许读取的论文目录不存在、不可读或不是文件夹：${root}。请在“设置 → 论文核对”中修正。(${e.code??e.message})`);}
 }
 // The output directory may be new. Check its nearest existing ancestor;
 // checking projects also catches a file that would block initialization.
 let ancestor=path.join(dataDir,'projects');
 while(true){
  try{
   if(!(await stat(ancestor)).isDirectory())throw new Error('不是文件夹');
   await access(ancestor,constants.R_OK|constants.W_OK);
   break;
  }catch(e){
   const parent=path.dirname(ancestor);
   if(e.code==='ENOENT'&&parent!==ancestor){ancestor=parent;continue;}
   throw new Error(`项目保存目录不可用：${dataDir}。请在“设置 → 论文核对”中选择可写的文件夹。(${e.code??e.message})`);
  }
 }
}
/** Each operation keeps one instance; later operations observe the latest live fields. */
export function createRuntimeService(config){
 let cache,key;
 const resolve=()=>{const input=readRuntimeConfig(config),signature=JSON.stringify(input);if(signature!==key){const parsed=validateRuntimeConfig(input);cache=new AuditService({...parsed,defaults:defaultsFromConfig(parsed.defaults),executionPath:'harness_native_tools'});key=signature;}return cache;};
 // Settings must remain available even when a saved directory has disappeared.
 // Resolve and initialize only when a tool actually uses the audit service.
 return new Proxy({}, {get(_target,prop){if(prop==='then')return undefined;return async(...args)=>{const service=resolve();await validateRuntimePaths(service);await service.init();return prop==='init'?service:service[prop](...args);};}});
}
