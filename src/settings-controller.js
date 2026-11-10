import {Remote,TypertRemoteService,RemoteError} from '@deepseek-ai/dsh-typert-protocol';
import {validateRuntimeConfig,validateRuntimePaths} from './runtime-settings.js';
const initializers=[];
export class PaperSettingsController extends TypertRemoteService {
 constructor(ctx){super(ctx,'paperAuditSettings');for(const init of initializers)init.call(this);}
 async save(section,expectedRevision){
  if(this.ctx.invocation?.peer.principal.kind!=='owner')throw new RemoteError('paper-settings/forbidden','Only the host owner can edit settings',{});
  try{
   if(!Number.isInteger(expectedRevision))throw new Error('请先读取最新设置再保存');
   const parsed=validateRuntimeConfig(section);
   await validateRuntimePaths(parsed);
   await this.ctx.settings.mutate('paper-si-audit',Object.entries(parsed).map(([key,value])=>({op:'set',path:[key],value})),expectedRevision);
   const view=this.ctx.settings.describe({redactSecrets:true}).find(v=>v.ns==='paper-si-audit');
   if(!view)throw new Error('配置已写入，但无法读取保存结果，请重新加载设置');
   return {saved:true,view:{ns:view.ns,autoGenerate:view.autoGenerate,schema:view.schema,value:view.value,base:view.base,user:view.user,applies:view.applies,secrets:view.secrets??[],revision:view.revision}};
  }catch(e){throw new RemoteError('paper-settings/rejected',e.message,{});}
 }
}
Remote(PaperSettingsController.prototype.save,{kind:'method',name:'save',addInitializer:f=>initializers.push(f)});
