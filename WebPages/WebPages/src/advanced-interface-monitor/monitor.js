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

        // C2: Sensors & Science
        sciC: "sci.count", sciD: "sci.dataAmount",
        sT: "s.sensor.temp", sP: "s.sensor.pres", sG: "s.sensor.grav", sA: "s.sensor.acc",

        // C2: Kerbalism Life Support
        kVol: "kerbalism.habitatVolume", kPres: "kerbalism.habitatPressure", kCo2: "kerbalism.co2Level",
        kShield: "kerbalism.radiationShielding", kComf: "kerbalism.habitatComfort", kRad: "kerbalism.radiation",
        kStel: "kerbalism.stellarStormInProgress", kCrew: "kerbalism.crew",

        // C2: Kerbalism Drives
        kDrF: "kerbalism.drivesFreeSpace", kDrC: "kerbalism.drivesCapacity",
        kRate: "kerbalism.connectionRate", kXmit: "kerbalism.connectionTransmitting",

        // C2: Thermal
        tHName: "therm.hottestPartName", tHTemp: "therm.hottestPartTempKelvin", tHMax: "therm.hottestPartMaxTemp",
        tETemp: "therm.hottestEngineTemp", tEOver: "therm.anyEnginesOverheating", tFlux: "therm.heatShieldFlux",

        // C3: Propulsion & Staging
        fThr: "f.throttle", dvReady: "dv.ready", dvStages: "dv.stages", vCurStage: "v.currentStage",

        // Global
        ut: "t.universalTime"
    };

    const apiQuery = Object.entries(tMap).map(([key, val]) => `${key}=${val}`).join('&');

    jKSPWAPI.initPoll(apiQuery,
        function () { },
        function (rawData, d) {
            try { updateUI(d); } catch (e) { console.error("Update failed:", e); }
        },
        [{}]
    );


    function updateMeters(data) {
        // Logarithmic Altitude Meter (0 to 250,000m)
        const alt = Math.max(0, parseFloat(data.vAlt) || 0);
        const altMaxLog = Math.log10(250000 + 1);
        const altLog = Math.log10(alt + 1);
        const altPerc = (altLog / altMaxLog) * 100;
        $('#alt-pointer').css('bottom', Math.min(100, altPerc) + '%');
        $('#v-alt').text(vFmt(alt / 1000, 1)); // Show in km

        // Logarithmic Orbital Speed Meter (0 to 3,000 m/s)
        const spd = Math.max(0, parseFloat(data.vObtSpd) || 0);
        const spdMaxLog = Math.log10(3000 + 1);
        const spdLog = Math.log10(spd + 1);
        const spdPerc = (spdLog / spdMaxLog) * 100;
        $('#spd-pointer').css('bottom', Math.min(100, spdPerc) + '%');
        $('#v-srfSpd').text(vFmt(spd, 0));

        // Aerodynamic readouts
        $('#v-mach').text("M " + vFmt(data.vMach, 2));
        $('#v-hgt-terr').text(vFmt(data.vHgtTerr, 1));
        $('#v-hgt-surf').text(vFmt(data.vHgtSurf, 1));
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
        txt('v-met', formatMET(d.vMet));
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

        // C2: Sensors & Science
        txt('sci-count', Number(d.sciC || 0).toFixed(0));
        txt('sci-data', vFmt(d.sciD, 2) + " Mits");

        txt('s-temp', extractSensor(d.sT) + " K");
        txt('s-pres', extractSensor(d.sP) + " kPa");
        txt('s-grav', extractSensor(d.sG) + " m/s²");
        txt('s-acc', extractSensor(d.sA) + " g");

        // C2: Kerbalism Life Support
        txt('k-vol', vFmt(d.kVol, 2) + " m³");
        txt('k-pres', vFmt(d.kPres, 2) + " atm");
        updateBar('co2', d.kCo2 * 100, 100, true);
        txt('k-shield', vFmt(d.kShield * 100, 0) + "%");
        txt('k-comf', vFmt(d.kComf, 2));
        txt('k-rad', vFmt(d.kRad, 3) + " rad/h");
        led('led-storm', d.kStel, 'red', false);

        // Crew Health
        updateCrewHealth(d.kCrew);

        // C2: Kerbalism Drives
        txt('k-drFree', vFmt(d.kDrF, 1));
        txt('k-drCap', vFmt(d.kDrC, 1));
        let drPerc = (d.kDrC > 0) ? ((d.kDrC - d.kDrF) / d.kDrC * 100) : 0;
        updateBarRaw('drive', drPerc, vFmt(drPerc, 0) + "%");
        txt('k-drRate', vFmt(d.kRate, 3) + " MB/s");
        txt('k-xmit', String(d.kXmit || 0));

        // C2: Thermal
        txt('t-hName', d.tHName || "-");
        txt('t-hTemp', vFmt(d.tHTemp, 1));
        txt('t-hMax', vFmt(d.tHMax, 1));
        txt('t-eTemp', vFmt(d.tETemp, 1) + " K");
        txt('t-flux', vFmt(d.tFlux, 2) + " kW");
        led('led-overheat', d.tEOver, 'red', false);

        // C3: Propulsion & Staging
        let throttlePerc = vFmt(d.fThr * 100, 0);
        $('#throttle-fill').css('height', throttlePerc + '%');
        txt('throttle-read', String(throttlePerc).padStart(3, '0') + '%');

        updateStages(d.dvStages, d.vCurStage, d.dvReady);

        // Footer
        txt('footer-ut', 'UT: ' + formatUT(d.ut));
        txt('footer-conn', (sigPerc > 0) ? 'STREAM ACTIVE' : 'NO SIGNAL');
    }

    // HELPER FUNCTIONS
    function txt(id, val) { $(`#${id}`).text(val); }
    function vFmt(v, dec = 0) { return Number(v || 0).toFixed(dec); }

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

    function updateStages(stages, curStage, ready) {
        const s = $('#stage-stack');
        if (!ready || !stages || stages.length === 0) {
            if (s.children().length === 0) s.html('<div style="text-align:center; color:var(--text-secondary); margin-top:20px;">INIT DV CALCULATOR...</div>');
            return;
        }
        s.empty();
        let sorted = stages.sort((a, b) => a.stage - b.stage);

        sorted.forEach(st => {
            let act = (st.stage === curStage);

            // Mass-based propellant tracking (Using cache for stable "Max")
            let currentFuel = Math.max(0, st.fuelMass);

            // Update cache with highest seen fuelMass for this stage
            if (!stageMaxFuelCache[st.stage] || currentFuel > stageMaxFuelCache[st.stage]) {
                stageMaxFuelCache[st.stage] = currentFuel;
            }

            let totalFuel = stageMaxFuelCache[st.stage];
            let fuelRatio = (totalFuel > 0.01) ? (currentFuel / totalFuel * 100) : 0;
            fuelRatio = Math.min(100, Math.max(0, fuelRatio));

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

            s.append(`
                <div class="stage-card ${act ? 'active' : ''}">
                    <div class="stage-title">STAGE ${st.stage}</div>
                    <div class="stage-prop-container">
                        <div class="stage-prop-lbl">${fuelLabel}</div>
                        <div class="stage-prop">
                            <div class="stage-prop-fill ${colorClass}" style="width:${fuelRatio}%"></div>
                        </div>
                        <div class="stage-prop-lbl" style="width:80px; text-align:right; font-size:0.6rem;">
                            ${vFmt(currentFuel, 1)} / ${vFmt(totalFuel, 1)} t
                        </div>
                    </div>
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
