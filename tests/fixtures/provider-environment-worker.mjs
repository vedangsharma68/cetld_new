// A fresh module graph and an isolated environment, without subprocess eval.
import {parentPort} from 'node:worker_threads';
import {VERIFIED_MODEL_CATALOG,isModelId,sanitizeModelSettings,DEFAULT_MODEL,AIProvider} from '../../ai/provider.mjs';
const provider=new AIProvider({fallbackModel:null,fetchImpl:()=>{throw Error('No retired request');}});
let code;
try{await provider.generate({messages:[{role:'user',content:'Hi'}]});}catch(error){code=error.code;}
parentPort.postMessage({allowed:isModelId(DEFAULT_MODEL),retiredCatalog:VERIFIED_MODEL_CATALOG.some(item=>item.id===DEFAULT_MODEL),settings:sanitizeModelSettings({primaryModel:DEFAULT_MODEL}),code});
