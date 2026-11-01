import {AIProvider} from '../../ai/provider.mjs';
import {runOwnerAgent} from '../../automation/whatsapp/owner-agent.mjs';
import {createOwnerMessageHandler as createHandler,createOwnerWorkspacePlanner} from '../../automation/whatsapp/owner-handler.mjs';
import {createOwnerWorkspaceTools} from '../../automation/whatsapp/owner-workspace-tools.mjs';

// Exercise malformed planner output and the complete guarded engine independently
// of production's earlier deterministic invoice router. The production provider
// boundary is exercised without this fixture in private-invoice-chat.test.mjs.
// All transports supplied by these engine tests are local mocks.
export function createOwnerMessageHandler(options){
  const factory=options.providerFactory||(config=>new AIProvider(config));
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
