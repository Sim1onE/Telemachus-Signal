$(document).ready(function () {
    // API Mapping: Friendly Name -> Telemachus Key
    const telemetryMap = {
        vName: "v.name",
        met: "v.missionTime",
        situation: "v.situation",
        stage: "v.stage",
        mass: "v.mass",
        partCount: "v.partCount",
        
        // Resources
        lf: "r.resource[LiquidFuel]",
        lfMax: "r.resourceMax[LiquidFuel]",
        ox: "r.resource[Oxidizer]",
        oxMax: "r.resourceMax[Oxidizer]",
        mp: "r.resource[MonoPropellant]",
        mpMax: "r.resourceMax[MonoPropellant]",
        xe: "r.resource[XenonGas]",
        xeMax: "r.resourceMax[XenonGas]",
        ec: "r.resource[ElectricCharge]",
        ecMax: "r.resourceMax[ElectricCharge]",
        
        // Kerbalism Resources
        food: "r.resource[Food]",
        foodMax: "r.resourceMax[Food]",
        water: "r.resource[Water]",
        waterMax: "r.resourceMax[Water]",
        oxy: "r.resource[Oxygen]",
        oxyMax: "r.resourceMax[Oxygen]",
        nitro: "r.resource[Nitrogen]",
        nitroMax: "r.resourceMax[Nitrogen]",
        
        // Kerbalism Specifics
        kAvailable: "kerbalism.available",
        kLinked: "kerbalism.connectionLinked",
        kRate: "kerbalism.connectionRate",
        kTransmitting: "kerbalism.connectionTransmitting",
        kDriveCap: "kerbalism.drivesCapacity",
        kDriveFree: "kerbalism.drivesFreeSpace",
        kEnvTemp: "kerbalism.envTemperature",
        kEnvRad: "kerbalism.radiation",
        kCo2: "kerbalism.co2Level",
        kHabPres: "kerbalism.habitatPressure",
        kHabComf: "kerbalism.habitatComfort",
        kHabRad: "kerbalism.habitatRadiation",
        kCrew: "kerbalism.crew",
        
        ut: "t.universalTime"
    };

    // Construct Query String
    const apiQuery = Object.entries(telemetryMap)
        .map(([key, val]) => `${key}=${val}`)
        .join('&');

    let rawData = [{}];

    // Initialize Polling
    jKSPWAPI.initPoll(apiQuery, 
        function() { /* preUpdate */ },
        function(rawData, d) {
            try {
                updateUI(d);
            } catch (e) {
                console.error("UI Update Error:", e);
            }
        }, 
        rawData
    );

    function updateUI(d) {
        // Vessel Header
        updateText('v-name', d.vName || "SIGNAL LOST");
        updateText('v-missionTime', 'MET: ' + formatMET(d.met));
        updateSituation(d.situation);
        
        // Platform
        updateText('v-stage', d.stage);
        updateText('v-mass', (d.mass || 0).toFixed(2) + " t");
        updateText('v-partCount', d.partCount || 0);

        // Resource Bars
        updateBar('liquidFuel', d.lf, d.lfMax);
        updateBar('oxidizer', d.ox, d.oxMax);
        updateBar('monopropellant', d.mp, d.mpMax);
        updateBar('xenonGas', d.xe, d.xeMax);
        updateBar('electricCharge', d.ec, d.ecMax);
        
        // Kerbalism Supplies
        updateBar('kerbalism-food', d.food, d.foodMax);
        updateBar('kerbalism-water', d.water, d.waterMax);
        updateBar('kerbalism-oxygen', d.oxy, d.oxyMax);
        updateBar('kerbalism-nitrogen', d.nitro, d.nitroMax);

        // Payload / Kerbalism
        const connectionEl = $('#kerbalism-connection');
        if (d.kLinked) {
            connectionEl.text('LINKED').addClass('linked');
        } else {
            connectionEl.text('NO LINK').removeClass('linked');
        }

        updateText('kerbalism-connectionRate', (d.kRate || 0).toFixed(2) + " MB/s");
        updateText('kerbalism-connectionTransmitting', (d.kTransmitting || 0) + " FILES");
        
        updateText('kerbalism-drivesFreeSpace', (d.kDriveFree || 0).toFixed(1) + " MB");
        updateText('kerbalism-drivesCapacity', (d.kDriveCap || 0).toFixed(1) + " MB");
        const drivePerc = (d.kDriveCap > 0) ? ((d.kDriveCap - d.kDriveFree) / d.kDriveCap * 100) : 0;
        $('#bar-kerbalism-drive').css('width', drivePerc + '%');

        updateText('kerbalism-envTemperature', (d.kEnvTemp || 0).toFixed(1) + " K");
        updateText('kerbalism-radiation', (d.kEnvRad || 0).toFixed(3) + " rad/h");
        
        // Stage & Health
        updateText('kerbalism-habitatPressure', (d.kHabPres || 0).toFixed(2) + " atm");
        updateText('kerbalism-co2Level', (d.kCo2 * 100 || 0).toFixed(2) + "%");
        updateText('kerbalism-habitatComfort', (d.kHabComf || 0).toFixed(2));
        updateText('current-ut', 'UT: ' + formatUT(d.ut));

        // Crew
        updateCrew(d.kCrew);
    }

    function updateText(id, val) {
        if (val !== undefined && val !== null) {
            $(`#${id}`).text(val);
        }
    }

    function updateBar(idPrefix, current, max) {
        const perc = (max > 0) ? (current / max * 100) : 0;
        const fill = $(`#bar-${idPrefix}`);
        fill.css('width', perc + '%');
        $(`#val-${idPrefix}`).text((current || 0).toFixed(1));
        
        // Color alerting
        if (perc < 15) {
            fill.css('background-color', 'var(--accent-red)');
        } else if (perc < 30) {
            fill.css('background-color', 'var(--accent-amber)');
        } else {
            fill.css('background-color', ''); // Reset to CSS default
        }
    }

    function updateSituation(sit) {
        if (!sit) return;
        const s = sit.toUpperCase();
        const el = $('#v-situation');
        el.removeClass('landed orbiting escaped');
        if (s.includes('LANDED') || s.includes('SPLASHED')) el.addClass('landed');
        if (s.includes('ORBITING')) el.addClass('orbiting');
        if (s.includes('ESCAPING')) el.addClass('escaped');
        el.text(s);
    }

    function updateCrew(crew) {
        if (!crew) return;
        const container = $('#crew-list');
        container.empty();

        const kerbals = Array.isArray(crew) ? crew : Object.values(crew);
        if (kerbals.length === 0) {
            container.append('<div class="crew-placeholder">NO CREW DETECTED</div>');
            return;
        }

        kerbals.forEach(k => {
            const hp = (k.health || 0) * 100;
            const healthColor = hp < 50 ? 'var(--accent-red)' : (hp < 80 ? 'var(--accent-amber)' : 'var(--accent-green)');
            
            container.append(`
                <div class="crew-card" style="border-left: 3px solid ${healthColor}; padding: 8px; background: rgba(255,255,255,0.03); margin-bottom: 5px;">
                    <div style="display: flex; justify-content: space-between;">
                        <span style="font-weight: bold; font-size: 0.9rem;">${k.name || 'Kerbal'}</span>
                        <span style="color: ${healthColor}; font-size: 0.8rem;">${hp.toFixed(0)}% HP</span>
                    </div>
                    <div style="font-size: 0.7rem; color: var(--text-secondary); display: flex; gap: 10px; margin-top: 3px;">
                        <span>STRESS: ${(k.stress * 100 || 0).toFixed(0)}%</span>
                        <span>RAD: ${(k.radiation || 0).toFixed(1)} rad</span>
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
        return `${d}d, ${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}`;
    }

    function formatUT(s) {
        if (!s) return "0y, 0d, 00:00:00";
        const year = Math.floor(s / (426 * 6 * 3600)) + 1;
        s %= (426 * 6 * 3600);
        const day = Math.floor(s / (6 * 3600)) + 1;
        s %= (6 * 3600);
        return `${year}y, ${day}d, ${jKSPWAPI.formatters.hourMinSec(s)}`;
    }
});
