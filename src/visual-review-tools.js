export function visualRoute(exec) {
  const routed=exec?.agent?.session?.requestHeader?.()?.config;
  return {provider:exec?.modelSelection?.provider??routed?.provider??exec?.agent?.options?.provider,model:exec?.modelSelection?.model??routed?.model??exec?.agent?.options?.model};
}
/** Uses the existing Harness model/tool loop; no hidden provider or API key. */
export async function provideVisualPair(service,args,bridge,exec) {
  const route=visualRoute(exec);
  return service.deliverVisualPair({...args,crops:args.cropsJson?JSON.parse(args.cropsJson):undefined},async images=>{
    const attachments=bridge.ctx?.get?.('attachments'),llm=bridge.ctx?.get?.('llm');
    if(!attachments||!llm||!route.provider||!route.model)return {imageDelivered:false,reason:'Current Harness image route or attachment service is unavailable'};
    const info=await llm.resolveModelInfo(route.provider,route.model,exec?.signal);
    if(!info?.inputModalities?.includes('image'))return {imageDelivered:false,reason:'Current model does not declare image input; select a configured vision model and retry'};
    if(!attachments.imageLimits?.mediaTypes?.includes('image/png'))return {imageDelivered:false,reason:'Host attachment policy does not accept PNG images'};
    const saved=[];
    for(const image of images){exec?.signal?.throwIfAborted();saved.push(await attachments.saveImage({data:image.data,mediaType:'image/png',name:`${image.side}-${image.assetId}-${image.view}.png`}));}
    return {imageDelivered:true,attachments:saved,route,toolCallId:exec?.toolCallId};
  });
}
export const renderVisualPair = (_args,value) => [
  {type:'text',text:JSON.stringify({...value,attachments:undefined})},
  ...(value.imageDelivered?(value.attachments??[]).flatMap((attachment,i)=>[{type:'text',text:`Image ${i?'B':'A'}; coordinates and source hashes in images[${i}].`},{type:'image',attachment}]):[]),
];

export async function provideVisualComparison(service,args,bridge,exec) {
  const {data,...metadata}=await service.readVisualComparison(args),route=visualRoute(exec),attachments=bridge.ctx?.get?.('attachments'),llm=bridge.ctx?.get?.('llm');
  if(!attachments||!llm||!route.provider||!route.model)return {...metadata,imageDelivered:false,reason:'Vision route unavailable'};
  const info=await llm.resolveModelInfo(route.provider,route.model,exec?.signal);
  if(!info?.inputModalities?.includes('image')||!attachments.imageLimits?.mediaTypes?.includes('image/png'))return {...metadata,imageDelivered:false,reason:'Current route cannot receive image comparisons'};
  const attachment=await attachments.saveImage({data,mediaType:'image/png',name:`comparison-${metadata.resultId}-${metadata.region}.png`});
  return {...metadata,imageDelivered:true,attachment};
}
export const renderVisualComparison=(_args,value)=>[{type:'text',text:JSON.stringify({...value,attachment:undefined})},...(value.imageDelivered?[{type:'image',attachment:value.attachment}]:[])];
