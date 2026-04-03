$(document).ready(function () {
    const telemetryMap = {
        // Vessel Core
        vName: "v.name",
        met: "v.missionTime",
        ut: "t.universalTime",
        situation: "v.situation",
        
        // Performance
        vMass: "v.mass",
        vDryMass: "v.dryMass",
        vThrust: "v.thrust",
        vIsp: "v.isp",
        vTwr: "v.twr",
        vGee: "v.geeForce",
        vStage: "v.currentStage",

        // Performance API
        dvReady: "dv.ready",
        dvStages: "dv.stages",

        // Navigation
        nPitch: "n.pitch",
        nRoll: "n.roll",
        nHead: "n.heading",

        // Resources (Units)
        res_lf: "r.resource[LiquidFuel]",
        res_ox: "r.resource[Oxidizer]",
        res_sf: "r.resource[SolidFuel]",
        res_mp: "r.resource[MonoPropellant]",
        res_xe: "r.resource[XenonGas]",
        res_ec: "r.resource[ElectricCharge]",
        res_ecMax: "r.resourceMax[ElectricCharge]",

        // Thermal
        thermName: "therm.hottestPartName",
        thermTemp: "therm.hottestPartTempKelvin",
        thermRatio: "therm.hottestPartTempRatio",
        thermFlux: "v.heatShieldFlux",

        // Environment
        vExtTemp: "v.externalTemperature",
        kEnvRad: "kerbalism.radiation",
        kStellarAct: "kerbalism.stellarActivity",
        kHabPres: "kerbalism.habitatPressure",
        kCo2: "kerbalism.co2Level",
        kCrew: "kerbalism.crew",

        // Landing
        landTime: "land.timeToImpact",
        landSuicide: "land.suicideBurnCountdown",
        landSlope: "land.slopeAngle",
        landLat: "land.predictedLat",
        landLon: "land.predictedLon",

        // Comms
        commLinked: "kerbalism.connectionLinked",
        commStrength: "c.signalStrength",
        commDelay: "c.signalDelay"
    };

    const apiQuery = Object.entries(telemetryMap)
        .map(([key, val]) => `${key}=${val}`)
        .join('&');

    let rawData = [{}];

    jKSPWAPI.initPoll(apiQuery, 
        function() {}, 
        function(rawData, d) {
            try {
                updateUI(d);
            } catch (e) {
                console.error("Dashboard update failed:", e);
            }
        }, 
        rawData
    );

    function updateUI(d) {
        // Vessel Identity & Timer
        updateText('v-name', d.vName || "SIGNAL LOST");
        updateText('v-missionTime', formatMET(d.met));
        updateText('footer-ut', 'UT: ' + formatUT(d.ut));
        updateSituation(d.situation);

        // Platform Performance
        updateText('v-thrust', Number(d.vThrust || 0).toFixed(2) + " kN");
        updateText('v-isp', Number(d.vIsp || 0).toFixed(1) + " s");
        updateText('v-twr', Number(d.vTwr || 0).toFixed(2));
        updateText('v-geeForce', Number(d.vGee || 0).toFixed(2) + " G");
        updateText('v-mass', Number(d.vMass || 0).toFixed(2) + " t");

        // Mass Breakdown Bar
        updateMassBar(d);

        // Auxiliary Resources
        updateAuxBar('mp', d.res_mp, 100); // Placeholder max for aux
        updateAuxBar('xe', d.res_xe, 1000);

        // Navigation Gauges
        updateGauge('n-pitch', d.nPitch);
        updateGauge('n-roll', d.nRoll);
        updateGauge('n-heading', d.nHead);

        // Thermal
        updateText('therm-hottestName', d.thermName || "-");
        updateText('therm-hottestTemp', Number(d.thermTemp || 0).toFixed(1) + " K");
        updateText('therm-hottestRatio', Number(d.thermRatio * 100 || 0).toFixed(1) + "%");
        updateText('therm-shieldFlux', Number(d.thermFlux || 0).toFixed(2) + " kW");

        // Environment
        updateText('v-extTemp', Number(d.vExtTemp || 0).toFixed(1) + " K");
        updateText('k-envRad', Number(d.kEnvRad || 0).toFixed(3) + " rad/h");
        updateText('k-stellarAct', Number(d.kStellarAct || 0).toFixed(2));

        // Staging Performance Cards (0->N Order)
        updateStageCards(d.dvStages, d.vStage, d.dvReady);

        // Landing
        updateText('land-time', Number(d.landTime || 0).toFixed(1) + " s");
        updateText('land-suicide', Number(d.landSuicide || 0).toFixed(1) + " s");
        updateText('land-slope', Number(d.landSlope || 0).toFixed(1) + "°");
        updateText('land-coords', `${Number(d.landLat || 0).toFixed(2)}°N, ${Number(d.landLon || 0).toFixed(2)}°E`);

        // Kerbalism & Crew
        updateText('k-habPres', Number(d.kHabPres || 0).toFixed(2) + " atm");
        updateText('k-co2', Number(d.kCo2 * 100 || 0).toFixed(2) + "%");
        updateCrew(d.kCrew);

        const connectionEl = $('#kerbalism-connection');
        if (d.commLinked) {
            connectionEl.text('LINKED').addClass('linked');
        } else {
            connectionEl.text('NO LINK').removeClass('linked');
        }

        // Comms
        updateText('comm-strength', Number(d.commStrength * 100 || 0).toFixed(0) + "%");
        updateText('comm-delay', Number(d.commDelay || 0).toFixed(2) + "s");
    }

    function updateMassBar(d) {
        const total = Number(d.vMass || 0);
        if (total <= 0) return;

        // Approximate Mass Calculation (1 unit = 5kg for LFO, 7.5kg for Solid)
        const liquidMass = (Number(d.res_lf || 0) + Number(d.res_ox || 0)) * 0.005;
        const solidMass = Number(d.res_sf || 0) * 0.0075;
        const dryMass = Math.max(0, total - liquidMass - solidMass);

        const pDry = (dryMass / total * 100).toFixed(1);
        const pLiq = (liquidMass / total * 100).toFixed(1);
        const pSol = (solidMass / total * 100).toFixed(1);

        $('#seg-dry').css('width', pDry + '%');
        $('#seg-liquid').css('width', pLiq + '%');
        $('#seg-solid').css('width', pSol + '%');

        updateText('val-dry', dryMass.toFixed(1));
        updateText('val-liquid', liquidMass.toFixed(1));
        updateText('val-solid', solidMass.toFixed(1));
    }

    function updateStageCards(stages, currentStage, isReady) {
        const container = $('#stage-list');
        if (!isReady || !stages || stages.length === 0) {
            if (container.children('.stage-placeholder').length === 0) {
                container.html('<div class="stage-placeholder" style="color:var(--text-secondary); font-size:0.7rem; text-align:center;">DV CALCULATOR OFFLINE</div>');
            }
            return;
        }

        container.empty();
        
        // Sort Ascending (0 -> N)
        const sortedStages = stages.sort((a, b) => a.stage - b.stage);

        sortedStages.forEach(s => {
            const isActive = s.stage === currentStage;
            const dv = Number(s.deltaVActual || 0).toFixed(0);
            const twr = Number(s.TWRActual || 0);
            
            // Visual Scale for TWR bar (0 to 10 scale)
            const twrPerc = Math.min(100, (twr / 5) * 100);

            container.append(`
                <div class="stage-card ${isActive ? 'active' : ''}">
                    <div class="card-header">
                        <span>STAGE ${s.stage}</span>
                        <span style="font-size:0.6rem; ${isActive ? 'color:var(--accent-green);' : 'color:var(--text-secondary);'}">${isActive ? '● ACTIVE' : '○ READY'}</span>
                    </div>
                    <div class="card-body">
                        <div class="metric-gauge">
                            <span class="gauge-lbl">DELTA-V</span>
                            <span class="gauge-val">${dv}<span style="font-size:0.6rem; color:var(--text-secondary); margin-left:2px;">m/s</span></span>
                        </div>
                        <div class="metric-gauge">
                            <span class="gauge-lbl">TWR</span>
                            <div class="gauge-bar-outer"><div class="gauge-bar-inner twr" style="width:${twrPerc}%"></div></div>
                            <span class="gauge-val" style="font-size:0.8rem;">${twr.toFixed(2)}</span>
                        </div>
                    </div>
                    <div style="display:flex; justify-content:space-between; margin-top:8px; font-size:0.6rem; color:var(--text-secondary);">
                         <span>BURN: ${Number(s.burnTime || 0).toFixed(1)}s</span>
                         <span>DRY: ${Number(s.dryMass || 0).toFixed(1)}t</span>
                    </div>
                </div>
            `);
        });
    }

    function updateText(id, val) {
        $(`#${id}`).text(val);
    }

    function updateAuxBar(id, current, max) {
        const perc = Math.min(100, (current / max * 100));
        $(`#bar-${id}`).css('width', perc + '%');
        $(`#val-${id}`).text(Number(current || 0).toFixed(0));
    }

    function updateGauge(id, val) {
        let v = Number(val || 0).toFixed(1);
        $(`#${id}`).text(v + '°');
    }

    function updateSituation(sit) {
        if (!sit) return;
        const el = $('#v-situation');
        el.removeClass('landed orbiting escaped');
        const s = sit.toUpperCase();
        if (s.includes('LANDED')) el.addClass('landed');
        if (s.includes('ORBITING')) el.addClass('orbiting');
        if (s.includes('ESCAPING')) el.addClass('escaped');
        el.text(s);
    }

    function updateCrew(crew) {
        if (!crew) return;
        const container = $('#crew-list');
        container.empty();
        const kerbals = Array.isArray(crew) ? crew : Object.values(crew);
        kerbals.forEach(k => {
            const hp = Number(k.health || 0) * 100;
            const healthColor = hp < 50 ? 'var(--accent-red)' : (hp < 80 ? 'var(--accent-amber)' : 'var(--accent-green)');
            container.append(`
                <div style="border-left: 2px solid ${healthColor}; padding: 5px; background: rgba(255,255,255,0.02); margin-bottom: 5px; font-size: 0.8rem;">
                    <div style="display:flex; justify-content:space-between;">
                        <span>${k.name}</span>
                        <span style="color:${healthColor}">${hp.toFixed(0)}%</span>
                    </div>
                </div>
            `);
        });
    }

    function formatMET(s) {
        if (!s) return "00:00:00";
        const d = Math.floor(s / 86400);
        s %= 86400;
        const h = Math.floor(s / 3600);
        s %= 3600;
        const m = Math.floor(s / 60);
        const sec = Math.floor(s % 60);
        return `MET: ${d}d, ${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}`;
    }

    function formatUT(s) {
        if (!s) return "0y, 0d, 00:00:00";
        const year = Math.floor(s / (426 * 6 * 3600)) + 1;
        s %= (426 * 6 * 3600);
        const day = Math.floor(s / (6 * 3600)) + 1;
        s %= (6 * 3600);
        const h = Math.floor(s / 3600);
        const m = Math.floor((s % 3600) / 60);
        const sec = Math.floor(s % 60);
        return `${year}y, ${day}d, ${h.toString().padStart(2,'0')}:${m.toString().padStart(2,'0')}:${sec.toString().padStart(2,'0')}`;
    }
});
