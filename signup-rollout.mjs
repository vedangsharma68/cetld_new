// Production publication is refused until the database enforces this contract.
// Preview/local builds never query production and remain independently testable.
export async function assertSignupServerReady({url,key},{fetchImpl=fetch}={}){
 const response=await fetchImpl(new URL('/rest/v1/rpc/signup_invite_status',url),{method:'POST',headers:{apikey:key,'Content-Type':'application/json'},body:'{}',signal:AbortSignal.timeout(5000)});
 const capability=response.ok?await response.json():null;
 if(capability?.version!==2||capability?.privacyRepairRevision!==3||capability?.accountInvites!==true||capability?.tenantInvites!==true||capability?.identityCredentialScrub!==true||capability?.globalPrivacyIndex!==true||capability?.dispatchProtocol!==true)throw Error('Apply and verify all signup and dispatch migrations before publishing this production UI. Existing sign-in must remain available.');
 return capability;
}
