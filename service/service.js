"use strict";

const fs = require("fs");
const launcher = require("./launcher");

const service = launcher.service;
const APP_ID = launcher.APP_ID;
const CORE="/media/developer/apps/usr/palm/services/org.unknown.core.service/";
let updateChecker;
async function updateSources(){return require(CORE+"update-sources").known(require(CORE+"module-store").createStore());}

function input(message, fields) {
  const value = launcher.payloadObject(message);
  if (Object.keys(value).some(key => !fields.includes(key))) throw Error("Unexpected request parameters");
  return value;
}
function register(name, root, handler) {
  service.register(name, async message => {
    try {
      if (!message || message.sender !== APP_ID) throw Error("Only the Unknown Home app may call this service");
      if (!moduleActive()) throw Error("Home module disabled; open Unknown Core");
      if (root && !launcher.elevated()) throw Error("Owner-controlled root elevation is required");
      message.respond(Object.assign({returnValue:true}, await handler(message)));
    } catch (error) {
      message.respond({returnValue:false,errorText:String(error.message || error)});
    }
  });
}

register("bootstrap", false, async message => {
  input(message, []);
  const apps = launcher.scanApps(), icons = launcher.cacheAppIcons(apps), cards=moduleCards(), config = launcher.loadConfig(apps.concat(cards));
  const results = await Promise.all([launcher.getInputs(), launcher.getRecentIds(apps)]);
  return { serviceVersion:"0.5.0", elevated:launcher.elevated(), apps:launcher.publicApps(apps,icons).concat(cards), inputs:results[0], recentIds:results[1], favorites:config.favorites, preferences:config.preferences };
});
register("moduleCatalog",false,message=>{input(message,[]);return {apps:moduleCards()};});
register("appCatalog",false,message=>{input(message,[]);const apps=launcher.scanApps();return {apps:launcher.publicApps(apps,launcher.cacheAppIcons(apps)).concat(moduleCards())};});
register("updateSources",false,async message=>{input(message,[]);const installed=new Set(launcher.scanApps().map(app=>app.id));return {sources:(await updateSources()).filter(item=>installed.has(item.id))};});
register("checkAppUpdate",false,async message=>{
  const value=input(message,["id"]),entry=(await updateSources()).find(item=>item.id===value.id);
  if(!entry||!launcher.scanApps().some(app=>app.id===entry.id))throw Error("Installed app with a known GitHub source required");
  if(!updateChecker)updateChecker=require(CORE+"app-updates").create();
  const release=await updateChecker.release(entry.repository,entry.id);
  return {update:release.applications[0]};
});
register("openAppUpdate",false,async message=>{
  const value=input(message,["id"]),entry=(await updateSources()).find(item=>item.id===value.id);
  if(!entry||!launcher.scanApps().some(app=>app.id===entry.id))throw Error("Installed app with a known GitHub source required");
  return {launch:await launcher.serviceCall("luna://com.webos.applicationManager/launch",{id:"org.unknown.core",params:{coreView:"ipkUpdate",appId:entry.id}})};
});
function moduleCards(){
  const store=require("/media/developer/apps/usr/palm/services/org.unknown.core.service/module-store").createStore();
  return store.list().filter(row=>row.id!=="home").map(row=>({id:"unknown-module:"+row.id,moduleId:row.id,title:row.manifest?row.manifest.title:row.id,source:"module",type:"module",removable:false,description:(row.quarantined?"Quarantined":row.enabled?"Enabled":"Disabled")+" | "+(row.manifest?row.manifest.description:"Recovery required"),version:row.manifest?row.manifest.version:"",fallbackIcon:"assets/icons/settings.svg"}));
}
register("getAsset", false, message => {
  const payload = input(message, ["id","kind"]);
  const app = launcher.scanApps().find(row => row.id === payload.id);
  if (!app) return {dataUri:""};
  const file = launcher.resolveAsset(app, payload.kind === "preview" ? "preview" : "icon");
  return {dataUri:file ? "data:" + launcher.mimeType(file) + ";base64," + fs.readFileSync(file).toString("base64") : ""};
});
register("launch", false, async message => {
  const payload = input(message, ["id"]);
  const module=moduleCards().find(row=>row.id===payload.id);
  if(module)return {launch:await launcher.serviceCall("luna://com.webos.applicationManager/launch",{id:"org.unknown.core",params:{moduleId:module.moduleId}})};
  const allowed = new Set(launcher.scanApps().map(app => app.id));
  ["com.palm.app.settings","com.webos.app.home","com.webos.app.livetv","com.webos.app.hdmi1","com.webos.app.hdmi2","com.webos.app.hdmi3","com.webos.app.hdmi4"].forEach(id => allowed.add(id));
  if (!allowed.has(payload.id)) throw Error("App is not in the launch catalog");
  return {launch:await launcher.serviceCall("luna://com.webos.applicationManager/launch", {id:payload.id,params:{}})};
});
register("uninstall", true, async message => {
  const payload = input(message, ["id"]);
  const app = launcher.scanApps().find(row => row.id === payload.id);
  if (!app || app.source === "system" || launcher.PROTECTED_APP_IDS.has(app.id)) throw Error("App is missing or protected");
  const result = await launcher.removeInstalledApp(app);
  return {id:app.id,statusValue:result.statusValue,statusText:result.statusText || "Removed"};
});
register("savePreferences", false, message => {
  const payload = input(message,["favorites","preferences"]);
  const result=launcher.saveConfig(payload,launcher.scanApps().concat(moduleCards()));
  return {favorites:result.favorites,preferences:result.preferences};
});








function moduleActive(){
  try{
    const state=JSON.parse(fs.readFileSync("/var/lib/unknown-core/installed/home/state.json","utf8"));
    let safe={active:false};
    try{safe=JSON.parse(fs.readFileSync("/var/lib/unknown-core/safe-mode.json","utf8"));}
    catch(error){if(error.code!=="ENOENT")return false;}
    return !!state&&!!safe&&typeof safe.active==="boolean"&&state.enabled===true&&!state.quarantined&&!state.restorePending&&!state.lastError&&!safe.active;
  }catch(_){return false;}
}
