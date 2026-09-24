"use strict";
const fs=require("fs"),path=require("path"),cp=require("child_process"),filter=require("./key-filters");
const ID="org.unknown.home.module",SERVICE=ID+".service",APP="/media/developer/apps/usr/palm/applications/"+ID;
function create(options){
  const io=options&&options.fs||fs,call=options&&options.call||filter.luna,keys=options&&options.keys||filter.create(),command=options&&options.command||((file,args)=>{const result=cp.spawnSync(file,args,{encoding:"utf8",timeout:10000,maxBuffer:128*1024});if(result.error||result.status!==0)throw Error(String(result.stderr||result.error&&result.error.message||"Command failed"));});
  const data=options&&options.data||process.env.UNKNOWN_MODULE_DATA,payload=options&&options.payload||__dirname;
  if(!data||!path.isAbsolute(data))throw Error("Module data directory required");
  const configFile=path.join(data,"home.json"),filterFile=path.join(payload,"home-key-filter.js");
  function config(){try{return JSON.parse(io.readFileSync(configFile,"utf8"));}catch(error){if(error.code==="ENOENT")return {homeButton:false};throw error;}}
  function save(value){const temporary=configFile+"."+process.pid+".tmp";io.writeFileSync(temporary,JSON.stringify(value),{flag:"wx",mode:0o600});io.renameSync(temporary,configFile);}
  function installed(){try{const info=JSON.parse(io.readFileSync(path.join(APP,"appinfo.json"),"utf8"));return info.id===ID&&info.version==="0.5.0";}catch(_){return false;}}
  async function install(){
    if(installed())return;
    if(io.existsSync(path.join(APP,"appinfo.json"))){
      const previous=JSON.parse(io.readFileSync(path.join(APP,"appinfo.json"),"utf8"));
      if(previous.id!==ID||!/^\d+\.\d+\.\d+$/.test(previous.version))throw Error("Existing Home app identity/version does not verify");
      const left=previous.version.split(".").map(Number),right="0.5.0".split(".").map(Number);
      let difference=0;for(let n=0;n<3&&!difference;n++)difference=left[n]-right[n];
      if(difference>=0)throw Error("Refusing to downgrade or replace an unexpected Home version");
    }
    const ipk=path.join(payload,"unknown-home.ipk");if(!io.existsSync(ipk))throw Error("Bundled Home IPK missing");
    if(options&&options.install)await options.install(ipk);else await new Promise((resolve,reject)=>{
      const child=cp.spawn("/usr/bin/luna-send-pub",["-i","-w","30000","luna://com.webos.appInstallService/dev/install",JSON.stringify({id:"unknown.core.home",ipkUrl:ipk,subscribe:true})],{stdio:["ignore","pipe","pipe"]});
      let buffer="",done=false;const timer=setTimeout(()=>finish(Error("Home installation timed out; inspect app inventory before retrying")),30000);
      function finish(error){if(done)return;done=true;clearTimeout(timer);child.kill("SIGKILL");if(error)reject(error);else resolve();}
      child.stdout.on("data",bytes=>{buffer+=bytes.toString();if(buffer.length>65536){finish(Error("Installer output limit"));return;}const lines=buffer.split(/\r?\n/);buffer=lines.pop();for(const line of lines){let result;try{result=JSON.parse(line);}catch(_){continue;}if(result.returnValue===false||result.statusValue===25)finish(Error(result.errorText||result.statusText||"Installation failed"));if(result.statusValue===30)finish();}});
      child.stderr.on("data",()=>{});child.on("error",finish);child.on("close",()=>{if(!done)finish(Error("Installer exited before completion"));});
    });
    if(!installed())throw Error("Installed Home app did not verify");
  }
  function route(enabled){const result=keys.apply("handleUnknownModularHome",filterFile,enabled);save({homeButton:enabled});return result;}
  async function run(action,args){
    args=args||{};if(action!=="setHomeButton"&&Object.keys(args).length)throw Error("Unexpected arguments");
    if(action==="enable"){
      await install();command("/media/developer/apps/usr/palm/services/org.webosbrew.hbchannel.service/elevate-service",[SERVICE,ID]);
      if(config().homeButton)route(true);
    } else if(action==="disable"){
      if(config().homeButton)route(false);
      const windows=call("luna://com.webos.surfacemanager/getForegroundWindowInfo",{}).windows||[];
      if(windows.some(item=>item.appId===ID))call("luna://com.webos.applicationManager/close",{id:ID});
    } else if(action==="reconcile"){
      if(!installed())throw Error("Home app missing; explicit recovery required");if(config().homeButton)route(true);
    } else if(action==="setHomeButton"){
      if(Object.keys(args).length!==1||typeof args.enabled!=="boolean")throw Error("Expected enabled boolean");if(!installed())throw Error("Home app missing");route(args.enabled);
    } else if(action==="openHome")call("luna://com.webos.applicationManager/launch",{id:ID,params:{}});
    else if(!["status","health"].includes(action))throw Error("Unknown action");
    const state=config();let configured=true;if(state.homeButton)configured=keys.read().some(item=>item.handler==="handleUnknownModularHome"&&item.file===filterFile);
    return {returnValue:true,healthy:installed()&&configured,appInstalled:installed(),homeButton:state.homeButton,filterConfigured:configured,physicalKeyVerified:false};
  }
  return {run};
}
if(require.main===module)create().run(process.argv[2],JSON.parse(process.argv[3]||"{}")).then(result=>process.stdout.write(JSON.stringify(result))).catch(error=>{process.stdout.write(JSON.stringify({returnValue:false,errorText:error.message}));process.exitCode=1;});
module.exports={create};
