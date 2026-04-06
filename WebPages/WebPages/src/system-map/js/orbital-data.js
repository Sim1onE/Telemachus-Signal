/**
 * SystemOrbitalPositionData (ES6)
 * Handles fetching and caching of orbital data from Telemachus.
 * Powering the premium 3D Map HUD and Orientation Sphere.
 */
class SystemOrbitalPositionData {
  constructor(datalink, options = {}) {
    this.datalink = datalink;
    this.timeoutRate = 1000;
    this.mutexTimestamp = null;
    this.rootReferenceBody = null;
    this.options = Object.assign({
      numberOfSegments: 256,
      onRecalculate: null
    }, options);

    this.planetStaticOrbitsFetched = false;
    this.staticOrbitRequestParams = {};
    this.cachedKeplerian = null;
    this.cachedPlanetPaths = {};

    this.initializeDatalink();
  }

  isLocked() {
    return this.mutexTimestamp && this.mutexTimestamp < ((Date.now() / 1000 | 0) + this.timeoutRate);
  }

  mutexLock() { this.mutexTimestamp = Date.now(); }
  mutexUnlock() { this.mutexTimestamp = null; }

  recalculate(data) {
    if (this.isLocked() || !this.planetStaticOrbitsFetched) return;
    this.mutexLock();

    // v21.8.4: Ensure structural integrity for formatter
    data.referenceBodies = data.referenceBodies || (this.datalink.lastDatalinkData ? this.datalink.lastDatalinkData.referenceBodies : {});
    
    // v21.8.10: Preserve previous UT if new data lacks it to prevent flickering (0 values)
    const newUT = data['t.universalTime'] || data['currentUniversalTime'];
    if (newUT) {
        data["currentUniversalTime"] = newUT;
    } else if (this.datalink.lastDatalinkData && this.datalink.lastDatalinkData["currentUniversalTime"]) {
        data["currentUniversalTime"] = this.datalink.lastDatalinkData["currentUniversalTime"];
    }

    // v21.8.20: Persistence-aware merge. Only default to null if it's missing everywhere.
    data["vesselBody"] = data['vesselBody'] || data['v.body'] || (this.datalink.lastDatalinkData ? this.datalink.lastDatalinkData.vesselBody : null);
    data["vesselCurrentPosition"] = data['vesselCurrentPosition'] || (this.datalink.lastDatalinkData ? this.datalink.lastDatalinkData.vesselCurrentPosition : { "relativePosition": null });
    data["targetCurrentPosition"] = data['targetCurrentPosition'] || (this.datalink.lastDatalinkData ? this.datalink.lastDatalinkData.targetCurrentPosition : { "relativePosition": null });

    this.getPositionsAndRecalculate(data);

    // v21.8.2: Always trigger redraw for telemetry updates (pitch, roll, altitude)
    if (this.options.onRecalculate) {
        try {
            this.options.onRecalculate(data);
        } catch (e) {
            // Silently skip if render state is incomplete, but log critical errors
            if (data.referenceBodies && data.referenceBodies["Kerbin"]) {
                console.error("[SystemMap] Format Error:", e.message);
            }
        }
    }
  }

  getPositionsAndRecalculate(positionData) {
    // v21.8: Metadata is now pushed automatically via 'orbit_metadata' stream.
    this.mutexUnlock();
  }

  /**
   * v21.8: Handles the automatic push of all celestial body metadata.
   */
  handleOrbitMetadata(msg) {
    const manifest = msg.data;
    if (!manifest) return;

    console.log("[SystemMap] Processing Orbit Metadata Manifest...");
    
    // v21.8.19: Sync the client's body registry with authoritative server data
    if (this.datalink.updateOrbitalBodies) {
        this.datalink.updateOrbitalBodies(manifest);
    }
    
    // v21.8.20: Direct In-Place Update (Avoids 'only a getter' crash)
    const positionData = this.datalink.lastDatalinkData;
    positionData["referenceBodies"] = positionData["referenceBodies"] || {};
    const refBodies = positionData["referenceBodies"];

    Object.keys(manifest).forEach(bodyName => {
        const body = manifest[bodyName];
        // v21.8.20: Additive Merge (keep currentTruePosition if already exists)
        const store = this.ensurePath(refBodies, body.name);
        
        store.radius = body.radius;
        store.sma = body.sma;
        store.eccentricity = body.ecc;
        store.inclination = body.inc;
        store.argPe = body.argPe;
        store.lan = body.lan;
        store.period = body.period;
        store.m0 = body.m0;
        store.epoch = body.epoch;
        store.parent = body.parent || null;
        
        console.debug(`[SystemMap] Synced metadata for ${body.name} (parent: ${body.parent || 'root'})`);
    });

    // v21.8.19: Dynamic Hierarchical UI Population
    const focusSelector = document.getElementById('focus-selector');
    const toggleContainer = document.getElementById('body-toggles');

    // Build a tree: { parentName: [childName, ...] }
    const tree = {};
    const roots = []; // bodies with no parent (the Sun)
    Object.keys(manifest).forEach(name => {
        const p = manifest[name].parent;
        if (!p) { roots.push(name); return; }
        // Use normalized parent name for tree mapping
        const parentKey = Object.keys(manifest).find(k => k.toLowerCase() === p.toLowerCase()) || p;
        if (!tree[parentKey]) tree[parentKey] = [];
        tree[parentKey].push(name);
    });

    // Recursive helper to build ordered list for selectors
    const flatOrder = [];
    const walk = (name, depth) => {
        flatOrder.push({ name, depth });
        (tree[name] || []).forEach(child => walk(child, depth + 1));
    };
    roots.forEach(r => walk(r, 0));

    if (focusSelector) {
        // Keep Vessel option, clear the rest
        while (focusSelector.options.length > 1) focusSelector.remove(1);

        flatOrder.forEach(({ name, depth }) => {
            const opt = document.createElement('option');
            opt.value = name;
            opt.textContent = '\u00a0'.repeat(depth * 3) + name.toUpperCase();
            focusSelector.appendChild(opt);
        });

        focusSelector.addEventListener('change', (e) => {
            if (window.SystemMap) {
                window.SystemMap.GUIParameters.focusBody = e.target.value;
                window.SystemMap.resetPosition();
            }
        });
    }

    if (toggleContainer) {
        toggleContainer.innerHTML = '';

        flatOrder.forEach(({ name, depth }) => {
            if (name === 'Sun') return;
            const row = document.createElement('div');
            row.className = 'toggle-row';
            row.style.paddingLeft = (depth * 12) + 'px';
            const prefix = depth > 1 ? '↳ ' : (depth === 1 ? '– ' : '');
            row.innerHTML = `<label><input type="checkbox" checked data-body="${name}"> ${prefix}${name.toUpperCase()}</label>`;
            toggleContainer.appendChild(row);
        });

        window.dispatchEvent(new CustomEvent('system-map-ui-ready'));
    }

    if (this.datalink.lastDatalinkData) {
        this.datalink.lastDatalinkData["referenceBodies"] = refBodies;
    }

    this.planetStaticOrbitsFetched = true;
    console.log("[SystemMap] All celestial metadata live.");
  }

  /**
   * v21.8: WebSocket handler for the new Batch Orbit API.
   */
  handleOrbitBatch(msg) {
    if (!this.planetStaticOrbitsFetched) return;
    const batch = msg.data;
    if (!batch) return;

    // v21.8.20: Direct In-Place Update of the canonical store.
    // This fixed the "looping/flickering" where data was lost every frame.
    const positionData = this.datalink.lastDatalinkData;
    positionData.referenceBodies = positionData.referenceBodies || {};

    if (batch.bodyPositions) {
        const refKeys = Object.keys(positionData.referenceBodies);
        Object.keys(batch.bodyPositions).forEach(rawName => {
            const key = refKeys.find(k => k.toLowerCase() === rawName.toLowerCase()) || rawName;
            if (!positionData.referenceBodies[key]) positionData.referenceBodies[key] = {};
            positionData.referenceBodies[key].currentTruePosition = batch.bodyPositions[rawName];
        });
    }

    if (batch.bodyRotations) {
        Object.keys(batch.bodyRotations).forEach(rawName => {
            const refKeys = Object.keys(positionData.referenceBodies);
            const key = refKeys.find(k => k.toLowerCase() === rawName.toLowerCase()) || rawName;
            if (positionData.referenceBodies[key]) {
                positionData.referenceBodies[key].rotationAngle = batch.bodyRotations[rawName];
            }
        });
    }

    positionData["currentUniversalTime"] = msg.ut;

    // 1. Map Vessel
    if (batch.vessel && batch.vessel.length > 0) {
        this.mapBatchToLegacy(batch.vessel, positionData, "vesselCurrentOrbit");
        
        const firstPatch = batch.vessel[0];
        // v21.8.19: Map vesselBody from patch referenceBody so formatter can compute rootOrigin
        if (firstPatch.referenceBody) {
            positionData["vesselBody"] = firstPatch.referenceBody;
            positionData["v.body"] = firstPatch.referenceBody;
        }
        if (firstPatch.points && firstPatch.points.length > 0) {
            const pt = firstPatch.points[0];
            positionData["vesselCurrentPosition"] = { relativePosition: { x: pt.x, y: pt.y, z: pt.z } };
        }
    }

    // 2. Map Target
    if (batch.target && batch.target.patches) {
        positionData["tar.name"] = batch.target.name;
        this.mapBatchToLegacy(batch.target.patches, positionData, "targetCurrentOrbit");

        const firstPatch = batch.target.patches[0];
        if (firstPatch.points && firstPatch.points.length > 0) {
            const pt = firstPatch.points[0];
            positionData["targetCurrentPosition"] = { relativePosition: { x: pt.x, y: pt.y, z: pt.z } };
        }
    }

    // 3. Map Maneuvers
    if (batch.maneuvers) {
        batch.maneuvers.forEach((m, idx) => {
            if (m.patches) {
                this.mapBatchToLegacy(m.patches, positionData, `vesselManeuverNodes[${idx}]`, true);
            }
        });
    }

    // bodyPositions already mapped case-insensitively above (v21.8.19 block)

    // Persist to global store
    if (this.datalink.lastDatalinkData) {
        Object.assign(this.datalink.lastDatalinkData, positionData);
    }

    if (this.options.onRecalculate) {
        try {
            this.options.onRecalculate(positionData);
        } catch (e) {
            console.error("[SystemMap] Orbit Batch Format Error:", e.message);
        }
    }
  }

  mapBatchToLegacy(patches, positionData, prefix, isManeuver = false) {
    patches.forEach((p, pIdx) => {
        const targetStore = isManeuver ? 
            this.ensurePath(positionData, prefix, 'orbitPatches', pIdx, 'positionData') :
            this.ensurePath(positionData, prefix, pIdx, 'positionData');

        const referenceBody = p.referenceBody;
        const refStore = this.ensurePath(positionData, "referenceBodies", referenceBody, "positionData");

        const step = (p.endUT - p.startUT) / (p.points.length - 1);

        p.points.forEach((pt, i) => {
            const ut = p.startUT + (step * i);
            const utKey = ut.toFixed(7);
            targetStore[utKey] = { relativePosition: { x: pt.x, y: pt.y, z: pt.z } };

            if (p.refBodyPoints && p.refBodyPoints[i]) {
                const rpt = p.refBodyPoints[i];
                // Allow [0,0,0] if it's the anchor point (i == 0)
                if (i === 0 || rpt.x !== 0 || rpt.y !== 0 || rpt.z !== 0) {
                    refStore[utKey] = { truePosition: { x: rpt.x, y: rpt.y, z: rpt.z } };
                    
                    // v21.8.19: DONT overwrite currentTruePosition here.
                    // Authoritative absolute positions now come from batch.bodyPositions.
                    // Overwriting here with rpt (relative to vessel root) breaks origin-shifting for children.
                }
            }
        });
    });

    // Ensure root body (Sun) is anchored
    if (positionData.referenceBodies && positionData.referenceBodies["Sun"]) {
        positionData.referenceBodies["Sun"].currentTruePosition = positionData.referenceBodies["Sun"].currentTruePosition || { x: 0, y: 0, z: 0 };
    }
  }

  /**
   * Safe object path navigation utility.
   */
  ensurePath(obj, ...parts) {
    let current = obj;
    for (const part of parts) {
      if (current[part] === undefined) {
        current[part] = {};
      }
      current = current[part];
    }
    return current;
  }

  initializeDatalink() {
    this.datalink.subscribeToData([
      't.universalTime', 'v.body',
      'tar.name', 'tar.type', 'tar.o.orbitingBody',
      'o.maneuverNodes',
      'v.altitude', 'o.ApA', 'o.PeA', 'o.inclination',
      'o.eccentricity', 'o.period',
      'n.pitch', 'n.roll', 'n.heading',
      'o.encounterBody', 'o.encounterTime',
      'astg.nextDestination', 'astg.nextBurnCountdown', 'astg.nextDeltaV'
    ]);

    if (this.datalink.signalLink) {
        this.datalink.signalLink.on('orbit', (msg) => this.handleOrbitBatch(msg));
        this.datalink.signalLink.on('orbit_metadata', (msg) => this.handleOrbitMetadata(msg));
        
        const subscribe = () => {
             this.datalink.signalLink.subscribeOrbit({ resolution: this.options.numberOfSegments });
        };

        if (this.datalink.signalLink.ws && this.datalink.signalLink.ws.readyState === WebSocket.OPEN) {
            subscribe();
        } else {
            this.datalink.signalLink.on('open', subscribe);
        }
    }

    this.datalink.addReceiverFunction(this.recalculate.bind(this));
  }
}

window.SystemOrbitalPositionData = SystemOrbitalPositionData;
