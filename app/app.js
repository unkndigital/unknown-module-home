(function () {
  "use strict";

  var SERVICE = "luna://org.unknown.home.module.service/";
  var APP_MANAGER = "luna://com.webos.applicationManager/";
  var EIM = "luna://com.webos.service.eim/";
  var activeBridges = [];
  var toastTimer = null;
  var assetCache = {};
  var assetPending = {};
  var assetQueue = [];
  var assetInflight = 0;
  var assetHydrateTimer = null;
  var previewTimer = null;
  var previewIdleCancel = null;
  var previewScheduleToken = 0;
  var lastNavigationAt = 0;
  var focusScrollFrame = 0;
  var focusScrollTarget = null;
  var appById = {};
  var lastFavoriteState = null;
  var selectedAppId = "";
  var contextAppId = "";
  var contextReturnAppId = "";
  var holdTimer = null;
  var holdCueTimer = null;
  var holdSource = "";
  var tileAcceptPressed = false;
  var holdTargetId = "";
  var holdOpened = false;
  var holdTileElement = null;
  var contextAcceptBlockedUntil = 0;
  var suppressTileClickUntil = 0;
  var lastDirection = "";
  var lastDirectionAt = 0;
  var catalogRefresh = null;
  var catalogRefreshAt = 0;
  var appUpdates = {}, updateSources = {}, updateBusy = false, updateCheckedAt = 0;
  var updateSourcesLoaded = false, updateSourceError = false;

  var state = {
backend: false,
view: "home",
appFilter: "all",
apps: [],
inputs: [],
recentIds: [],
favorites: [],
preferences: {
      density: "comfortable",
      showStubs: true
    }
};

  var viewTitles = {
    home: "Home",
    apps: "All apps",
    inputs: "Inputs",
    system: "System",
    modules: "Modules",
    moduleApps: "Module Apps"
  };

  function $(id) {
    return document.getElementById(id);
  }

  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function lunaCall(uri, payload, timeoutMs) {
    return new Promise(function (resolve, reject) {
      if (!window.PalmServiceBridge) {
        reject(new Error("PalmServiceBridge is unavailable"));
        return;
      }

      var bridge = new window.PalmServiceBridge();
      var complete = false;
      var timer;
      activeBridges.push(bridge);

      function finish() {
        var index = activeBridges.indexOf(bridge);
        if (index >= 0) {
          activeBridges.splice(index, 1);
        }
        if (timer) {
          clearTimeout(timer);
        }
      }

      bridge.onservicecallback = function (raw) {
        if (complete) {
          return;
        }
        complete = true;
        finish();
        try {
          var result = JSON.parse(raw || "{}");
          if (result.returnValue === false) {
            reject(new Error(result.errorText || result.errorMessage || "Service request failed"));
            return;
          }
          resolve(result);
        } catch (error) {
          reject(error);
        }
      };

      timer = setTimeout(function () {
        if (complete) {
          return;
        }
        complete = true;
        finish();
        reject(new Error("Service request timed out"));
      }, timeoutMs || 12000);

      try {
        bridge.call(uri, JSON.stringify(payload || {}));
      } catch (error) {
        complete = true;
        finish();
        reject(error);
      }
    });
  }

  function mockBootstrap() {
    var apps = [
      { id: "youtube.leanback.v4", title: "YouTube", source: "store", type: "native", description: "YouTube on TV" },
      { id: "org.xbmc.kodi", title: "Kodi", source: "homebrew", type: "native", description: "Media center" },
      { id: "netflix", title: "Netflix", source: "store", type: "native", description: "Netflix" },
      { id: "com.apple.appletv", title: "Apple TV", source: "store", type: "native", description: "Apple TV" },
      { id: "amazon", title: "Prime Video", source: "store", type: "native", description: "Prime Video" },
      { id: "org.webosbrew.hbchannel", title: "Homebrew Channel", source: "homebrew", type: "web", description: "Homebrew apps" },
      { id: "com.webos.app.mediadiscovery", title: "Media Player", source: "system", type: "web", description: "Local media" },
      { id: "com.webos.app.lgchannels", title: "LG Channels", source: "system", type: "web", description: "Live channels" }
    ];
    return {
returnValue: true,
apps: apps,
inputs: [
        { id: "HDMI_1", appId: "com.webos.app.hdmi1", label: "HDMI 1", connected: false, active: false },
        { id: "HDMI_2", appId: "com.webos.app.hdmi2", label: "PlayStation 5", connected: true, active: true },
        { id: "HDMI_3", appId: "com.webos.app.hdmi3", label: "HDMI 3", connected: false, active: false },
        { id: "HDMI_4", appId: "com.webos.app.hdmi4", label: "HDMI 4", connected: false, active: false }
      ],
recentIds: ["youtube.leanback.v4", "org.xbmc.kodi", "com.apple.appletv"],
favorites: ["youtube.leanback.v4", "org.xbmc.kodi", "netflix", "com.apple.appletv"],
preferences: {
        density: "comfortable",
        showStubs: true
      }
};
  }

  function normalizeApp(app) {
    var source = app.source || (String(app.folderPath || "").indexOf("/media/developer/") === 0 ? "homebrew" : "store");
    var protectedIds = ["org.webosbrew.hbchannel"];
    return {
      id: String(app.id || ""),
      title: String(app.title || app.id || "Untitled"),
      source: source,
      moduleId: app.id === "org.unknown.core" ? "core" : String(app.moduleId || ""),
      type: String(app.type || "web"),
      description: String(app.description || app.appDescription || app.vendor || ""),
      version: String(app.version || ""),
      isStub: app.isStub === true || app.type === "stub",
      removable: app.removable === undefined
        ? source !== "system" && protectedIds.indexOf(String(app.id || "")) < 0
        : app.removable === true,
      fallbackIcon: app.fallbackIcon || (app.folderPath && app.icon ? "file://" + app.folderPath + "/" + app.icon : "")
    };
  }

  function applyBootstrap(result, backend) {
    state.backend = backend;
    state.apps = (result.apps || []).map(normalizeApp).filter(function (app) {
      return app.id && app.id !== "org.unknown.home.module";
    });
    appById = {};
    state.apps.forEach(function (app) {
      appById[app.id] = app;
    });
    state.inputs = result.inputs || [];
    state.recentIds = result.recentIds || [];
    state.favorites = result.favorites || [];
    state.preferences = Object.assign(state.preferences, result.preferences || {});

    if (!state.favorites.length) {
      state.favorites = defaultFavorites();
    }
    selectedAppId = firstSelectableAppId();
    renderAll();
  }

  function defaultFavorites() {
    var priority = [
      "youtube.leanback.v4",
      "org.xbmc.kodi",
      "netflix",
      "com.apple.appletv",
      "amazon",
      "org.webosbrew.hbchannel"
    ];
    return priority.filter(findApp).slice(0, 6);
  }

  function firstSelectableAppId() {
    var favorite = state.favorites.find(findApp);
    if (favorite) {
      return favorite;
    }
    if (state.recentIds.length && findApp(state.recentIds[0])) {
      return state.recentIds[0];
    }
    return state.apps.length ? state.apps[0].id : "";
  }

  function findApp(id) {
    return appById[id] || null;
  }

  function fallbackBootstrap() {
    if (!window.PalmServiceBridge) {
      return Promise.resolve(mockBootstrap());
    }

    return Promise.all([
      lunaCall(APP_MANAGER + "dev/listApps", {}, 9000).catch(function () { return { apps: [] }; }),
      lunaCall(EIM + "getAllInputStatus", { subscribe: false }, 9000).catch(function () { return { devices: [] }; })
    ]).then(function (results) {
      var stored = {};
      try {
        stored = JSON.parse(localStorage.getItem("unknown-home-preferences") || "{}");
      } catch (error) {
        stored = {};
      }
      return {
apps: results[0].apps || [],
inputs: normalizeInputs(results[1].devices || []),
recentIds: [],
favorites: stored.favorites || [],
preferences: stored.preferences || {}
};
    });
  }

  function normalizeInputs(devices) {
    return devices.map(function (device) {
      return {
        id: device.id,
        appId: device.appId,
        label: device.label || device.id,
        connected: device.connected === true || device.hdmiPlugIn === true,
        active: device.activate === true || device.active === true,
        port: device.port,
        deviceName: device.spdProductDescription || device.spdVendorName || ""
      };
    });
  }

  function bootstrap(showNotice) {
    setGuardBadge("loading", "Refreshing");
    return lunaCall(SERVICE + "bootstrap", {}, 15000)
      .then(function (result) {
        applyBootstrap(result, true);
        refreshUpdates();
        setGuardBadge(result.elevated ? "healthy" : "warning", result.elevated ? "Root service" : "Launcher only");
        if (showNotice) {
          showToast("Launcher refreshed");
        }
      })
      .catch(function () {
        if (window.PalmServiceBridge) {
          applyBootstrap({apps:[],inputs:[],favorites:[],recentIds:[]},true);
          setGuardBadge("error","Module unavailable");
          showToast("Open Unknown Core to enable or recover the Home module",true);
          return;
        }
        return fallbackBootstrap().then(function (result) {
          applyBootstrap(result, false);
          setGuardBadge("error", "Reduced mode");
          if (showNotice) {
            showToast("Root companion service is unavailable", true);
          }
        });
      });
  }

  function refreshAppCatalog() {
    if (!state.backend || document.hidden || catalogRefresh || Date.now() - catalogRefreshAt < 2000) return;
    catalogRefreshAt = Date.now();
    catalogRefresh = lunaCall(SERVICE + "appCatalog", {}, 15000).then(function (result) {
      if (!Array.isArray(result.apps)) return;
      var next = result.apps.map(normalizeApp).filter(function(app){return app.id && app.id !== "org.unknown.home.module";});
      if (JSON.stringify(state.apps) === JSON.stringify(next)) return;
      var current = document.activeElement;
      var currentId = current && current.getAttribute("data-app-id");
      var parentId = current && current.parentElement && current.parentElement.id;
      state.apps = next;
      appById = {};
      state.apps.forEach(function (app) { appById[app.id] = app; });
      if (!findApp(selectedAppId)) selectedAppId = firstSelectableAppId();
      renderAll();
      if (currentId && parentId && $(parentId)) {
        var replacement = Array.prototype.find.call($(parentId).querySelectorAll("[data-app-id]"), function (node) { return node.getAttribute("data-app-id") === currentId; });
        focusElement(replacement || $(parentId).querySelector("[data-focusable]"));
      }
      hydrateVisibleAssets();
    }).catch(function (error) { console.warn("Home app inventory refresh failed", error.message); }).then(function () { catalogRefresh = null; refreshUpdates(); });
  }

  function paintUpdateBadges() {
    Array.prototype.forEach.call(document.querySelectorAll(".app-update-badge"),function(badge){var info=appUpdates[badge.getAttribute("data-update-id")];badge.hidden=!(info&&info.status==="update-available");badge.title=info&&info.latestVersion?"Update available: "+info.latestVersion:"";});
    if(contextIsOpen())updateContextMenu();
  }
  function refreshUpdates() {
    if(!state.backend||document.hidden||updateBusy||Date.now()-updateCheckedAt<60000)return;
    updateBusy=true;updateCheckedAt=Date.now();
    lunaCall(SERVICE+"updateSources",{},15000).then(function(result){
      updateSources={};updateSourcesLoaded=true;updateSourceError=false;var queue=(result.sources||[]).slice();queue.forEach(function(item){updateSources[item.id]=true;});
      Object.keys(appUpdates).forEach(function(id){if(!updateSources[id]||!findApp(id))delete appUpdates[id];});paintUpdateBadges();
      function next(){if(!queue.length||document.hidden)return Promise.resolve();var item=queue.shift();return lunaCall(SERVICE+"checkAppUpdate",{id:item.id},30000).then(function(result){appUpdates[item.id]=result.update;}).catch(function(){appUpdates[item.id]={status:"unknown"};}).then(function(){paintUpdateBadges();return next();});}
      return next();
    }).catch(function(error){updateSourceError=true;updateCheckedAt=Date.now()-55000;console.warn("Home update check unavailable",error.message);}).then(function(){updateBusy=false;if(contextIsOpen())updateContextMenu();});
  }

  function setGuardBadge(mode, text) {
    var badge = $("guardBadge");
    badge.classList.remove("is-healthy", "is-error");
    if (mode === "healthy") {
      badge.classList.add("is-healthy");
    } else if (mode === "error") {
      badge.classList.add("is-error");
    }
    badge.querySelector("span:last-child").textContent = text;
  }

  function showToast(message, error) {
    var toast = $("toast");
    toast.textContent = message;
    toast.classList.toggle("is-error", !!error);
    toast.classList.add("is-visible");
    if (toastTimer) {
      clearTimeout(toastTimer);
    }
    toastTimer = setTimeout(function () {
      toast.classList.remove("is-visible");
    }, 3400);
  }

  function tileMarkup(app, index) {
    var fallback = app.fallbackIcon || "icon.png";
    return [
      '<button class="app-tile" data-focusable data-nav-index="', index, '" data-app-id="', escapeHtml(app.id), '">',
      '<span class="app-source ', escapeHtml(app.source), '"></span>',
      '<span class="app-update-badge" data-update-id="', escapeHtml(app.id), '"', appUpdates[app.id]&&appUpdates[app.id].status==="update-available"?'':' hidden', '>Update</span>',
      '<span class="app-icon-wrap">',
      '<img class="app-icon" src="', escapeHtml(fallback), '" alt="" data-app-asset="', escapeHtml(app.id), '">',
      "</span>",
      '<span class="app-title">', escapeHtml(app.title), "</span>",
      "</button>"
    ].join("");
  }

  function inputMarkup(input, index) {
    var classes = ["input-tile"];
    if (input.active) {
      classes.push("is-active");
    }
    if (input.connected) {
      classes.push("is-connected");
    } else {
      classes.push("is-disconnected");
    }
    var detail = input.active ? "Active" : (input.connected ? (input.deviceName || "Connected") : "Not connected");
    return [
      '<button class="', classes.join(" "), '" data-focusable data-nav-index="', index,
      '" data-input-app-id="', escapeHtml(input.appId || ""), '"',
      input.appId ? "" : " disabled",
      ">",
      '<span class="input-state"></span>',
      '<img src="assets/icons/monitor-up.svg" alt="">',
      "<span><strong>", escapeHtml(input.label || input.id), "</strong><span>", escapeHtml(detail), "</span></span>",
      "</button>"
    ].join("");
  }

  function renderAll() {
    document.documentElement.classList.toggle("density-compact", state.preferences.density === "compact");
    renderHome();
    renderApps();
    renderModuleApps();
    renderInputs();
    
    updatePreview();
    updateControls();
    hydrateVisibleAssets();
  }

  function visibleApps() {
    return state.apps.filter(function (app) {
      return state.preferences.showStubs || !app.isStub;
    });
  }

  function renderHome() {
    var favorites = state.favorites.map(findApp).filter(Boolean);
    var recent = state.recentIds.map(findApp).filter(Boolean).filter(function (app, index, list) {
      return list.indexOf(app) === index;
    }).slice(0, 10);
    var favoriteRow = $("favoritesRow");
    var recentRow = $("recentRow");

    favoriteRow.innerHTML = favorites.length
      ? favorites.map(tileMarkup).join("")
      : '<div class="empty-state">No favorites selected</div>';
    recentRow.innerHTML = recent.length
      ? recent.map(tileMarkup).join("")
      : visibleApps().slice(0, 8).map(tileMarkup).join("");

    $("favoritesCount").textContent = String(favorites.length);
    $("recentCount").textContent = String(recent.length || Math.min(8, visibleApps().length));
    $("quickInputsRow").innerHTML = state.inputs.map(inputMarkup).join("");
    $("inputSummary").textContent = inputSummary();
  }

  function inputSummary() {
    var connected = state.inputs.filter(function (input) { return input.connected; }).length;
    var active = state.inputs.find(function (input) { return input.active; });
    if (active) {
      return active.label + " active";
    }
    return connected + " connected";
  }

  function renderApps() {
    var apps = visibleApps().filter(function (app) {
      return !app.moduleId && (state.appFilter === "all" || app.source === state.appFilter);
    });
    $("appsGrid").innerHTML = apps.length
      ? apps.map(tileMarkup).join("")
      : '<div class="empty-state">No apps in this group</div>';
  }

  function renderModuleApps() {
    var apps = visibleApps().filter(function(app){return !!app.moduleId;});
    $("moduleAppsGrid").innerHTML = apps.length ? apps.map(tileMarkup).join("") : '<div class="empty-state">No module apps installed</div>';
  }

  function renderInputs() {
    $("inputsGrid").innerHTML = state.inputs.length
      ? state.inputs.map(inputMarkup).join("")
      : '<div class="empty-state">No external inputs reported</div>';
  }

  function setToggle(button, checked) {
    button.setAttribute("aria-checked", checked ? "true" : "false");
  }

  function updateFavoriteControls(force) {
    var favorite = state.favorites.indexOf(selectedAppId) >= 0;
    if (!force && favorite === lastFavoriteState) {
      return;
    }
    lastFavoriteState = favorite;
    $("favoriteSelected").classList.toggle("is-selected", favorite);
    $("favoriteSelected").title = favorite ? "Remove from favorites" : "Add to favorites";
    $("appsFavoriteToggle").classList.toggle("is-selected", favorite);
    $("appsFavoriteToggle").querySelector("span").textContent = favorite ? "Favorited" : "Favorite";
  }

  function updatePreferenceControls() {
    Array.prototype.forEach.call(document.querySelectorAll("[data-density]"), function (button) {
      button.classList.toggle("is-selected", button.getAttribute("data-density") === state.preferences.density);
    });
    setToggle($("stubsToggle"), state.preferences.showStubs);
  }

  function updateControls() {
    updateFavoriteControls(true);
    updatePreferenceControls();
  }

  function setPreviewLoading(loading) {
    var indicator = $("previewLoading");
    if (indicator.hidden !== !loading) {
      indicator.hidden = !loading;
    }
  }

  function updatePreview() {
    if (previewTimer) {
      clearTimeout(previewTimer);
      previewTimer = null;
    }
    if (previewIdleCancel) {
      previewIdleCancel();
      previewIdleCancel = null;
    }
    var app = findApp(selectedAppId);
    if (!app) {
      setPreviewLoading(false);
      $("previewMeta").textContent = "Unknown Home";
      $("previewIcon").src = "icon.png";
      $("previewBackdropIcon").src = "icon.png";
      $("previewTitle").textContent = state.apps.length ? "Select an app" : "No apps found";
      $("previewDescription").textContent = state.backend ? "Refresh the launcher to scan again." : "Root companion service is unavailable.";
      $("launchSelected").disabled = true;
      return;
    }

    $("launchSelected").disabled = false;
    $("previewMeta").textContent = sourceLabel(app.source) + (app.version ? "  |  " + app.version : "");
    $("previewTitle").textContent = app.title;
    $("previewDescription").textContent = app.description || (app.isStub ? "Store shortcut" : "Ready to open");
    $("previewImage").src = app.fallbackIcon || "splash.png";
    $("previewIcon").src = app.fallbackIcon || "icon.png";
    $("previewBackdropIcon").src = app.fallbackIcon || "icon.png";
    updateFavoriteControls();
    if (!app.fallbackIcon) {
      requestAsset(app.id, "icon").then(function (dataUri) {
        if (selectedAppId === app.id && dataUri) {
          $("previewIcon").src = dataUri;
          $("previewBackdropIcon").src = dataUri;
        }
      });
    }
    requestAsset(app.id, "preview").then(function (dataUri) {
      if (selectedAppId === app.id && dataUri) {
        $("previewImage").src = dataUri;
      }
      if (selectedAppId === app.id) {
        setPreviewLoading(false);
      }
    });
  }

  function runWhenIdle(callback) {
    if (window.requestIdleCallback && window.cancelIdleCallback) {
      var idleHandle = window.requestIdleCallback(callback, { timeout: 800 });
      return function () {
        window.cancelIdleCallback(idleHandle);
      };
    }
    var fallbackHandle = setTimeout(callback, 48);
    return function () {
      clearTimeout(fallbackHandle);
    };
  }

  function schedulePreviewUpdate(delay) {
    if (previewTimer) {
      clearTimeout(previewTimer);
    }
    if (previewIdleCancel) {
      previewIdleCancel();
      previewIdleCancel = null;
    }
    var token = ++previewScheduleToken;
    setPreviewLoading(true);
    previewTimer = setTimeout(function () {
      previewTimer = null;
      previewIdleCancel = runWhenIdle(function () {
        previewIdleCancel = null;
        if (token !== previewScheduleToken) {
          return;
        }
        var navigationQuietFor = Date.now() - lastNavigationAt;
        if (navigationQuietFor < 360) {
          schedulePreviewUpdate(360 - navigationQuietFor);
          return;
        }
        updatePreview();
      });
    }, delay == null ? 360 : delay);
  }

  function sourceLabel(source) {
    if (source === "homebrew") {
      return "Homebrew";
    }
    if (source === "system") {
      return "webOS";
    }
    return "LG Content Store";
  }

  function selectApp(id, immediate) {
    if (!id || !findApp(id)) {
      return;
    }
    if (selectedAppId === id && !immediate) {
      return;
    }
    selectedAppId = id;
    lastNavigationAt = Date.now();
    updateFavoriteControls();
    if (immediate) {
      updatePreview();
    } else if (state.view === "home") {
      schedulePreviewUpdate(360);
    }
  }

  function launchApp(id) {
    if (!id) {
      return;
    }
    var request = state.backend
      ? lunaCall(SERVICE + "launch", { id: id }, 12000)
      : lunaCall(APP_MANAGER + "launch", { id: id }, 12000);
    request.catch(function (error) {
      showToast(error.message || "App launch failed", true);
    });
  }

  function launchSelected() {
    launchApp(selectedAppId);
  }

  function toggleFavorite() {
    if (!selectedAppId) {
      return;
    }
    var index = state.favorites.indexOf(selectedAppId);
    if (index >= 0) {
      state.favorites.splice(index, 1);
    } else {
      state.favorites.push(selectedAppId);
    }
    renderHome();
    updateControls();
    hydrateVisibleAssets();
    savePreferences();
  }

  function savePreferences() {
    var payload = {
      favorites: state.favorites,
      preferences: state.preferences
    };
    if (state.backend) {
      lunaCall(SERVICE + "savePreferences", payload, 10000).catch(function (error) {
        showToast(error.message || "Could not save settings", true);
      });
      return;
    }
    try {
      localStorage.setItem("unknown-home-preferences", JSON.stringify(payload));
    } catch (error) {
      showToast("Could not save settings", true);
    }
  }

  function requestAsset(id, kind) {
    var key = id + "|" + kind;
    if (assetCache[key] !== undefined) {
      return Promise.resolve(assetCache[key]);
    }
    if (assetPending[key]) {
      return assetPending[key];
    }
    if (!state.backend) {
      return Promise.resolve("");
    }
    assetPending[key] = new Promise(function (resolve) {
      assetQueue.push({ id: id, kind: kind, key: key, resolve: resolve });
      drainAssetQueue();
    });
    return assetPending[key];
  }

  function drainAssetQueue() {
    while (assetInflight < 2 && assetQueue.length) {
      var item = assetQueue.shift();
      assetInflight += 1;
      lunaCall(SERVICE + "getAsset", { id: item.id, kind: item.kind }, 12000)
        .then(function (queued, result) {
          var dataUri = result.dataUri || "";
          assetCache[queued.key] = dataUri;
          delete assetPending[queued.key];
          queued.resolve(dataUri);
        }.bind(null, item))
        .catch(function (queued) {
          assetCache[queued.key] = "";
          delete assetPending[queued.key];
          queued.resolve("");
        }.bind(null, item))
        .then(function () {
          assetInflight -= 1;
          drainAssetQueue();
        });
    }
  }

  function hydrateVisibleAssets() {
    if (assetHydrateTimer) {
      clearTimeout(assetHydrateTimer);
      assetHydrateTimer = null;
    }
    var root = document.querySelector('[data-view="' + state.view + '"].is-active');
    if (!root) {
      return;
    }
    var uncached = 0;
    Array.prototype.forEach.call(root.querySelectorAll("[data-app-asset]"), function (image) {
      var id = image.getAttribute("data-app-asset");
      var app = findApp(id);
      if (app && app.fallbackIcon) {
        return;
      }
      var key = id + "|icon";
      var rect = image.getBoundingClientRect();
      if (rect.right < -180 || rect.left > window.innerWidth + 180 ||
          rect.bottom < -180 || rect.top > window.innerHeight + 180) {
        return;
      }
      if (assetCache[key] === undefined && !assetPending[key]) {
        if (uncached >= 8) {
          return;
        }
        uncached += 1;
      }
      requestAsset(id, "icon").then(function (dataUri) {
        if (dataUri && image.getAttribute("data-app-asset") === id) {
          image.src = dataUri;
        }
      });
    });
    if (uncached >= 8) {
      scheduleAssetHydration(220);
    }
  }

  function scheduleAssetHydration(delay) {
    if (assetHydrateTimer) {
      clearTimeout(assetHydrateTimer);
    }
    assetHydrateTimer = setTimeout(function () {
      assetHydrateTimer = null;
      hydrateVisibleAssets();
    }, delay == null ? 120 : delay);
  }

  function setView(view, focusContent) {
    if (!viewTitles[view]) {
      return;
    }
    state.view = view;
    Array.prototype.forEach.call(document.querySelectorAll("[data-view]"), function (section) {
      section.classList.toggle("is-active", section.getAttribute("data-view") === view);
    });
    Array.prototype.forEach.call(document.querySelectorAll("[data-view-target]"), function (button) {
      button.classList.toggle("is-active", button.getAttribute("data-view-target") === view);
    });
    $("viewTitle").textContent = viewTitles[view];
    $("viewEyebrow").textContent = view === "system" ? "Unknown Suite" : "Unknown Home";
    hydrateVisibleAssets();
    if (view === "home") {
      schedulePreviewUpdate(0);
    }
    if (view === "modules" && window.UnknownHomeModules) window.UnknownHomeModules.refresh();
    if (view === "moduleApps" && state.backend) {
      lunaCall(SERVICE+"moduleCatalog",{},9000).then(function(result){
        var focusedId=document.activeElement.getAttribute("data-app-id");
        state.apps=state.apps.filter(function(app){return app.id.indexOf("unknown-module:")!==0;}).concat((result.apps||[]).map(normalizeApp));
        appById={};state.apps.forEach(function(app){appById[app.id]=app;});
        if(state.view!=="moduleApps")return;
        renderModuleApps();hydrateVisibleAssets();
        if(focusedId){var target=Array.prototype.find.call($("moduleAppsGrid").querySelectorAll("[data-app-id]"),function(node){return node.getAttribute("data-app-id")===focusedId;});if(target)focusElement(target);}
      }).catch(function(error){showToast("Module list unavailable: "+error.message,true);});
    }
    if (focusContent) {
      setTimeout(function () {
        var first = document.querySelector('[data-view="' + view + '"].is-active [data-focusable]:not([disabled])');
        if (first) {
          focusElement(first);
        }
      }, 0);
    }
  }

  function setFilter(filter) {
    state.appFilter = filter;
    Array.prototype.forEach.call(document.querySelectorAll("[data-app-filter]"), function (button) {
      button.classList.toggle("is-selected", button.getAttribute("data-app-filter") === filter);
    });
    renderApps();
    hydrateVisibleAssets();
  }

  function updateClock() {
    var now = new Date();
    var hours = now.getHours();
    var minutes = String(now.getMinutes()).padStart(2, "0");
    var suffix = hours >= 12 ? "PM" : "AM";
    hours = hours % 12 || 12;
    $("clock").textContent = hours + ":" + minutes + " " + suffix;
  }

  function focusElement(element) {
    if (!element) {
      return;
    }
    try {
      element.focus({ preventScroll: true });
    } catch (error) {
      element.focus();
    }
    focusScrollTarget = element;
    if (!focusScrollFrame) {
      focusScrollFrame = window.requestAnimationFrame(function () {
        focusScrollFrame = 0;
        var target = focusScrollTarget;
        focusScrollTarget = null;
        if (!target || !document.documentElement.contains(target)) {
          return;
        }
        var rect = target.getBoundingClientRect();
        var workspace = target.closest(".workspace");
        var bounds = workspace ? workspace.getBoundingClientRect() : {
          top: 0,
          right: window.innerWidth,
          bottom: window.innerHeight,
          left: 0
        };
        var row = target.closest(".tile-row, .input-row");
        var rowRect = row ? row.getBoundingClientRect() : null;
        var verticalRect = rowRect || rect;
        if (workspace) {
          var topbar = document.querySelector(".topbar");
          var topLimit = Math.max(bounds.top, topbar ? topbar.getBoundingClientRect().bottom : 104) + 12;
          var bottomLimit = bounds.bottom - (state.view === "modules" ? 40 : 12);
          if (verticalRect.top < topLimit) {
            workspace.scrollTop += verticalRect.top - topLimit;
          } else if (verticalRect.bottom > bottomLimit) {
            workspace.scrollTop += verticalRect.bottom - bottomLimit;
          }
          if (row && rect.left < rowRect.left + 11) {
            row.scrollLeft += rect.left - rowRect.left - 11;
          } else if (row && rect.right > rowRect.right - 11) {
            row.scrollLeft += rect.right - rowRect.right + 11;
          }
        } else if (rect.top < bounds.top + 8 || rect.bottom > bounds.bottom - 8 ||
            rect.left < bounds.left + 8 || rect.right > bounds.right - 8) {
          try {
            target.scrollIntoView({ block: "nearest", inline: "nearest" });
          } catch (error) {
            target.scrollIntoView(false);
          }
        }
      });
    }
  }

  function navIndex(element, group) {
    var index = Number(element.getAttribute("data-nav-index"));
    if (!Number.isInteger(index)) {
      index = Array.prototype.indexOf.call(group.children, element);
    }
    return index;
  }

  function horizontalGridCandidate(group, current, direction) {
    var index = navIndex(current, group);
    var columns = gridColumnCount(group);
    var column = index % columns;
    if (direction === "left" && column === 0) {
      return document.querySelector('.rail [data-view-target].is-active');
    }
    if (direction === "right" && column === columns - 1) {
      return null;
    }
    return adjacentFocusable(current, direction);
  }

  function gridTarget(group, current, direction) {
    var index = navIndex(current, group);
    var columns = gridColumnCount(group);
    var targetIndex = direction === "down" ? index + columns : index - columns;
    if (direction === "down" && targetIndex >= group.children.length && index < group.children.length - 1) {
      targetIndex = group.children.length - 1;
    }
    var target = group.children[targetIndex];
    if (target && target.hasAttribute("data-focusable") && !target.disabled) {
      return target;
    }
    return null;
  }

  function adjacentFocusable(current, direction) {
    var candidate = current;
    var property = direction === "right" ? "nextElementSibling" : "previousElementSibling";
    do {
      candidate = candidate[property];
    } while (candidate && (!candidate.hasAttribute("data-focusable") || candidate.disabled));
    return candidate;
  }

  function gridColumnCount(group) {
    var width = group.clientWidth;
    var count = group.children.length;
    if (group._unknownNavWidth === width && group._unknownNavCount === count && group._unknownNavColumns) {
      return group._unknownNavColumns;
    }
    var first = group.children[0];
    var columns = 0;
    if (first) {
      var top = first.offsetTop;
      while (columns < count && Math.abs(group.children[columns].offsetTop - top) < 2) {
        columns += 1;
      }
    }
    group._unknownNavWidth = width;
    group._unknownNavCount = count;
    group._unknownNavColumns = Math.max(1, columns);
    return group._unknownNavColumns;
  }

  function directGroupCandidate(current, direction) {
    var group = current.closest(".tile-row, .input-row, .app-grid, .input-grid, .segmented-control, .preview-actions, .command-row");
    if (!group) {
      return undefined;
    }

    var isGrid = group.classList.contains("app-grid") || group.classList.contains("input-grid");
    if (direction === "left" || direction === "right") {
      var horizontal = isGrid
        ? horizontalGridCandidate(group, current, direction)
        : adjacentFocusable(current, direction);
      if (!horizontal) {
        if (direction === "left") {
          return document.querySelector('.rail [data-view-target].is-active');
        }
        return null;
      }
      return horizontal;
    }

    if (!isGrid || (direction !== "up" && direction !== "down")) {
      return undefined;
    }
    if (group.id === "appsGrid" && direction === "up" && navIndex(current, group) < gridColumnCount(group)) {
      return document.querySelector('[data-app-filter].is-selected') || document.querySelector('[data-app-filter]');
    }
    return gridTarget(group, current, direction);
  }

  function focusableElements() {
    var root = $("contextScrim").hidden ? document : $("contextSheet");
    return Array.prototype.filter.call(root.querySelectorAll("[data-focusable]"), function (element) {
      if (element.disabled) {
        return false;
      }
      var style = window.getComputedStyle(element);
      var rect = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    });
  }

  function elementCenter(element) {
    var rect = element.getBoundingClientRect();
    return {
      element: element,
      rect: rect,
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2
    };
  }

  function horizontalPeer(current, elements, direction) {
    var group = current.closest(".tile-row, .input-row, .app-grid, .input-grid, .segmented-control, .preview-actions, .command-row");
    if (!group) {
      return null;
    }

    var origin = elementCenter(current);
    var sign = direction === "right" ? 1 : -1;
    var peers = elements.map(elementCenter).filter(function (candidate) {
      if (candidate.element === current || !group.contains(candidate.element)) {
        return false;
      }
      var dx = candidate.x - origin.x;
      var overlap = Math.min(origin.rect.bottom, candidate.rect.bottom) -
        Math.max(origin.rect.top, candidate.rect.top);
      var minimumOverlap = Math.min(origin.rect.height, candidate.rect.height) * 0.45;
      return dx * sign > 8 && overlap >= minimumOverlap;
    });

    peers.sort(function (left, right) {
      return Math.abs(left.x - origin.x) - Math.abs(right.x - origin.x);
    });
    return peers.length ? peers[0].element : null;
  }

  function directionalCandidate(current, elements, direction) {
    var origin = elementCenter(current);
    var candidates = [];

    elements.forEach(function (element) {
      if (element === current) {
        return;
      }
      var candidate = elementCenter(element);
      var dx = candidate.x - origin.x;
      var dy = candidate.y - origin.y;
      var primary;
      var secondary;

      if (direction === "left" && dx < -8) {
        primary = -dx;
        secondary = Math.abs(dy);
      } else if (direction === "right" && dx > 8) {
        primary = dx;
        secondary = Math.abs(dy);
      } else if (direction === "up" && dy < -8) {
        primary = -dy;
        secondary = Math.abs(dx);
      } else if (direction === "down" && dy > 8) {
        primary = dy;
        secondary = Math.abs(dx);
      } else {
        return;
      }

      candidates.push({
        element: element,
        primary: primary,
        secondary: secondary,
        aligned: secondary <= Math.max(72, primary * 0.72)
      });
    });

    var aligned = candidates.filter(function (candidate) {
      return candidate.aligned;
    });
    var pool = aligned.length ? aligned : candidates;
    pool.sort(function (left, right) {
      return (left.primary + left.secondary * 5) -
        (right.primary + right.secondary * 5);
    });
    return pool.length ? pool[0].element : null;
  }

  function moveFocus(direction) {
    if (holdTargetId && !holdOpened) endTileHold(false);
    var current = document.activeElement;
    if (current && current.classList.contains("module-output") && (direction === "up" || direction === "down")) {
      var remaining = current.scrollHeight - current.clientHeight - current.scrollTop;
      if (direction === "up" && current.scrollTop > 0 || direction === "down" && remaining > 1) {
        current.scrollTop += direction === "up" ? -120 : 120;
        return;
      }
    }

    if (current) {
      var direct = directGroupCandidate(current, direction);
      if (direct !== undefined) {
        if (direct) {
          focusElement(direct);
        }
        return;
      }
    }
    var elements = focusableElements();
    if (!current || elements.indexOf(current) < 0) {
      focusElement(document.querySelector('.view.is-active [data-focusable]:not([disabled])') || elements[0]);
      return;
    }

    var best = null;
    if (direction === "left" || direction === "right") {
      best = horizontalPeer(current, elements, direction);
    }
    if (!best) {
      best = directionalCandidate(current, elements, direction);
    }

    if (best) {
      focusElement(best);
    }
  }

  function contextIsOpen() {
    return !$("contextScrim").hidden;
  }

  function resetContextConfirm() {
    $("contextActions").hidden = false;
    $("contextConfirm").hidden = true;
  }

  function updateContextMenu() {
    var app = findApp(contextAppId);
    if (!app) {
      closeContextMenu();
      return;
    }

    var favorite = state.favorites.indexOf(app.id) >= 0;
    $("contextMeta").textContent = sourceLabel(app.source);
    $("contextTitle").textContent = app.title;
    $("contextVersion").textContent = app.version || "Not reported";
    $("contextType").textContent = app.isStub ? "Store shortcut" : app.type;
    $("contextAppId").textContent = app.id;
    $("contextIcon").src = app.fallbackIcon || "icon.png";
    $("contextFavorite").querySelector("strong").textContent = favorite ? "Remove favorite" : "Add favorite";
    $("contextFavorite").querySelector("small").textContent = favorite
      ? "Remove from the Home screen"
      : "Add to the Home screen";
    $("contextPin").disabled = state.favorites[0] === app.id;
    var update=appUpdates[app.id];
    $("contextUpdate").disabled=!state.backend||!updateSources[app.id];
    $("contextUpdate").querySelector("strong").textContent=update&&update.status==="update-available"?"Update":"Check for updates";
    $("contextUpdateDetail").textContent=!updateSources[app.id]?(updateSourceError?"Source check unavailable. Reopen this menu to retry.":!updateSourcesLoaded?"Checking update sources...":"No known GitHub update source"):update&&update.status==="update-available"?"Version "+update.latestVersion+" is available. Review it in Core.":update&&update.status==="up-to-date"?"Version "+app.version+" is current. Check releases in Core.":"Review the latest GitHub release in Core.";
    $("contextUninstall").disabled = !state.backend || !app.removable;
    $("contextUninstallDetail").textContent = app.removable
      ? "Remove from this TV"
      : (app.source === "system" ? "Built-in webOS app" : "Protected app");
    $("contextConfirmTitle").textContent = app.title;

    if (!app.fallbackIcon) {
      requestAsset(app.id, "icon").then(function (dataUri) {
        if (contextAppId === app.id && contextIsOpen() && dataUri) {
          $("contextIcon").src = dataUri;
        }
      });
    }
  }

  function openContextMenu(id) {
    var app = findApp(id);
    if (!app) {
      return;
    }
    contextAppId = app.id;
    contextReturnAppId = app.id;
    selectedAppId = app.id;
    resetContextConfirm();
    updateContextMenu();
    $("contextScrim").hidden = false;
    refreshUpdates();
    setTimeout(function () {
      focusElement($("contextOpen"));
    }, 20);
  }

  function closeContextMenu() {
    if (!contextIsOpen()) {
      return;
    }
    $("contextScrim").hidden = true;
    resetContextConfirm();
    var returnId = contextReturnAppId;
    contextAppId = "";
    contextReturnAppId = "";
    if (!holdTargetId) {
      contextAcceptBlockedUntil = 0;
    }
    setTimeout(function () {
      var tile = Array.prototype.find.call(document.querySelectorAll("[data-app-id]"), function (candidate) {
        return candidate.getAttribute("data-app-id") === returnId;
      });
      focusElement(tile || $("launchSelected"));
    }, 20);
  }

  function toggleContextFavorite() {
    selectedAppId = contextAppId;
    toggleFavorite();
    updateContextMenu();
    focusElement($("contextFavorite"));
  }

  function pinContextFavorite() {
    if (!contextAppId) {
      return;
    }
    state.favorites = [contextAppId].concat(state.favorites.filter(function (id) {
      return id !== contextAppId;
    })).slice(0, 30);
    renderHome();
    updateControls();
    hydrateVisibleAssets();
    savePreferences();
    updateContextMenu();
    showToast("Moved to the front of Favorites");
    focusElement($("contextPin"));
  }

  function promptContextUninstall() {
    var app = findApp(contextAppId);
    if (!app || !app.removable || !state.backend) {
      return;
    }
    $("contextActions").hidden = true;
    $("contextConfirm").hidden = false;
    focusElement($("contextCancelUninstall"));
  }

  function uninstallContextApp() {
    var app = findApp(contextAppId);
    if (!app || !app.removable || !state.backend) {
      return;
    }
    var id = app.id;
    $("contextConfirmUninstall").disabled = true;
    lunaCall(SERVICE + "uninstall", { id: id }, 120000)
      .then(function () {
        closeContextMenu();
        showToast(app.title + " was uninstalled");
        return bootstrap(false);
      })
      .catch(function (error) {
        showToast(error.message || "Uninstall failed", true);
      })
      .then(function () {
        $("contextConfirmUninstall").disabled = false;
      });
  }

  function clearTileHoldCue() {
    clearTimeout(holdCueTimer);
    holdCueTimer = null;
    if (holdTileElement) {
      holdTileElement.classList.remove("is-holding");
    }
    holdTileElement = null;
  }

  function beginTileHold(id, tile, source) {
    if (!id || contextIsOpen()) {
      return;
    }
    clearTimeout(holdTimer);
    clearTileHoldCue();
    holdTargetId = id;
    holdSource = source;
    holdOpened = false;
    holdTileElement = tile || Array.prototype.find.call(document.querySelectorAll("[data-app-id]"), function (candidate) {
      return candidate.getAttribute("data-app-id") === id;
    }) || null;
    // A quick click has no progress animation; only an intentional hold gets feedback.
    holdCueTimer = setTimeout(function () {
      holdCueTimer = null;
      if (holdTileElement) holdTileElement.classList.add("is-holding");
    }, 300);
    holdTimer = setTimeout(function () {
      holdOpened = true;
      contextAcceptBlockedUntil = Date.now() + 1800;
      suppressTileClickUntil = Date.now() + 500;
      clearTileHoldCue();
      openContextMenu(holdTargetId);
    }, 650);
  }

  function endTileHold(launchShort) {
    var id = holdTargetId;
    var opened = holdOpened;
    clearTimeout(holdTimer);
    holdTimer = null;
    holdTargetId = "";
    holdSource = "";
    clearTileHoldCue();
    if (launchShort && id && !opened) {
      selectedAppId = id;
      launchApp(id);
    }
    if (opened) {
      contextAcceptBlockedUntil = Date.now() + 240;
      suppressTileClickUntil = Date.now() + 500;
    }
    holdOpened = false;
  }

  function handleBack() {
    if (holdTargetId && !holdOpened) endTileHold(false);
    if (contextIsOpen()) {
      if (!$("contextConfirm").hidden) {
        resetContextConfirm();
        focusElement($("contextUninstall"));
      } else {
        closeContextMenu();
      }
      return;
    }

    if (state.view !== "home") {
      setView("home", true);
      return;
    }
    try {
      window.close();
    } catch (error) {
      return;
    }
  }

  function bindEvents() {
    document.addEventListener("click", function (event) {
      if (contextIsOpen() &&
          Date.now() < contextAcceptBlockedUntil &&
          event.target.closest("#contextScrim")) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    }, true);

    document.addEventListener("click", function (event) {
      var viewButton = event.target.closest("[data-view-target]");
      var tile = event.target.closest("[data-app-id]");
      var input = event.target.closest("[data-input-app-id]");
      var filter = event.target.closest("[data-app-filter]");
      var density = event.target.closest("[data-density]");

      if (viewButton) {
        setView(viewButton.getAttribute("data-view-target"), true);
      } else if (tile) {
        if (Date.now() < suppressTileClickUntil) {
          event.preventDefault();
          return;
        }
        selectApp(tile.getAttribute("data-app-id"));
        launchSelected();
      } else if (input) {
        launchApp(input.getAttribute("data-input-app-id"));
      } else if (filter) {
        setFilter(filter.getAttribute("data-app-filter"));
      } else if (density) {
        state.preferences.density = density.getAttribute("data-density");
        renderAll();
        savePreferences();
      }
    });

    document.addEventListener("contextmenu", function (event) {
      var tile = event.target.closest("[data-app-id]");
      if (!tile) {
        return;
      }
      event.preventDefault();
      openContextMenu(tile.getAttribute("data-app-id"));
    });

    document.addEventListener("pointerdown", function (event) {
      var tile = event.target.closest("[data-app-id]");
      if (tile && (event.button === undefined || event.button === 0)) {
        beginTileHold(tile.getAttribute("data-app-id"), tile, "pointer");
      }
    });

    ["pointerup", "pointercancel"].forEach(function (name) {
      document.addEventListener(name, function () {
        if (holdSource === "pointer") {
          endTileHold(false);
        }
      });
    });

    document.addEventListener("pointerout", function (event) {
      if (holdSource === "pointer" && holdTileElement &&
          holdTileElement.contains(event.target) && !holdTileElement.contains(event.relatedTarget)) {
        endTileHold(false);
      }
    });

    window.addEventListener("blur", function () { endTileHold(false); });
    document.addEventListener("visibilitychange", function () {
      endTileHold(false);
      if (!document.hidden) { hideLaunchCursor(); refreshAppCatalog(); }
    });

    document.addEventListener("focusin", function (event) {
      var tile = event.target.closest("[data-app-id]");
      if (holdTargetId && !holdOpened && tile !== holdTileElement) endTileHold(false);
      if (tile) {
        selectApp(tile.getAttribute("data-app-id"));
      }
    });

    $("launchSelected").addEventListener("click", launchSelected);
    $("favoriteSelected").addEventListener("click", toggleFavorite);
    $("appsFavoriteToggle").addEventListener("click", toggleFavorite);
    $("refreshButton").addEventListener("click", function () { bootstrap(true); });

    $("stockHomeRailButton").addEventListener("click", function () { launchApp("com.webos.app.home"); });
    $("stockHomeButton").addEventListener("click", function () { launchApp("com.webos.app.home"); });
    $("tvSettingsButton").addEventListener("click", function () { launchApp("com.palm.app.settings"); });
    $("homebrewButton").addEventListener("click", function () { launchApp("org.webosbrew.hbchannel"); });
    $("contextClose").addEventListener("click", closeContextMenu);
    $("contextOpen").addEventListener("click", function () {
      var id = contextAppId;
      closeContextMenu();
      launchApp(id);
    });
    $("contextFavorite").addEventListener("click", toggleContextFavorite);
    $("contextPin").addEventListener("click", pinContextFavorite);
    $("contextUpdate").addEventListener("click",function(){var id=contextAppId;lunaCall(SERVICE+"openAppUpdate",{id:id},15000).then(closeContextMenu).catch(function(error){showToast(error.message,true);});});
    $("contextUninstall").addEventListener("click", promptContextUninstall);
    $("contextCancelUninstall").addEventListener("click", function () {
      resetContextConfirm();
      focusElement($("contextUninstall"));
    });
    $("contextConfirmUninstall").addEventListener("click", uninstallContextApp);
    $("contextScrim").addEventListener("click", function (event) {
      if (event.target === $("contextScrim")) {
        closeContextMenu();
      }
    });

    $("stubsToggle").addEventListener("click", function () {
      state.preferences.showStubs = $("stubsToggle").getAttribute("aria-checked") !== "true";
      renderAll();
      savePreferences();
    });

    document.addEventListener("keydown", function (event) {
      var checkbox = event.target.tagName === "INPUT" && event.target.type === "checkbox";
      if (checkbox && event.keyCode === 13) { event.preventDefault(); event.target.click(); return; }
      var editing = !checkbox && /^(INPUT|SELECT|TEXTAREA)$/.test(event.target.tagName);
      if (editing && event.keyCode !== 27 && event.keyCode !== 461) return;
      var acceptKey = event.keyCode === 13 || event.keyCode === 32;
      if (acceptKey && contextIsOpen() && Date.now() < contextAcceptBlockedUntil) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      var activeTile = document.activeElement && document.activeElement.closest
        ? document.activeElement.closest("[data-app-id]")
        : null;
      if (acceptKey && activeTile && !contextIsOpen()) {
        event.preventDefault();
        event.stopPropagation();
        if (!tileAcceptPressed && !event.repeat) {
          tileAcceptPressed = true;
          beginTileHold(activeTile.getAttribute("data-app-id"), activeTile, "key");
        }
        return;
      }
      var direction = {
        37: "left",
        38: "up",
        39: "right",
        40: "down"
      }[event.keyCode];
      if (direction) {
        event.preventDefault();
        event.stopPropagation();
        var now = Date.now();
        if (event.repeat && direction === lastDirection && now - lastDirectionAt < 16) {
          return;
        }
        lastDirection = direction;
        lastDirectionAt = now;
        moveFocus(direction);
        return;
      }
      if (event.keyCode === 461 || event.keyCode === 8 || event.keyCode === 27) {
        event.preventDefault();
        event.stopPropagation();
        handleBack();
      }
    }, true);

    document.addEventListener("keyup", function (event) {
      if ((event.keyCode === 13 || event.keyCode === 32) && tileAcceptPressed) {
        event.preventDefault();
        event.stopPropagation();
        tileAcceptPressed = false;
        suppressTileClickUntil = Date.now() + 320;
        endTileHold(true);
      }
    }, true);
  }

  function startGamepadLoop() {
    var lastAction = 0;
    var held = {};
    var acceptWasPressed = false;
    var acceptTargetId = "";

    function tick() {
      var pads = navigator.getGamepads ? navigator.getGamepads() : [];
      var pad = pads && pads[0];
      var now = Date.now();
      if (pad && !document.hidden) {
        var acceptPressed = !!(pad.buttons[0] && pad.buttons[0].pressed);
        if (acceptPressed && !acceptWasPressed) {
          acceptWasPressed = true;
          var tile = document.activeElement && document.activeElement.closest
            ? document.activeElement.closest("[data-app-id]")
            : null;
          acceptTargetId = tile ? tile.getAttribute("data-app-id") : "";
          if (acceptTargetId) {
            beginTileHold(acceptTargetId, tile, "gamepad");
          }
        } else if (!acceptPressed && acceptWasPressed) {
          if (acceptTargetId && holdTargetId === acceptTargetId) {
            endTileHold(true);
          } else if (!acceptTargetId &&
                     Date.now() >= contextAcceptBlockedUntil &&
                     document.activeElement) {
            document.activeElement.click();
          }
          acceptWasPressed = false;
          acceptTargetId = "";
        }

        var actions = [
          { key: "up", pressed: pad.buttons[12] && pad.buttons[12].pressed || pad.axes[1] < -0.65, run: function () { moveFocus("up"); } },
          { key: "down", pressed: pad.buttons[13] && pad.buttons[13].pressed || pad.axes[1] > 0.65, run: function () { moveFocus("down"); } },
          { key: "left", pressed: pad.buttons[14] && pad.buttons[14].pressed || pad.axes[0] < -0.65, run: function () { moveFocus("left"); } },
          { key: "right", pressed: pad.buttons[15] && pad.buttons[15].pressed || pad.axes[0] > 0.65, run: function () { moveFocus("right"); } },
          { key: "back", pressed: pad.buttons[1] && pad.buttons[1].pressed, run: handleBack }
        ];
        actions.forEach(function (action) {
          if (action.pressed && !held[action.key] && now - lastAction > 130) {
            held[action.key] = true;
            lastAction = now;
            action.run();
          } else if (!action.pressed) {
            held[action.key] = false;
          }
        });
      } else {
        if (holdSource === "gamepad") endTileHold(false);
        acceptWasPressed = false;
        acceptTargetId = "";
        held = {};
      }
      window.requestAnimationFrame(tick);
    }
    window.requestAnimationFrame(tick);
  }

  function hideLaunchCursor() {
    if (document.hidden) return;
    var system = window.webOSSystem || window.PalmSystem;
    // One-shot native hide: the remote's next shake can restore the normal pointer.
    if (system && system.cursor && typeof system.cursor.hide === "function") {
      try { system.cursor.hide(); } catch (error) { console.warn("Cursor hide unavailable", error); }
    }
  }

  function init() {
    hideLaunchCursor();
    $("openCore").addEventListener("click",function(){lunaCall(APP_MANAGER+"launch",{id:"org.unknown.core"}).catch(function(error){showToast(error.message,true);});});
    window.UnknownHomeModuleHost = {
      call: function (method, payload) { return lunaCall(SERVICE + method, payload, 70000); },
      focus: focusElement,
      toast: showToast
    };
    if (window.UnknownHomeModules) window.UnknownHomeModules.init(window.UnknownHomeModuleHost);
    bindEvents();
    updateClock();
    setInterval(updateClock, 30000);
    startGamepadLoop();
    bootstrap(false).then(function () {
      setView("home", false);
      setTimeout(function () {
        focusElement($("launchSelected"));
      }, 60);
    });
  }

  document.addEventListener("webOSRelaunch", function () {
    endTileHold(false);
    tileAcceptPressed = false;
    if (contextIsOpen()) {
      closeContextMenu();
    }
    window.focus();
    setView("home", false);
    window.requestAnimationFrame(function () {
      focusElement($("launchSelected"));
    });
    if (window.PalmSystem && typeof window.PalmSystem.activate === "function") {
      try {
        window.PalmSystem.activate();
      } catch (error) {
        console.warn("Unknown Home could not reactivate its card", error);
      }
    }
    hideLaunchCursor();
    refreshAppCatalog();
  });
  document.addEventListener("DOMContentLoaded", init);
}());
