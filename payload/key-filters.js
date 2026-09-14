"use strict";
const fs=require("fs"),cp=require("child_process");
const NAME="com.webos.surfacemanager.keyFilters";
function luna(uri,payload){const result=cp.spawnSync("/usr/bin/luna-send",["-n","1","-f",uri,JSON.stringify(payload)],{encoding:"utf8",timeout:10000,maxBuffer:256*1024});if(result.error)throw result.error;if(result.status!==0)throw Error(String(result.stderr||"Local API failed"));const reply=JSON.parse(result.stdout);if(reply.returnValue!==true)throw Error(reply.errorText||"Local API rejected the request");return reply;}
function create(options){
  const call=options&&options.call||luna;
  function read(){const reply=call("luna://com.webos.service.config/getConfigs",{configNames:[NAME]}),filters=reply.configs&&reply.configs[NAME];
    if(!Array.isArray(filters)||!filters.length||filters.length>64||filters.some(item=>!item||typeof item.handler!=="string"||typeof item.file!=="string"))throw Error("Unsupported key-filter configuration");return filters;}
  function set(filters){const configs={};configs[NAME]=filters;call("luna://com.webos.service.config/setConfigs",{configs,volatile:true});}
  function apply(handler,file,enabled){
    if(!/^handleUnknown[A-Za-z]+$/.test(handler)||typeof file!=="string"||file[0]!=="/")throw Error("Invalid owned filter identity");
    const current=read();
    if(current.some(item=>item.handler===handler&&item.file!==file))throw Error("Filter identity conflict; refusing to replace another integration");
    const base=current.filter(item=>!(item.handler===handler&&item.file===file));
    const stock=base.findIndex(item=>item.handler==="handleSystemKeys");if(stock<0)throw Error("Stock key handler is missing; no changes made");
    // Recovery needs the original colored-key events before webOS converts holds.
    const longPress=base.findIndex(item=>item.handler==="handleLongPressKeys");
    const position=handler==="handleUnknownCoreRecovery"&&longPress>=0?longPress:stock;
    const desired=base.slice();if(enabled)desired.splice(position,0,{handler,file});
    try{
      if(enabled||JSON.stringify(current)!==JSON.stringify(desired))set(desired);
      if(JSON.stringify(read())!==JSON.stringify(desired))throw Error("Key-filter readback mismatch");
    }catch(error){
      let rollback="restored";try{set(current);if(JSON.stringify(read())!==JSON.stringify(current))rollback="not verified";}catch(_){rollback="failed";}
      throw Error("Key-filter verification failed: "+error.message+"; rollback "+rollback);
    }
    return {enabled,configurationVerified:true,physicalKeyVerified:false,volatile:true};
  }
  return {read,apply};
}
module.exports={create,luna};
