// Pure wire translation: no credentials, persistence, or tool execution.
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const nativeKeys=['googleParts','googleBatchCoalesced','zenResponsesOutput','zenResponsesModel','zenResponsesBatchCoalesced','zenChatReasoningContent','zenChatModel','zenChatToolCalls','zenChatBatchCoalesced','reasoning_content'];
export function stripNativeProviderMetadata(message){
  const copy={...message};for(const key of nativeKeys)delete copy[key];return copy;
}

export function zenChatMessages(model,messages,{invalidArgument=()=>new Error('Invalid Zen chat input')}={}){
  const output=[],results=new Map();
  for(const message of messages){
    const ordinary=stripNativeProviderMetadata(message);
    if(message.role==='assistant'&&message.zenChatModel===model&&Array.isArray(message.zenChatToolCalls)){
      ordinary.tool_calls=structuredClone(message.zenChatToolCalls);
      if(typeof message.zenChatReasoningContent==='string')ordinary.reasoning_content=message.zenChatReasoningContent;
      for(const call of ordinary.tool_calls){
        const executed=message.tool_calls?.find(item=>item.id===call.id);
        const coalesced=message.zenChatBatchCoalesced===true&&message.tool_calls?.length===1;
        const resultCall=executed||message.tool_calls?.[0];
        if(!resultCall?.id)throw invalidArgument();
        const list=results.get(resultCall.id)||[];list.push({id:call.id,executed:Boolean(executed)||coalesced});results.set(resultCall.id,list);
      }
    }
    if(message.role==='tool'&&results.has(message.tool_call_id)){
      for(const match of results.get(message.tool_call_id))output.push({...ordinary,tool_call_id:match.id,
        content:match.executed?ordinary.content:JSON.stringify({ok:false,code:'NOT_EXECUTED',message:'This requested call did not execute. Use only the actual operation result as evidence.'})});
      results.delete(message.tool_call_id);
    }else output.push(ordinary);
  }
  return output;
}

export function zenResponsesRequest(model,messages,options={}, {invalidArgument=()=>new Error('Invalid Responses input')}={}){
  const fail=()=>{throw invalidArgument();};
  const input=[],results=new Map(),seenIds=new Set();let sequence=0;
  const callId=id=>{
    if(typeof id!=='string'||!id.length)fail();
    let value=id.length<=64?id:'history-call-'+(++sequence);
    while(seenIds.has(value))value='history-call-'+(++sequence);
    seenIds.add(value);return value;
  };
  const register=(id,entry)=>{const list=results.get(id)||[];list.push(entry);results.set(id,list);};
  const messageItem=message=>{
    if(!['system','developer','user','assistant'].includes(message.role))fail();
    const textType=message.role==='assistant'?'output_text':'input_text';
    const content=typeof message.content==='string'?[{type:textType,text:message.content}]
      :Array.isArray(message.content)?message.content.map(part=>{
        if(part?.type==='text'&&typeof part.text==='string')return {type:textType,text:part.text};
        if(message.role!=='user')fail();
        if(part?.type==='image_url'&&typeof part.image_url?.url==='string'){
          const url=part.image_url.url;
          if(!/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(url)&&!/^https:\/\//.test(url))fail();
          return {type:'input_image',image_url:url,...(part.image_url.detail?{detail:part.image_url.detail}:{})};
        }
        if(part?.type==='file'&&typeof part.file?.file_data==='string'
          &&/^data:application\/pdf;base64,[A-Za-z0-9+/]+={0,2}$/.test(part.file.file_data))
          return {type:'input_file',file_data:part.file.file_data,...(typeof part.file.filename==='string'?{filename:part.file.filename}:{})};
        fail();
      }):fail();
    return {type:'message',role:message.role,content};
  };
  for(const message of messages){
    if(!object(message))fail();
    if(message.role==='tool'){
      const matches=results.get(message.tool_call_id);if(!matches?.length||typeof message.content!=='string')fail();
      for(const match of matches)input.push({type:'function_call_output',call_id:match.callId,output:match.executed?message.content:
        JSON.stringify({ok:false,code:'NOT_EXECUTED',message:'This requested call did not execute. Use only the actual operation result as evidence.'})});
      results.delete(message.tool_call_id);continue;
    }
    const calls=Array.isArray(message.tool_calls)?message.tool_calls:[];
    const native=message.role==='assistant'&&message.zenResponsesModel===model&&Array.isArray(message.zenResponsesOutput)
      ?message.zenResponsesOutput:null;
    if(native){
      for(const item of native){
        if(!object(item))fail();
        if(item.type==='reasoning'){
          // Bare server-side IDs are unusable with store:false. Never expose or
          // synthesize reasoning; retain only the original encrypted replay.
          if(typeof item.encrypted_content==='string'&&item.encrypted_content.length)
            input.push({...structuredClone(item),summary:Array.isArray(item.summary)?structuredClone(item.summary):[]});
        }else if(item.type==='message')input.push(structuredClone(item));
        else if(item.type==='function_call'){
          if(typeof item.call_id!=='string'||!item.call_id.length||item.call_id.length>64||seenIds.has(item.call_id))fail();
          seenIds.add(item.call_id);input.push(structuredClone(item));
          const call=calls.find(call=>call?.id===item.call_id);
          const coalesced=message.zenResponsesBatchCoalesced===true&&calls.length===1;
          const resultCall=call||calls[0];
          if(!resultCall?.id)fail();
          register(resultCall.id,{callId:item.call_id,executed:Boolean(call)||coalesced});
        }else fail();
      }
      continue;
    }
    const item=messageItem(message);
    if(item.content.some(part=>part.text||part.type!=='input_text'&&part.type!=='output_text')){
      if(calls.length)item.phase='commentary';input.push(item);
    }
    for(const call of calls){
      if(message.role!=='assistant'||typeof call?.function?.name!=='string'||typeof call.function.arguments!=='string')fail();
      const id=callId(call.id);
      input.push({type:'function_call',call_id:id,name:call.function.name,arguments:call.function.arguments});
      register(call.id,{callId:id,executed:true});
    }
  }
  // A transcript may end in an unanswered call only while awaiting execution;
  // such a checkpoint must execute its pending calls before asking the model.
  if(results.size)fail();
  const {max_tokens,response_format,tools,tool_choice,...rest}=options;
  const body={...rest,model,input,stream:false,store:false,include:['reasoning.encrypted_content']};
  delete body.previous_response_id;delete body.conversation;delete body.messages;
  if(max_tokens!==undefined)body.max_output_tokens=max_tokens;
  if(response_format?.type==='json_schema')body.text={format:{type:'json_schema',...response_format.json_schema}};
  else if(response_format?.type==='json_object')body.text={format:{type:'json_object'}};
  else if(response_format!==undefined)fail();
  if(Array.isArray(tools)&&tools.length&&tool_choice!=='none'){
    body.tools=tools.map(tool=>{if(tool?.type!=='function'||!object(tool.function))fail();return {type:'function',...tool.function};});
    // Meta supports only auto; callers still validate that required planning
    // produced an allowed call before executing anything.
    body.tool_choice='auto';
  }
  return body;
}

export function zenResponsesResult(body,model,usedFallback,{invalidResponse=()=>new Error('Invalid Responses output')}={}){
  const fail=()=>{throw invalidResponse();};
  if(!Array.isArray(body?.output)||!['completed','incomplete'].includes(body.status))fail();
  const toolCalls=[],text=[];
  for(const item of body.output){
    if(!object(item))fail();
    if(item.type==='function_call'){
      if(body.status!=='completed'||item.status==='in_progress'||typeof item.call_id!=='string'||!item.call_id.length||item.call_id.length>64
        ||typeof item.name!=='string'||!item.name.length||typeof item.arguments!=='string'||toolCalls.some(call=>call.id===item.call_id))fail();
      toolCalls.push({id:item.call_id,type:'function',function:{name:item.name,arguments:item.arguments}});
    }else if(item.type==='message'&&item.role==='assistant'&&item.phase!=='commentary'){
      if(!Array.isArray(item.content))fail();
      for(const part of item.content)if(part?.type==='output_text'&&typeof part.text==='string')text.push(part.text);
    }else if(item.type!=='reasoning'&&item.type!=='message')fail();
  }
  const content=text.join('');if(!content&&!toolCalls.length)fail();
  // Every incomplete response must remain distinguishable from a completed
  // answer, even if the upstream supplies an unfamiliar incomplete reason.
  const finishReason=body.status==='incomplete'?'max_output_tokens':toolCalls.length?'tool_calls':'stop';
  return {content,finishReason,toolCalls,model,usedFallback,
    ...(toolCalls.length?{zenResponsesOutput:structuredClone(body.output),zenResponsesModel:model}:{})};
}
