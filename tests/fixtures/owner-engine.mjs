import {createOwnerMessageHandler as createHandler} from '../../automation/whatsapp/owner-handler.mjs';
import {createOwnerWorkspaceTools} from '../../automation/whatsapp/owner-workspace-tools.mjs';

// Production handler and production privacy boundary. Only the local OCR seam
// can be replaced; this fixture never constructs or substitutes a provider.
export function createOwnerMessageHandler(options){
  if(!options.localExtraction)return createHandler(options);
  const toolsFactory=options.toolsFactory||createOwnerWorkspaceTools;
  return createHandler({...options,toolsFactory:input=>toolsFactory({...input,
    extractAttachment:options.localExtraction,extractOfflineAttachment:options.localExtraction})});
}
export {standaloneOwnerGreeting,standaloneOwnerMenu,createOwnerWorkspacePlanner} from '../../automation/whatsapp/owner-handler.mjs';
