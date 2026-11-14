let sequence=0;
// High-level scripted replies shared by the native engine contract fixtures.
export function cloudflarePartsResponse(parts){
  const tool_calls=parts.filter(part=>part.functionCall).map(({functionCall:call})=>({
    id:call.id||`fixture-call-${++sequence}`,type:'function',
    function:{name:call.name,arguments:JSON.stringify(call.args||{})},
  }));
  return Response.json({choices:[{message:{content:parts.filter(part=>!part.thought&&typeof part.text==='string').map(part=>part.text).join('\n'),
    ...(tool_calls.length?{tool_calls}:{})},finish_reason:tool_calls.length?'tool_calls':'stop'}]});
}
export const cloudflareToolResults=body=>(body.messages||[]).filter(turn=>turn.role==='tool').map(turn=>JSON.parse(turn.content));
