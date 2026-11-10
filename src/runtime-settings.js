import path from 'node:path';
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
/** Each operation keeps one instance; later operations observe the latest live fields. */
export function createRuntimeService(config){
 let cache,key;
 const resolve=()=>{const input=readRuntimeConfig(config),signature=JSON.stringify(input);if(signature!==key){const parsed=validateRuntimeConfig(input);cache=new AuditService({...parsed,defaults:defaultsFromConfig(parsed.defaults),executionPath:'harness_native_tools'});key=signature;}return cache;};
 resolve();
 return new Proxy({}, {get(_target,prop){if(prop==='then')return undefined;return async(...args)=>{const service=resolve();await service.init();return service[prop](...args);};}});
}
