// Global cache for stage-specific max fuel to identify the "100%" point
const stageMaxFuelCache = {};

$(document).ready(function () {
    const tMap = {
        // C1: Vessel Status
        vName: "v.name", vType: "v.vesselType", vSit: "v.situationString", vMet: "v.missionTime",
        vCrewC: "v.crewCount", vCrewCap: "v.crewCapacity", vCrew: "v.crew",
        vLanded: "v.landed", vSplashed: "v.splashed", vAct: "v.isActiveVessel", vCtrl: "v.isControllable",

        // C1: Location
        vAlt: "v.altitude", vHgtTerr: "v.heightFromTerrain", vHgtSurf: "v.heightFromSurface",
        vLat: "v.lat", vLon: "v.long", vNorm: "v.terrainNormal",

        // C1: Kinematics
        vSrfSpd: "v.surfaceSpeed", vObtSpd: "v.orbitalVelocity", vVrtSpd: "v.verticalSpeed", vMach: "v.mach", vIas: "v.indicatedAirSpeed",
        vObtX: "v.orbitalVelocityx", vObtY: "v.orbitalVelocityy", vObtZ: "v.orbitalVelocityz",
        vSrfX: "v.surfaceVelocityx", vSrfY: "v.surfaceVelocityy", vSrfZ: "v.surfaceVelocityz",
        vLat: "v.lat", vLon: "v.long", vHgtTerr: "v.heightFromTerrain", vHgtSurf: "v.heightFromSurface",

        // C1: Attitude
        nHdh: "n.heading", nPitch: "n.pitch", nRoll: "n.roll",
        nHeadR: "n.rawheading", nPitchR: "n.rawpitch", nRollR: "n.rawroll",
        vSun: "v.directSunlight", vSunDist: "v.distanceToSun",

        // C1: Comms & Resources
        cSig: "comm.signalStrength", cState: "comm.controlStateName", cDel: "comm.signalDelay",
        rLf: "r.resource[LiquidFuel]", rLfM: "r.resourceMax[LiquidFuel]",
        rOx: "r.resource[Oxidizer]", rOxM: "r.resourceMax[Oxidizer]",
        rSf: "r.resource[SolidFuel]", rSfM: "r.resourceMax[SolidFuel]",
        rMp: "r.resource[MonoPropellant]", rMpM: "r.resourceMax[MonoPropellant]",
        rXe: "r.resource[XenonGas]", rXeM: "r.resourceMax[XenonGas]",
        rEc: "r.resource[ElectricCharge]", rEcM: "r.resourceMax[ElectricCharge]",

        // C2: Map & GNC
        vBody: "v.body", vLat: "v.lat", vLon: "v.long",
        oEcc: "o.eccentricity", oInc: "o.inclination", oAop: "o.argumentOfPeriapsis",
        oTrue: "o.trueAnomaly", oPeA: "o.PeA", oPeR: "o.PeR",
        tarDist: "tar.distance", tarRelVel: "tar.o.relativeVelocity", 
        dockAx: "dock.ax", dockAy: "dock.ay", dockAz: "dock.az",

        // C3: Propulsion & Staging
        fThr: "f.throttle", dvReady: "dv.ready", dvStages: "dv.stages", vCurStage: "v.currentStage",

        // Global
        ut: "t.universalTime"
    };

    // WebSocket Data Stream Integration (v16.33)
    // WebSocket Data Stream Integration (v16.36: Robust detection)
    const streamUrl = TelemachusSignalLink.detectStreamUrl();
    const signalLink = new TelemachusSignalLink(streamUrl);

    signalLink.on('open', () => {
        console.log("[Monitor] Connected to telemetry stream.");
        // Subscribe to all requested keys in tMap
        const keys = Object.values(tMap);
        signalLink.subscribe(keys);
    });

    // Persistent telemetry state to prevent flickering (v16.34)
    const telemetryState = {};

    signalLink.on('status', (status) => {
        // Update persistent metadata (Real-time link info)
        telemetryState.cDel = status.delay;
        telemetryState.cSig = status.quality / 100.0;
        
        updateUI(telemetryState);
    });

    signalLink.on('smooth_tick', (data) => {
        // High-frequency clock updates (v16.35)
        telemetryState.ut = data.ut;
        telemetryState.vMet = data.met;
        telemetryState.footerUt = data.ut;
        
        txt('v-met', formatMET(data.met));
        txt('footer-ut', 'UT: ' + formatUT(data.ut));
    });

    signalLink.on('datalink_update', (data) => {
        // Update persistent telemetry from delayed stream
        telemetryState.ut = data.ut;
        telemetryState.cSig = data.quality / 100.0;
        
        Object.entries(tMap).forEach(([alias, key]) => {
            if (data.values[key] !== undefined) {
                telemetryState[alias] = data.values[key];
            }
        });

        try {
            if (telemetryState.vBody && String(telemetryState.vBody).toLowerCase() !== String(currentBody).toLowerCase()) {
                initLeaflet(telemetryState.vBody);
                currentBody = telemetryState.vBody;
            }
            updateUI(telemetryState);
        } catch (e) {
            console.error("Update failed:", e);
        }
    });

    signalLink.connect();

    // Initial fallback if telemetry hasn't arrived yet
    setTimeout(() => { if (!currentBody) initLeaflet('Kerbin'); }, 1000);

    // Dynamic Leaflet Map Engine
    let map = null;
    let currentBody = null;
    let currentStyle = 'sat';
    let tileLayer = null;
    let vesselMarker = null;
    let isTracking = true;
    const baseUrl = 'https://d3kmnwgldcmvsd.cloudfront.net';

    function initLeaflet(bodyName) {
        if (typeof L === 'undefined') {
            console.error("Leaflet not loaded. Map offline.");
            return;
        }
        const body = bodyName.toLowerCase();
        const mapEl = document.getElementById('leaflet-map');
        if (!mapEl) return;

        if (!map) {
            map = L.map('leaflet-map', {
                crs: L.CRS.EPSG4326,
                zoomControl: true, // Enabled for interactive use
                attributionControl: false,
                dragging: true,
                scrollWheelZoom: true,
                doubleClickZoom: true,
                boxZoom: true
            }).setView([0, 0], 3);

            // Detection for user interaction to pause auto-tracking
            map.on('dragstart zoomstart', function() {
                isTracking = false;
                $('#btn-recenter').fadeIn();
            });
        }

        // Custom Blue HUD Icon
        if (!vesselMarker) {
            const blueHudIcon = L.divIcon({
                className: 'vessel-marker-hud',
                iconSize: [20, 20],
                iconAnchor: [10, 10]
            });
            vesselMarker = L.marker([0, 0], { icon: blueHudIcon }).addTo(map);
        }

        updateTileLayer(body, currentStyle);
        console.log(`[MAP] Body reset: ${body}`);
    }

    function updateTileLayer(body, style) {
        if (tileLayer) map.removeLayer(tileLayer);
        const bodyName = body.toLowerCase();
        const tileUrl = `${baseUrl}/tiles/${bodyName}/${style}/{z}/{x}/{y}.png`;
        
        tileLayer = L.tileLayer(tileUrl, {
            tms: true,
            maxZoom: 7,
            noWrap: false
        });

        tileLayer.on('tileerror', function(error) {
            console.warn(`[MAP] Tile load failed for ${bodyName}/${style}:`, error.url);
        });

        tileLayer.addTo(map);
    }

    // Export functions to global for HTML buttons
    window.setMapStyle = function(style) {
        if (!currentBody) return;
        currentStyle = style;
        updateTileLayer(currentBody, style);
        $('.map-btn').removeClass('active');
        $(`.map-btn:contains(${style.toUpperCase()})`).addClass('active');
    };

    window.recenterMap = function() {
        isTracking = true;
        $('#btn-recenter').fadeOut();
    };


    function updateMeters(data) {
        // Altimeter HUD values
        const alt = parseFloat(data.vAlt) || 0;
        const hgtt = parseFloat(data.vHgtTerr) || 0;
        const hgts = parseFloat(data.vHgtSurf) || 0;

        $('#v-alt').text(vFmt(alt / 1000, 1));
        $('#v-hgt-terr').text(vFmt(hgtt / 1000, 2));
        $('#v-hgt-surf').text(vFmt(hgts / 1000, 2));

        // Aerodynamic readouts
        $('#v-mach').text("M " + vFmt(data.vMach, 2));
        $('#v-ias').text(vFmt(data.vIas, 1) + " m/s");
        $('#v-lat').text(vFmt(data.vLat, 3));
        $('#v-lon').text(vFmt(data.vLon, 3));
    }

    function updateVectors(data) {
        const vScale = 3000; // Max scale for the vector bars
        const groups = [
            { pre: 'obt', keys: ['vObtX', 'vObtY', 'vObtZ'], labels: ['x', 'y', 'z'] },
            { pre: 'srf', keys: ['vSrfX', 'vSrfY', 'vSrfZ'], labels: ['x', 'y', 'z'] }
        ];

        groups.forEach(g => {
            let sumSq = 0;
            g.keys.forEach((key, i) => {
                let val = parseFloat(data[key]) || 0;
                sumSq += val * val;
                let perc = Math.min(100, (Math.abs(val) / vScale) * 100);
                $(`#bar-${g.pre}${g.labels[i]}`).css('width', Math.max(2, perc) + '%');
                $(`#v-${g.pre}-${g.labels[i]}`).text(vFmt(val, 0) + " m/s");
            });
            let mag = Math.sqrt(sumSq);
            $(`#v-${g.pre}-mag`).text(vFmt(mag, 1));
        });
    }

    function updateUI(d) {
        updateMeters(d);
        updateVectors(d);
        // C1: Status
        txt('v-name', String(d.vName || "NO SIGNAL").toUpperCase());
        txt('v-type', d.vType || "-");
        txt('v-situation', d.vSit || "-");
        // txt('v-met', formatMET(d.vMet)); // v16.35: Moved to smooth_tick
        txt('v-crewCount', `${d.vCrewC || 0} / ${d.vCrewCap || 0}`);

        let crewStr = Array.isArray(d.vCrew) ? d.vCrew.join(", ") : "-";
        txt('v-crewNames', crewStr);

        led('led-landed', d.vLanded, 'green');
        led('led-splashed', d.vSplashed, 'cyan');
        led('led-active', d.vAct, 'green');
        led('led-control', d.vCtrl, 'green');

        // C1: Location Readouts (those not in meters)
        txt('v-latlon', `${vFmt(d.vLat, 3)} , ${vFmt(d.vLon, 3)}`);

        if (d.vNorm) {
            txt('v-norm', `x:${vFmt(d.vNorm[0], 2)} y:${vFmt(d.vNorm[1], 2)} z:${vFmt(d.vNorm[2], 2)}`);
        } else {
            txt('v-norm', "x:0 y:0 z:0");
        }

        // C1: Kinematics (those not in meters)
        txt('v-vrtSpd', vFmt(d.vVrtSpd, 1) + " m/s");
        txt('v-ias', vFmt(d.vIas, 1) + " m/s");

        // C1: Attitude
        txt('n-head', vFmt(d.nHdh, 1)); txt('n-rhead', `(${vFmt(d.nHeadR, 1)})`);
        txt('n-pitch', vFmt(d.nPitch, 1)); txt('n-rpitch', `(${vFmt(d.nPitchR, 1)})`);
        txt('n-roll', vFmt(d.nRoll, 1)); txt('n-rroll', `(${vFmt(d.nRollR, 1)})`);

        // C1: Signal & Link Status
        let sig = (parseFloat(d.cSig) || 0) * 100;
        txt('comm-str', vFmt(sig, 0) + "%");
        txt('comm-state', String(d.cState || "NO LINK").toUpperCase());
        
        let txEl = $('#comm-tx');
        if (d.kXmit) {
            txEl.text("ACTIVE").addClass('sig-tx-active').css('color', 'var(--accent-orange)');
        } else {
            txEl.text("IDLE").removeClass('sig-tx-active').css('color', 'var(--text-secondary)');
        }

        txt('comm-delay', vFmt(d.cDel, 2) + "s");

        // Signal Bars logic (5 bars)
        const bars = [1, 2, 3, 4, 5];
        const activeBars = Math.ceil(sig / 20);
        let barClass = "active";
        if (sig < 15) barClass = "crit";
        else if (sig < 50) barClass = "warn";

        bars.forEach(b => {
            let el = $(`#sig-bar-${b}`);
            el.removeClass('active warn crit');
            if (b <= activeBars) el.addClass(barClass);
        });

        // Sun logic
        if (d.vSun) {
            $('#led-sun').addClass('active');
            $('#v-sun-indicator').css('background', 'rgba(255,165,0,0.1)');
        } else {
            $('#led-sun').removeClass('active');
            $('#v-sun-indicator').css('background', 'rgba(0,0,0,0.1)');
        }

        // C1: Resources
        updateBar('liq', d.rLf, d.rLfM);
        updateBar('ox', d.rOx, d.rOxM);
        updateBar('sol', d.rSf, d.rSfM);
        updateBar('mp', d.rMp, d.rMpM);
        updateBar('xe', d.rXe, d.rXeM);
        updateBar('ec', d.rEc, d.rEcM);

        // C2: 2D Orbital Map
        updateMap(d);

        // C2: GNC HUD
        updateGNC(d);

        // C3: Propulsion & Staging
        let throttlePerc = vFmt(d.fThr * 100, 0);
        $('#f-thr').text(throttlePerc + "%");
        $('#throttle-fill').css('height', throttlePerc + '%');
        txt('throttle-read', String(throttlePerc).padStart(3, '0') + '%');
        updateStages(d.dvStages, d.vCurStage, d.dvReady, d.vName);

        // Footer Connection Check
        // txt('footer-ut', 'UT: ' + formatUT(d.ut)); // v16.35: Moved to smooth_tick
        txt('footer-conn', (sig > 0) ? 'STREAM ACTIVE' : 'NO SIGNAL');
    }

    function updateGNC(d) {
        // Distance formatting
        let dist = parseFloat(d.tarDist) || 0;
        let distStr = dist > 10000 ? (vFmt(dist / 1000, 2) + " km") : (vFmt(dist, 1) + " m");
        if (dist === 0) distStr = "--- m";
        $('#gnc-dist').text(distStr);

        // Relative Velocity
        let rVel = parseFloat(d.tarRelVel) || 0;
        let rVelStr = vFmt(rVel, 2) + " m/s";
        if (dist === 0) rVelStr = "--- m/s";
        $('#gnc-rvel').text(rVelStr);

        // Alignment (Only meaningful if targeting a docking port)
        // Check if values are zero which often means no port targeted or perfect alignment
        // (Telemachus returns 0 for docking angles if no port is targeted)
        let hasTarget = dist > 0;
        txt('gnc-ap', hasTarget ? (vFmt(d.dockAx, 1) + "°") : "---°");
        txt('gnc-ay', hasTarget ? (vFmt(d.dockAy, 1) + "°") : "---°");
        txt('gnc-ar', hasTarget ? (vFmt(d.dockAz, 1) + "°") : "---°");

        // Closest Approach / Approach Rate (Placeholders for now as API is limited)
        txt('gnc-app', hasTarget ? "CALC..." : "--- m/s");
        txt('gnc-ca', hasTarget ? "CALC..." : "--- m");
    }

    // HELPER FUNCTIONS
    function txt(id, val) { $(`#${id}`).text(val); }
    function vFmt(v, dec = 0) { 
        let val = parseFloat(v);
        return isNaN(val) ? "0" : val.toFixed(dec); 
    }

    function extractSensor(arr) {
        if (!arr || !Array.isArray(arr) || arr.length < 2) return "0.00";
        let vals = arr[1];
        if (!Array.isArray(vals) || vals.length === 0) return "0.00";
        return vFmt(vals[0], 2);
    }

    function led(id, condition, activeClass, maintainBox = true) {
        const e = $(`#${id}`);
        e.removeClass('green amber red cyan');
        if (condition) {
            e.addClass(activeClass);
        } else if (!maintainBox) {
            e.css('opacity', '0.2');
        } else {
            e.css('opacity', '1');
        }
    }

    function updateBar(id, val, max, isPerc = false) {
        let v = Number(val || 0);
        let m = Number(max || 0);
        let perc = (m > 0) ? (v / m * 100) : 0;
        if (isPerc) { perc = v; }
        $(`#b-${id}`).css('width', perc + '%');
        let dispVal = isPerc ? (v.toFixed(0) + "%") : v.toFixed(0);
        $(`#v-${id}`).text(dispVal);
    }

    function updateBarRaw(id, perc, text) {
        $(`#b-${id}`).css('width', perc + '%');
        $(`#v-${id}`).text(text);
    }

    function updateCrewHealth(crewData) {
        const c = $('#crew-health-list');
        if (!crewData || crewData.length === 0) {
            c.html('<div style="opacity:0.5">- No Crew Data -</div>'); return;
        }
        c.empty();
        crewData.forEach(k => {
            let tr = k.trait ? k.trait.substring(0, 3).toUpperCase() : 'UNK';
            let healthProb = "NOMINAL";
            let color = "var(--accent-green)";
            // Check for kerbalism problems (radiation, stress)
            if (k.radiation && k.radiation !== "") { healthProb = "RAD WARN"; color = "var(--accent-amber)"; }
            if (k.stress && k.stress !== "") { healthProb = "STRESS"; color = "var(--accent-amber)"; }

            c.append(`
                <div style="display:flex; justify-content:space-between; border-left: 2px solid ${color}; padding-left: 5px; margin-bottom:4px; background:rgba(255,255,255,0.02)">
                    <span><b>${k.name}</b> (${tr})</span>
                    <span style="color:${color}">${healthProb}</span>
                </div>
            `);
        });
    }

    function updateStages(stages, curStage, ready, vesselName) {
        const s = $('#stage-stack');
        if (!ready || !Array.isArray(stages) || stages.length === 0) {
            if (s.children().length === 0) s.html('<div style="text-align:center; color:var(--text-secondary); margin-top:20px;">INIT DV CALCULATOR...</div>');
            return;
        }
        s.empty();
        
        // Sort ascending (0, 1, 2, 3...) to process upper stages first
        let sorted = stages.sort((a, b) => a.stage - b.stage);
        
        // Build a lookup map of total fuel masses per stage
        const fuelMap = {};
        sorted.forEach(st => fuelMap[st.stage] = st.fuelMass || 0);

        // Render from highest stage number to lowest (as in the screenshot)
        let displayList = [...sorted].reverse();

        displayList.forEach(st => {
            let act = (st.stage === curStage);

            // ISOLATED FUEL CALCULATION:
            // We subtract the cumulative fuel mass of the next available lower stage (e.g., Stage 6 - Stage 4)
            // to find the propellant specifically isolated in the current booster.
            let nextStageNum = st.stage - 1;
            while (nextStageNum >= 0 && typeof fuelMap[nextStageNum] === 'undefined') {
                nextStageNum--;
            }
            
            let upperStageFuel = (nextStageNum >= 0) ? fuelMap[nextStageNum] : 0;
            let currentFuel = Math.max(0, (st.fuelMass || 0) - upperStageFuel);

            // Hard-zero overrides for spent stages
            if (st.burnTime < 0.1 || currentFuel < 0.05) currentFuel = 0;

            let safeVesselName = String(vesselName || "unknown").replace(/[^a-zA-Z0-9]/g, "_");
            let cacheKey = `maxFuelIso_${safeVesselName}_stage_${st.stage}`;
            let storedMax = parseFloat(localStorage.getItem(cacheKey)) || 0;

            if (currentFuel > storedMax) {
                localStorage.setItem(cacheKey, currentFuel);
                storedMax = currentFuel;
            }

            let totalFuel = storedMax;
            let fuelRatio = (totalFuel > 0.01) ? (currentFuel / totalFuel * 100) : 0;
            if (fuelRatio < 1.0) fuelRatio = 0;
            
            let shadowStyle = (fuelRatio > 0.1) ? '' : 'box-shadow: none !important;';

            // Heuristic Fuel Type Labeling
            let fuelLabel = "PROPELLANT";
            let colorClass = "b-liq";
            if (st.ispVac > 0) {
                if (st.ispVac < 265) {
                    fuelLabel = "SOLID FUEL";
                    colorClass = "b-sol";
                } else if (st.ispVac < 310) {
                    fuelLabel = "SOLID + LIQUID";
                    colorClass = "b-liq";
                } else {
                    fuelLabel = "LIQUID FUEL";
                    colorClass = "b-liq";
                }
            }

            const hasBoost = (st.ispVac > 0.1 || st.thrustActual > 0.1);

            s.append(`
                <div class="stage-card ${act ? 'active' : ''}">
                    <div class="stage-title">STAGE ${st.stage}</div>
                    ${hasBoost ? `
                    <div class="stage-prop-container">
                        <div class="stage-prop-lbl">${fuelLabel}</div>
                        <div class="stage-prop">
                            <div class="stage-prop-fill ${colorClass}" style="width:${fuelRatio}%; ${shadowStyle}"></div>
                        </div>
                        <div class="stage-prop-lbl" style="width:80px; text-align:right; font-size:0.6rem;">
                            ${vFmt(currentFuel, 1)} / ${vFmt(totalFuel, 1)} t
                        </div>
                    </div>
                    ` : ''}
                    <div class="stage-grid">
                        <div class="metric"><div class="lbl">ISP</div><div class="val">${vFmt(st.ispActual, 1)}s</div></div>
                        <div class="metric"><div class="lbl">THRUST</div><div class="val">${vFmt(st.thrustActual, 1)}kN</div></div>
                        <div class="metric"><div class="lbl">TWR</div><div class="val">${vFmt(st.TWRActual, 2)}</div></div>
                        <div class="metric"><div class="lbl">BURN</div><div class="val">${vFmt(st.burnTime, 1)}s</div></div>
                    </div>
                </div>
            `);
        });
    }

    const orbitHistory = [];
    const MAX_HISTORY = 100;

    function updateMap(d) {
        let lat = d.vLat;
        let lon = d.vLon;
        if (!map || isNaN(lat) || isNaN(lon) || !vesselMarker) return;
        
        let latVal = parseFloat(lat);
        let lonVal = parseFloat(lon);
        
        // Leaflet wrap-around logic for longitudes
        let wrappedLon = (lonVal > 180) ? lonVal - 360 : lonVal;
        let latLng = [latVal, wrappedLon];

        // 1. Update Marker Position
        vesselMarker.setLatLng(latLng);

        // 2. Control Map Camera
        if (isTracking) {
            map.panTo(latLng, { animate: true, duration: 0.5 });
        }

        // 3. Sync Canvas Trace
        const canvas = document.getElementById('orbit-canvas');
        if (!canvas) return;

        const w = canvas.clientWidth;
        const h = canvas.clientHeight;
        if (canvas.width !== w || canvas.height !== h) {
            canvas.width = w;
            canvas.height = h;
        }

        const ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, w, h);

        orbitHistory.push({ lat: latVal, lng: wrappedLon });
        if (orbitHistory.length > MAX_HISTORY) orbitHistory.shift();

        // Draw historical trace (faded)
        if (orbitHistory.length > 1) {
            ctx.beginPath();
            ctx.strokeStyle = "rgba(0, 221, 255, 0.15)";
            ctx.lineWidth = 1;
            
            for (let i = 0; i < orbitHistory.length; i++) {
                let pt = map.latLngToContainerPoint([orbitHistory[i].lat, orbitHistory[i].lng]);
                
                if (i > 0) {
                    let prevPt = map.latLngToContainerPoint([orbitHistory[i-1].lat, orbitHistory[i-1].lng]);
                    if (Math.abs(pt.x - prevPt.x) > w * 0.5) {
                        ctx.stroke();
                        ctx.beginPath();
                        ctx.moveTo(pt.x, pt.y);
                        continue;
                    }
                }
                
                if (i === 0) ctx.moveTo(pt.x, pt.y);
                else ctx.lineTo(pt.x, pt.y);
            }
            ctx.stroke();
        }

        // Draw Forward Keplerian Projection
        drawGroundTrack(d, ctx, w, h, map);
    }

    const DEG2RAD = Math.PI / 180;
    const RAD2DEG = 180 / Math.PI;

    function drawGroundTrack(d, ctx, w, h, map) {
        let e = parseFloat(d.oEcc);
        if (isNaN(e)) return; // Orbit data not yet available

        let i = (parseFloat(d.oInc) || 0) * DEG2RAD;
        let w_arg = (parseFloat(d.oAop) || 0) * DEG2RAD;
        let nu_curr = (parseFloat(d.oTrue) || 0) * DEG2RAD;
        
        let PeR = parseFloat(d.oPeR) || 0;
        let PeA = parseFloat(d.oPeA) || 0;
        let currLon = parseFloat(d.vLon);

        if (isNaN(currLon) || isNaN(PeR) || isNaN(PeA)) return; // Integrity check to stop Leaflet crashing

        // Determine planet radius from apsides difference
        let planetR = Math.max(1000, PeR - PeA);
        let p = PeR * (1 + e); // orbital parameter p = a(1-e^2) = PeR(1+e)

        let theta_inertial_curr = Math.atan2(Math.sin(nu_curr + w_arg) * Math.cos(i), Math.cos(nu_curr + w_arg));

        ctx.beginPath();
        ctx.strokeStyle = "rgba(0, 221, 255, 0.8)";
        ctx.lineWidth = 2;
        ctx.setLineDash([5, 5]);

        let crashed = false;
        let crashPt = null;
        let points = [];
        
        let steps = 150;
        let max_nu = e < 1 ? Math.PI * 2 : Math.PI; 
        let step = max_nu / steps;

        let prev_theta_inertial = theta_inertial_curr;
        let acc_dTheta = 0;

        for (let s = 0; s <= steps; s++) {
            let nu = nu_curr + s * step;
            let r = p / (1 + e * Math.cos(nu));
            
            // Check for terrain impact
            if (r <= planetR && s > 0) {
                crashed = true;
            }

            let lat_rad = Math.asin(Math.sin(nu + w_arg) * Math.sin(i));
            let theta_inertial = Math.atan2(Math.sin(nu + w_arg) * Math.cos(i), Math.cos(nu + w_arg));

            let delta = theta_inertial - prev_theta_inertial;
            // Unwrap branch cuts safely
            while (delta > Math.PI) delta -= 2 * Math.PI;
            while (delta < -Math.PI) delta += 2 * Math.PI;
            
            acc_dTheta += delta;
            prev_theta_inertial = theta_inertial;

            let lon_rad = (currLon * DEG2RAD) + acc_dTheta;

            let lat = lat_rad * RAD2DEG;
            let lon = lon_rad * RAD2DEG;
            
            // Normalize longitude
            lon = ((lon + 180) % 360 + 360) % 360 - 180;
            
            points.push({lat: lat, lon: lon, r: r});
            
            if (crashed) break;
        }

        // Draw the projected path
        for (let j = 0; j < points.length; j++) {
            let pt = map.latLngToContainerPoint([points[j].lat, points[j].lon]);
            
            if (j > 0) {
                let prevPt = map.latLngToContainerPoint([points[j-1].lat, points[j-1].lon]);
                // Wrap check across dateline
                if (Math.abs(pt.x - prevPt.x) > w * 0.5) {
                    ctx.stroke();
                    ctx.beginPath();
                    ctx.moveTo(pt.x, pt.y);
                    continue;
                }
            }
            
            if (j === 0) ctx.moveTo(pt.x, pt.y);
            else ctx.lineTo(pt.x, pt.y);
            
            if (j === points.length - 1 && crashed) crashPt = pt;
        }
        ctx.stroke();
        ctx.setLineDash([]);

        // Render Crash Cross
        if (crashed && crashPt) {
            ctx.beginPath();
            ctx.strokeStyle = "red";
            ctx.lineWidth = 3;
            let size = 6;
            ctx.moveTo(crashPt.x - size, crashPt.y - size);
            ctx.lineTo(crashPt.x + size, crashPt.y + size);
            ctx.moveTo(crashPt.x + size, crashPt.y - size);
            ctx.lineTo(crashPt.x - size, crashPt.y + size);
            ctx.stroke();
            
            // Halo glow
            ctx.beginPath();
            ctx.arc(crashPt.x, crashPt.y, size * 2, 0, 2 * Math.PI);
            ctx.strokeStyle = "rgba(255, 0, 0, 0.4)";
            ctx.stroke();
        }
    }

    function formatMET(s) {
        if (!s) return "00:00:00";
        let sign = s < 0 ? "-" : "";
        s = Math.abs(s);
        let d = Math.floor(s / 86400); s %= 86400;
        let h = Math.floor(s / 3600); s %= 3600;
        let m = Math.floor(s / 60); let sec = Math.floor(s % 60);
        return `MET ${sign}${d}d ${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}`;
    }

    function formatUT(s) {
        if (!s) return "0y, 0d, 00:00:00";
        let y = Math.floor(s / (426 * 6 * 3600)) + 1; s %= (426 * 6 * 3600);
        let d = Math.floor(s / (6 * 3600)) + 1; s %= (6 * 3600);
        let h = Math.floor(s / 3600); let m = Math.floor((s % 3600) / 60); let sec = Math.floor(s % 60);
        return `${y}y, ${d}d, ${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}`;
    }
});
