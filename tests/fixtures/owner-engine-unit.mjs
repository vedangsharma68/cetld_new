import {AIProvider} from '../../ai/provider.mjs';
import {runOwnerAgent} from '../../automation/whatsapp/owner-agent.mjs';
import {createOwnerMessageHandler as createHandler,createOwnerWorkspacePlanner} from '../../automation/whatsapp/owner-handler.mjs';
import {createOwnerWorkspaceTools} from '../../automation/whatsapp/owner-workspace-tools.mjs';

// Explicit subsystem harness for adversarial planner/tool-state unit tests.
// This is NOT a production conversation fixture. It requires local transport
// mocks; production routing and privacy are exercised by owner-engine.mjs, the
// fast production battery and private-production-containment.test.mjs.
export function createOwnerEngineHarness(options){
  const factory=options.providerFactory||(config=>{
    if(!options.fetchImpl||options.fetchImpl===globalThis.fetch)throw new Error('Engine unit harness requires an explicit local transport mock');
    return new AIProvider(config);
  });
  const toolsFactory=options.toolsFactory||createOwnerWorkspaceTools;
  let provider;
  const makeProvider=config=>factory({...config,fetchImpl:options.fetchImpl,
    cfAccountId:options.env?.CLOUDFLARE_ACCOUNT_ID,cfApiToken:options.env?.CLOUDFLARE_API_TOKEN,
    zenApiKey:options.env?.OPENCODE_ZEN_API_KEY,healthStore:options.healthStore});
  return createHandler({...options,
    toolsFactory:input=>{
      let active;
      provider={
        generate:request=>(active||=(makeProvider(input.config))).generate(request),
        generateStructured:request=>(active||=(makeProvider(input.config))).generateStructured(request),
      };
      return toolsFactory({...input,...(options.localExtraction?{extractAttachment:options.localExtraction,extractOfflineAttachment:options.localExtraction}:{}),planRequest:createOwnerWorkspacePlanner({provider,message:input.message,
        history:input.ownerHistory,timezone:input.timezone,clock:input.clock,signal:input.signal,deadlineAt:input.deadlineAt})});
    },
    agentFactory:options.agentFactory||(input=>runOwnerAgent({...input,provider:provider||makeProvider(input.config)})),
  });
}

export {standaloneOwnerGreeting,standaloneOwnerMenu,createOwnerWorkspacePlanner} from '../../automation/whatsapp/owner-handler.mjs';
