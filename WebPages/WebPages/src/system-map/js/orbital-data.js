/**
 * SystemOrbitalPositionData (ES6)
 * Handles fetching and caching of orbital data from Telemachus.
 * Powering the premium 3D Map HUD and Orientation Sphere.
 */
class SystemOrbitalPositionData {
    constructor(datalink, options = {}) {
        this.datalink = datalink;
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

    recalculate(msg) {
        if (!this.planetStaticOrbitsFetched) return;

        const data = msg.data || {};
        const type = msg.type;
        const ut = msg.ut || data['t.universalTime'] || data['currentUniversalTime'];

        // v21.8.135: Composite State Persistence (Rigor + Legacy compatibility)
        const store = this.datalink.lastDatalinkData || {};

        // v21.8.185: Monotonic Master Clock Sync
        if (ut) {
            store["currentUniversalTime"] = Math.max(store["currentUniversalTime"] || 0, ut);
        }

        // Ensure reference bodies and legacy structures are always present
        if (data.referenceBodies) {
            store.referenceBodies = Object.assign(store.referenceBodies || {}, data.referenceBodies);
        }

        ["vesselBody", "vesselCurrentPosition", "targetCurrentPosition", "targetName", "targetBody"].forEach(key => {
            if (data[key] !== undefined) store[key] = data[key];
        });

        if (this.options.onRecalculate) {
            try {
                this.options.onRecalculate({
                    type: type,
                    ut: ut,
                    data: store // Pass authorized composite state
                });
            } catch (e) {
                console.error(`[SystemMap] Recalculate Error (${type}):`, e.message);
            }
        }
    }

    handleOrbitMetadata(msg) {
        const data = msg.data;
        if (!data || !data.bodies) return;

        const manifest = data.bodies;
        console.log("[SystemMap] Processing Orbit Metadata Manifest...", data);

        const positionData = this.datalink.lastDatalinkData || {};
        positionData["referenceBodies"] = positionData["referenceBodies"] || {};
        const refBodies = positionData["referenceBodies"];

        // v22.6: Capture Master Meridian Metadata for 60Hz Analytical Alignment
        // This allows the formatter to extrapolate house-of-cards rotations between server ticks.
        if (data.initialMeridianOffset !== undefined) {
            positionData["initialMeridianOffset"] = data.initialMeridianOffset;
            positionData["meridianRotationSpeed"] = data.meridianRotationSpeed || 0;
            positionData["meridianSampleUt"] = msg.ut || 0;
        }

        Object.keys(manifest).forEach(bodyName => {
            const body = manifest[bodyName];
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
            store.initialRotation = body.initialRotation || 0;
            store.rotationPeriod = body.rotationPeriod || 0;
            store.rotationalSpeed = body.rotationalSpeed || 0;
            store.rotates = body.rotates || false;
            store.parent = body.parent || null;
            store.color = body.color || null;
        });

        const focusSelector = document.getElementById('focus-selector');
        const toggleContainer = document.getElementById('body-toggles');

        const tree = {};
        const roots = [];
        Object.keys(manifest).forEach(name => {
            const p = manifest[name].parent;
            if (!p) { roots.push(name); return; }
            const parentKey = Object.keys(manifest).find(k => k.toLowerCase() === p.toLowerCase()) || p;
            if (!tree[parentKey]) tree[parentKey] = [];
            tree[parentKey].push(name);
        });

        const flatOrder = [];
        const walk = (name, depth) => {
            flatOrder.push({ name, depth });
            (tree[name] || []).forEach(child => walk(child, depth + 1));
        };
        roots.forEach(r => walk(r, 0));

        if (focusSelector) {
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
                // v22.3.2: Sun now included hierarchically
                const row = document.createElement('div');
                row.className = 'toggle-row';
                row.style.paddingLeft = (depth * 12) + 'px';
                const prefix = depth > 1 ? '↳ ' : (depth === 1 ? '– ' : '');
                row.innerHTML = `<label><input type="checkbox" checked data-body="${name}"> ${prefix}${name.toUpperCase()}</label>`;

                const chk = row.querySelector('input');
                chk.addEventListener('change', (e) => {
                    if (window.SystemMap) {
                        window.SystemMap.bodyToggles[name] = e.target.checked;
                        window.SystemMap.triggerRender();
                    }
                });

                toggleContainer.appendChild(row);
            });
            window.dispatchEvent(new CustomEvent('system-map-ui-ready'));
        }

        if (this.datalink.lastDatalinkData) {
            this.datalink.lastDatalinkData["referenceBodies"] = refBodies;
        }

        this.planetStaticOrbitsFetched = true;
    }

    handleOrbitBatch(msg) {
        if (!this.planetStaticOrbitsFetched) return;
        const batch = msg.data;
        if (!batch) return;

        const type = msg.type;
        const positionData = this.datalink.lastDatalinkData || {};
        positionData.referenceBodies = positionData.referenceBodies || {};

        positionData["currentUniversalTime"] = msg.ut;
        positionData["meridianOffset"] = batch.meridianOffset;

        if (batch.vessel) {
            positionData["o.orbitPatches"] = batch.vessel.patches;
            positionData["vesselBody"] = batch.vessel.body;
            positionData["v.body"] = batch.vessel.body;
            positionData["vesselCurrentPosition"] = { relativePosition: batch.vessel.position };

            const patches = batch.vessel.patches || [];
            if (patches.length > 0) {
                const firstPatch = patches[0];
                positionData['o.sma'] = firstPatch.sma;
                positionData['o.period'] = firstPatch.period;
                positionData['o.eccentricity'] = firstPatch.ecc;
                positionData['o.inclination'] = firstPatch.inc;
                positionData['o.lan'] = firstPatch.lan;
                positionData['o.argumentOfPeriapsis'] = firstPatch.argPe;
                positionData['o.trueAnomaly'] = firstPatch.trueAnomaly || 0;
                positionData['o.m0'] = firstPatch.m0 || 0;
                positionData['o.epoch'] = firstPatch.epoch || 0;
                positionData['o.referenceBody'] = firstPatch.referenceBody;
            }
        }

        if (batch.target) {
            positionData["targetCurrentPosition"] = { relativePosition: batch.target.position };
            positionData["tar.o.orbitPatches"] = batch.target.patches;
            positionData["targetBody"] = batch.target.body;
            positionData["targetName"] = batch.target.name;

            const patches = batch.target.patches || [];
            if (patches.length > 0) {
                const firstPatch = patches[0];
                positionData['tar.o.sma'] = firstPatch.sma;
                positionData['tar.o.period'] = firstPatch.period;
                positionData['tar.o.eccentricity'] = firstPatch.ecc;
                positionData['tar.o.inclination'] = firstPatch.inc;
                positionData['tar.o.lan'] = firstPatch.lan;
                positionData['tar.o.argumentOfPeriapsis'] = firstPatch.argPe;
                positionData['tar.o.trueAnomaly'] = firstPatch.trueAnomaly || 0;
                positionData['tar.o.m0'] = firstPatch.m0 || 0;
                positionData['tar.o.epoch'] = firstPatch.epoch || 0;
                positionData['tar.o.orbitingBody'] = firstPatch.referenceBody;
            }
        }

        if (batch.maneuvers) {
            positionData["o.maneuverNodes"] = batch.maneuvers;
        }

        if (this.datalink.lastDatalinkData) {
            Object.assign(this.datalink.lastDatalinkData, positionData);
        }

        if (this.options.onRecalculate) {
            try {
                this.options.onRecalculate({ type: 'orbit', ut: msg.ut, data: positionData });
            } catch (e) {
                console.error("[SystemMap] Orbit Batch Format Error:", e.message);
            }
        }
    }

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
            't.universalTime', 'v.body', 'v.altitude', 'v.geeForce',
            'tar.name', 'tar.type',
            'n.pitch', 'n.roll', 'n.heading',
            'o.ApA', 'o.PeA', 'o.encounterBody', 'o.encounterTime',
            'astg.nextDestination', 'astg.nextBurnCountdown', 'astg.nextDeltaV',
            'pl.rotationX', 'pl.rotationY', 'pl.rotationZ', 'pl.meridianOffset', 'b.rotationAngle'
        ]);

        if (this.datalink.signalLink) {
            this.datalink.signalLink.on('datalink_update', (msg) => {
                if (msg.type === 'orbit') {
                    this.handleOrbitBatch(msg);
                } else if (msg.type === 'telemetry') {
                    this.recalculate(msg);
                }
            });

            this.datalink.signalLink.on('orbit_metadata', (msg) => this.handleOrbitMetadata(msg));

            this.datalink.signalLink.on('smooth_tick', (msg) => {
                this.recalculate({ ut: msg.ut, data: {} });
            });

            const subscribe = () => {
                this.datalink.signalLink.subscribeOrbit({
                    resolution: this.options.numberOfSegments,
                    maxRate: 10,
                });
            };

            if (this.datalink.signalLink.ws && this.datalink.signalLink.ws.readyState === WebSocket.OPEN) {
                subscribe();
            } else {
                this.datalink.signalLink.on('open', subscribe);
            }
        }
    }
}

window.SystemOrbitalPositionData = SystemOrbitalPositionData;
