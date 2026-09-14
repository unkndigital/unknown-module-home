"use strict";
var lastLaunch=0;
function init(){lastLaunch=0;}
function handleUnknownModularHome(key,pressed,repeat,deviceId){
  if(key!==Qt.Key_Super_L&&key!==Qt.Key_Meta)return KeyPolicy.NextPolicy;
  if(!pressed||repeat)return KeyPolicy.Accepted;
  if(Date.now()-lastLaunch<400)return KeyPolicy.Accepted;
  lastLaunch=Date.now();
  try{applicationManager.launch("org.unknown.home.module",JSON.stringify({source:"physical-home"}));return KeyPolicy.Accepted;}
  catch(error){lastLaunch=0;return KeyPolicy.NextPolicy;}
}
