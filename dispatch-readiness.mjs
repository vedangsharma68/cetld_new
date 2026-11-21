// One contract for production publication and inbound worker startup.
export function hasDispatchReadiness(value){
 return value?.version===1&&value?.queueRevision===2&&value?.ready===true
  &&value?.legacyAcknowledgmentsReconciled===true&&value?.retirementProgress===true;
}
