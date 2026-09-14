"use strict";

const fs = require("fs");

const crypto = require("crypto");

const os = require("os");

const path = require("path");

const childProcess = require("child_process");

const Service = require("webos-service");

const service = new Service("org.unknown.home.module.service");

const APP_ID = "org.unknown.home.module";

const SERVICE_DIR = __dirname;

const APP_DIR = path.join("/media/developer/apps/usr/palm/applications", APP_ID);

const APP_ASSET_CACHE_DIR = path.join(APP_DIR, ".unknown-cache");

const DATA_DIR = "/media/internal/.unknown-home-module";

const CONFIG_FILE = path.join(DATA_DIR, "config.json");

const APP_ROOTS = [
  "/usr/palm/applications",
  "/media/cryptofs/apps/usr/palm/applications",
  "/media/developer/apps/usr/palm/applications"
];

const SAFE_ASSET_ROOTS = APP_ROOTS.concat(["/tmp/snapshots"]);

const MAX_ASSET_BYTES = 3 * 1024 * 1024;

const DEFAULT_FAVORITES = [
  "youtube.leanback.v4",
  "org.xbmc.kodi",
  "netflix",
  "com.apple.appletv",
  "amazon",
  "org.webosbrew.hbchannel"
];

const PROTECTED_APP_IDS = new Set([
  APP_ID,
  "org.unknown.core",
  "org.unknown.home",
  "org.webosbrew.hbchannel"
]);

function payloadObject(message) {
  let payload = message && message.payload ? message.payload : {};
  if (typeof payload === "string") {
    try {
      payload = JSON.parse(payload);
    } catch (error) {
      payload = {};
    }
  }
  if (payload && typeof payload.payload === "string") {
    try {
      payload = JSON.parse(payload.payload);
    } catch (error) {
      payload = {};
    }
  } else if (payload && payload.payload && typeof payload.payload === "object") {
    payload = payload.payload;
  }
  return payload && typeof payload === "object" ? payload : {};
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    return fallback;
  }
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o755 });
  const temporary = file + "." + process.pid + ".tmp";
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(temporary, file);
  try {
    fs.chmodSync(file, 0o600);
  } catch (error) {
    // The data remains usable if chmod is restricted by a jail.
  }
}

function elevated() {
  return typeof process.getuid === "function" && process.getuid() === 0;
}

function appSource(folder) {
  if (folder.indexOf("/media/developer/") === 0) {
    return "homebrew";
  }
  if (folder.indexOf("/usr/palm/") === 0) {
    return "system";
  }
  return "store";
}

function scanApps() {
  const byId = new Map();
  APP_ROOTS.forEach((root) => {
    let entries = [];
    try {
      entries = fs.readdirSync(root);
    } catch (error) {
      return;
    }
    entries.forEach((entry) => {
      const folderPath = path.join(root, entry);
      const appInfoPath = path.join(folderPath, "appinfo.json");
      const info = readJson(appInfoPath, null);
      if (!info || !info.id || !info.title || !info.icon) {
        return;
      }
      const hidden = info.visible === false || info.noDisplay === true ||
        (info.class && info.class.hidden === true);
      if (hidden || info.id === APP_ID) {
        return;
      }
      byId.set(info.id, {
        id: String(info.id),
        title: String(info.title),
        source: appSource(folderPath),
        type: String(info.type || "web"),
        description: String(info.appDescription || info.description || info.vendor || ""),
        version: String(info.version || ""),
        isStub: info.type === "stub",
        folderPath: folderPath,
        info: info
      });
    });
  });

  return Array.from(byId.values()).sort((left, right) => {
    return left.title.localeCompare(right.title);
  });
}

function publicApps(apps, iconUrls) {
  return apps.map((app) => ({
    id: app.id,
    title: app.title,
    source: app.source,
    moduleId: app.id === "org.unknown.core" ? "core" : /^[a-z0-9][a-z0-9-]{0,63}$/.test(String(app.info.unknownCoreModule || "")) ? app.info.unknownCoreModule : "",
    type: app.type,
    description: app.description,
    version: app.version,
    isStub: app.isStub,
    removable: app.source !== "system" && !PROTECTED_APP_IDS.has(app.id),
    fallbackIcon: iconUrls.get(app.id) || ""
  }));
}

function loadConfig(apps) {
  const raw = readJson(CONFIG_FILE, {});
  const available = new Set(apps.map((app) => app.id));
  let favorites = Array.isArray(raw.favorites)
    ? raw.favorites.map(String).filter((id, index, all) => available.has(id) && all.indexOf(id) === index)
    : [];
  if (!favorites.length) {
    favorites = DEFAULT_FAVORITES.filter((id) => available.has(id));
  }
  const preferences = raw.preferences && typeof raw.preferences === "object" ? raw.preferences : {};
  return {
    favorites: favorites.slice(0, 30),
    preferences: {
      density: preferences.density === "compact" ? "compact" : "comfortable",
      showStubs: preferences.showStubs !== false
    }
  };
}

function saveConfig(payload, apps) {
  const available = new Set(apps.map((app) => app.id));
  const favorites = Array.isArray(payload.favorites)
    ? payload.favorites.map(String).filter((id, index, all) => available.has(id) && all.indexOf(id) === index).slice(0, 30)
    : [];
  const inputPreferences = payload.preferences && typeof payload.preferences === "object"
    ? payload.preferences
    : {};
  const config = {
    favorites: favorites,
    preferences: {
      density: inputPreferences.density === "compact" ? "compact" : "comfortable",
      showStubs: inputPreferences.showStubs !== false
    },
    updatedAt: new Date().toISOString()
  };
  writeJsonAtomic(CONFIG_FILE, config);
  return config;
}

function serviceCall(uri, payload) {
  return new Promise((resolve, reject) => {
    try {
      service.call(uri, payload || {}, (message) => {
        const response = message && message.payload ? message.payload : {};
        if (response && response.returnValue === false) {
          reject(new Error(response.errorText || response.errorMessage || "Service call failed"));
          return;
        }
        resolve(response || {});
      });
    } catch (error) {
      reject(error);
    }
  });
}

function removeInstalledApp(app) {
  const uri = app.source === "homebrew"
    ? "luna://com.webos.appInstallService/dev/remove"
    : "luna://com.webos.appInstallService/remove";
  return new Promise((resolve, reject) => {
    let finished = false;
    let stdout = "";
    let stderr = "";
    let child = null;
    const timer = setTimeout(() => {
      if (!finished) {
        settle(new Error("App removal timed out"));
      }
    }, 90000);

    function settle(error, response) {
      if (finished) {
        return;
      }
      finished = true;
      clearTimeout(timer);
      if (child && !child.killed) {
        child.kill("SIGTERM");
      }
      if (error) {
        reject(error);
      } else {
        resolve(response || {});
      }
    }

    try {
      child = childProcess.spawn("/usr/bin/luna-send-pub", [
        "-w",
        "90000",
        "-i",
        uri,
        JSON.stringify({ id: app.id, subscribe: true })
      ], {
        stdio: ["ignore", "pipe", "pipe"]
      });
      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
        const lines = stdout.split(/\r?\n/);
        stdout = lines.pop() || "";
        lines.forEach((line) => {
          if (!line.trim() || finished) {
            return;
          }
          let response = {};
          try {
            response = JSON.parse(line);
          } catch (error) {
            return;
          }
          if (response.returnValue === false) {
            settle(new Error(response.errorText || response.errorMessage || "App removal failed"));
            return;
          }
          const statusValue = Number(response.statusValue);
          if (statusValue === 31) {
            settle(null, response);
          } else if (statusValue === 25) {
            settle(new Error(response.statusText || response.errorText || "App removal failed"));
          }
        });
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
        if (stderr.length > 8192) {
          stderr = stderr.slice(-8192);
        }
      });
      child.on("error", (error) => {
        settle(error);
      });
      child.on("close", (code) => {
        if (!finished) {
          settle(new Error(stderr.trim() || "App removal exited with code " + code));
        }
      });
    } catch (error) {
      settle(error);
    }
  });
}

function getInputs() {
  return serviceCall("luna://com.webos.service.eim/getAllInputStatus", { subscribe: false })
    .then((result) => {
      return (result.devices || []).map((device) => ({
        id: String(device.id || ""),
        appId: String(device.appId || ""),
        label: String(device.label || device.id || "Input"),
        connected: device.connected === true || device.hdmiPlugIn === true,
        active: device.activate === true || device.active === true,
        port: Number(device.port || 0),
        deviceName: String(device.spdProductDescription || device.spdVendorName || "")
      }));
    })
    .catch(() => []);
}

function snapshotCandidates() {
  const candidates = [];
  let deviceFolders = [];
  try {
    deviceFolders = fs.readdirSync("/tmp/snapshots");
  } catch (error) {
    return candidates;
  }
  deviceFolders.forEach((folder) => {
    const root = path.join("/tmp/snapshots", folder);
    let files = [];
    try {
      files = fs.readdirSync(root);
    } catch (error) {
      return;
    }
    files.forEach((name) => {
      const file = path.join(root, name);
      try {
        const stat = fs.statSync(file);
        if (stat.isFile()) {
          candidates.push({ file: file, name: name, mtime: stat.mtimeMs });
        }
      } catch (error) {
        return;
      }
    });
  });
  return candidates.sort((left, right) => right.mtime - left.mtime);
}

function getRecentIds(apps) {
  const known = new Set(apps.map((app) => app.id));
  return serviceCall("luna://com.webos.surfacemanager/getRecentsAppList", {})
    .then((result) => {
      const values = Array.isArray(result.recentsAppList) ? result.recentsAppList : [];
      return values.map((entry) => {
        return typeof entry === "string" ? entry : String(entry.appId || entry.id || "");
      }).filter((id, index, all) => known.has(id) && all.indexOf(id) === index).slice(0, 12);
    })
    .catch(() => {
      const snapshots = snapshotCandidates();
      const ids = [];
      snapshots.forEach((snapshot) => {
        const match = apps.find((app) => snapshot.name.indexOf(app.id + "_") === 0);
        if (match && ids.indexOf(match.id) < 0) {
          ids.push(match.id);
        }
      });
      return ids.slice(0, 12);
    });
}

function isInside(file, roots) {
  let resolved;
  try {
    resolved = fs.realpathSync(file);
  } catch (error) {
    return false;
  }
  return roots.some((root) => {
    let resolvedRoot;
    try {
      resolvedRoot = fs.realpathSync(root);
    } catch (error) {
      return false;
    }
    return resolved === resolvedRoot || resolved.indexOf(resolvedRoot + path.sep) === 0;
  });
}

function relativeAsset(app, value) {
  if (!value || typeof value !== "string") {
    return "";
  }
  const candidate = path.isAbsolute(value) ? value : path.resolve(app.folderPath, value);
  if (!isInside(candidate, SAFE_ASSET_ROOTS)) {
    return "";
  }
  try {
    const stat = fs.statSync(candidate);
    return stat.isFile() && stat.size <= MAX_ASSET_BYTES ? candidate : "";
  } catch (error) {
    return "";
  }
}

function latestSnapshot(app) {
  const candidates = snapshotCandidates();
  const match = candidates.find((candidate) => candidate.name.indexOf(app.id + "_") === 0);
  return match ? match.file : "";
}

function resolveAsset(app, kind) {
  const info = app.info || {};
  if (kind === "icon") {
    return relativeAsset(app, info.largeIcon || info.mediumIcon || info.icon);
  }
  const snapshot = latestSnapshot(app);
  if (snapshot) {
    return snapshot;
  }
  return relativeAsset(app, info.customImageFilePath || info.splashBackground || info.largeIcon || info.icon);
}

function cacheAppIcons(apps) {
  const urls = new Map();
  if (!elevated() || !fs.existsSync(APP_DIR)) {
    return urls;
  }

  try {
    fs.mkdirSync(APP_ASSET_CACHE_DIR, { recursive: true, mode: 0o755 });
  } catch (error) {
    return urls;
  }

  const retained = new Set();
  apps.forEach((app) => {
    try {
      const source = resolveAsset(app, "icon");
      if (!source) {
        return;
      }
      const stat = fs.statSync(source);
      const sourceExtension = path.extname(source).toLowerCase();
      const extension = [".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg"].indexOf(sourceExtension) >= 0
        ? sourceExtension
        : ".png";
      const fingerprint = crypto.createHash("sha256")
        .update(app.id + "\0" + source + "\0" + stat.size + "\0" + Math.floor(stat.mtimeMs))
        .digest("hex")
        .slice(0, 24);
      const name = fingerprint + extension;
      const destination = path.join(APP_ASSET_CACHE_DIR, name);
      retained.add(name);
      if (!fs.existsSync(destination)) {
        const temporary = destination + "." + process.pid + ".tmp";
        fs.copyFileSync(source, temporary);
        fs.chmodSync(temporary, 0o644);
        fs.renameSync(temporary, destination);
      }
      urls.set(app.id, ".unknown-cache/" + name);
    } catch (error) {
      // A missing app icon should not prevent the launcher catalog from loading.
    }
  });

  try {
    fs.readdirSync(APP_ASSET_CACHE_DIR).forEach((name) => {
      if (/^[a-f0-9]{24}\.(png|jpe?g|webp|gif|svg)$/i.test(name) && !retained.has(name)) {
        fs.unlinkSync(path.join(APP_ASSET_CACHE_DIR, name));
      }
    });
  } catch (error) {
    // Stale cache files are harmless if cleanup is unavailable.
  }
  return urls;
}

function mimeType(file) {
  const extension = path.extname(file).toLowerCase();
  if (extension === ".jpg" || extension === ".jpeg") {
    return "image/jpeg";
  }
  if (extension === ".webp") {
    return "image/webp";
  }
  if (extension === ".gif") {
    return "image/gif";
  }
  if (extension === ".svg") {
    return "image/svg+xml";
  }
  return "image/png";
}

module.exports = { service, APP_ID, PROTECTED_APP_IDS, payloadObject, readJson, writeJsonAtomic, elevated, appSource, scanApps, publicApps, loadConfig, saveConfig, serviceCall, removeInstalledApp, getInputs, snapshotCandidates, getRecentIds, isInside, relativeAsset, latestSnapshot, resolveAsset, cacheAppIcons, mimeType };
