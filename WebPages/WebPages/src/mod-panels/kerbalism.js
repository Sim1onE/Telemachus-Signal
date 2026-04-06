/* KERBALISM SYSTEMS MONITOR - COMPLETE TELEMETRY (v16.44) */
$(document).ready(function() {
    const streamUrl = TelemachusSignalLink.detectStreamUrl();
    const signal = new TelemachusSignalLink(streamUrl);
    
    const SUBSCRIPTIONS = [
        // Identity
        "v.name", "v.type",
        // Radiation & Environment
        "kerbalism.radiation", "kerbalism.habitatRadiation", "kerbalism.magnetosphere",
        "kerbalism.innerBelt", "kerbalism.outerBelt", "kerbalism.envTemperature",
        "kerbalism.habitatPressure", "kerbalism.co2Level", "kerbalism.radiationShielding",
        "kerbalism.habitatComfort", "kerbalism.stellarActivity",
        // Storm
        "kerbalism.storm_countdown", "kerbalism.stellarStormState",
        // Reliability & Parts Health
        "kerbalism.reliability", "kerbalism.parts", "kerbalism.processes",
        // Science & Data
        "kerbalism.drivesFreeSpace", "kerbalism.drivesCapacity",
        "kerbalism.connectionRate", "kerbalism.connectionLinked",
        // Crew
        "kerbalism.crew",
        // Resource Rates (Kerbalism net — units/s)
        "kerbalism.res_rate[Oxygen]", "kerbalism.res_rate[Food]", "kerbalism.res_rate[Water]",
        "kerbalism.res_rate[Nitrogen]", "kerbalism.res_rate[ElectricCharge]",
        "kerbalism.res_rate[CarbonDioxide]", "kerbalism.res_rate[Waste]", "kerbalism.res_rate[WasteWater]",
        // Resource Current Amount (plain double)
        "r.resource[Oxygen]", "r.resource[Food]", "r.resource[Water]",
        "r.resource[Nitrogen]", "r.resource[ElectricCharge]",
        "r.resource[CarbonDioxide]", "r.resource[Waste]", "r.resource[WasteWater]",
        // Resource Max Capacity (plain double) — separate key needed!
        "r.resourceMax[Oxygen]", "r.resourceMax[Food]", "r.resourceMax[Water]",
        "r.resourceMax[Nitrogen]", "r.resourceMax[ElectricCharge]",
        "r.resourceMax[CarbonDioxide]", "r.resourceMax[Waste]", "r.resourceMax[WasteWater]"
    ];

    signal.on('open', () => {
        console.log("[Kerbalism] Unified Link Established");
        signal.subscribe(SUBSCRIPTIONS);
        $("#link-led").css("background", "var(--accent-green)").css("box-shadow", "0 0 5px var(--accent-green)");
        $("#link-status").text("TELEMETRY LINK ACTIVE");
    });

    signal.on('close', () => {
        $("#link-led").css("background", "var(--accent-red)").css("box-shadow", "0 0 5px var(--accent-red)");
        $("#link-status").text("SIGNAL LOST");
    });

    signal.on('datalink_update', (msg) => {
        const data = msg.data;
        if (!data) return;
        updateVesselInfo(data);
        updateConsumables(data);
        updateWaste(data);
        updateEnvironment(data);
        updateSystems(data);
        updatePartsHealth(data);
        updateProcesses(data);
        updateCrew(data);
    });

    signal.connect();

    // =========================================================================
    // Vessel Identity
    // =========================================================================
    function updateVesselInfo(data) {
        if (data["v.name"]) $("#v-name").text(data["v.name"].toUpperCase());
        if (data["v.type"]) $("#v-type").text(data["v.type"].toUpperCase());
    }

    // =========================================================================
    // Life Support Consumables (Food, Water, Oxygen, EC, Nitrogen)
    // =========================================================================
    function updateConsumables(data) {
        const resources = [
            { id: "Oxygen",         color: "var(--accent-cyan)",  label: "OXYGEN" },
            { id: "Food",           color: "var(--accent-green)", label: "FOOD" },
            { id: "Water",          color: "#4488ff",             label: "WATER" },
            { id: "ElectricCharge", color: "#ffcc00",             label: "POWER (EC)" },
            { id: "Nitrogen",       color: "#888888",             label: "NITROGEN" }
        ];
        renderResourceBars(resources, "#ls-container", data);
    }

    // =========================================================================
    // Waste Products (CO2, Waste, WasteWater)
    // =========================================================================
    function updateWaste(data) {
        const resources = [
            { id: "CarbonDioxide", color: "#ff6644", label: "CO₂" },
            { id: "Waste",         color: "#886633", label: "WASTE" },
            { id: "WasteWater",    color: "#668844", label: "WASTEWATER" }
        ];
        renderResourceBars(resources, "#waste-container", data, true);
    }

    // =========================================================================
    // Shared Resource Bar Renderer
    // =========================================================================
    function renderResourceBars(resources, containerId, data, isWaste) {
        const container = $(containerId);
        resources.forEach(res => {
            // r.resource[X] returns plain double (current), r.resourceMax[X] returns plain double (max)
            const curr = data[`r.resource[${res.id}]`];
            const max  = data[`r.resourceMax[${res.id}]`];
            const rate = data[`kerbalism.res_rate[${res.id}]`] || 0;

            // Need at least a current value to display anything
            if (curr === undefined || curr === null) return;
            const currVal = typeof curr === 'number' ? curr : parseFloat(curr);
            const maxVal  = (max !== undefined && max !== null) ? (typeof max === 'number' ? max : parseFloat(max)) : currVal;

            if (isNaN(currVal) || isNaN(maxVal) || maxVal === 0) return;
            const pct = Math.min(100, (currVal / maxVal) * 100);

            // Prognostics
            let timeStr = "STABLE";
            if (isWaste) {
                if (rate > 0) {
                    const secondsToFull = (maxVal - currVal) / rate;
                    timeStr = "FULL IN " + formatDuration(secondsToFull);
                }
            } else {
                if (rate < 0) {
                    const secondsLeft = currVal / Math.abs(rate);
                    timeStr = formatDuration(secondsLeft);
                } else if (rate > 0) {
                    timeStr = "CHARGING";
                }
            }

            let resEl = $(`#res-${res.id}`);
            if (resEl.length === 0) {
                resEl = $(`
                    <div class="res-row" id="res-${res.id}">
                        <div class="res-header">
                            <span class="res-name">${res.label}</span>
                            <span class="res-rate"></span>
                        </div>
                        <div class="res-bar-bg"><div class="res-bar-fill"></div></div>
                        <div class="res-footer">
                            <span class="res-amounts"></span>
                            <span class="res-time"></span>
                        </div>
                    </div>
                `);
                container.find(".placeholder-msg").remove();
                container.append(resEl);
            }

            const rateColor = (isWaste ? (rate > 0 ? 'var(--accent-amber)' : 'var(--accent-green)') : (rate < 0 ? 'var(--accent-red)' : 'var(--accent-green)'));
            const timeColor = (isWaste ? (rate > 0 ? 'var(--accent-amber)' : 'inherit') : (rate < 0 ? 'var(--accent-amber)' : 'inherit'));

            resEl.find(".res-bar-fill").css({ "width": pct + "%", "background": res.color, "box-shadow": `0 0 10px ${res.color}` });
            // Show rate only when meaningfully non-zero
            const absRate = Math.abs(rate);
            const rateStr = absRate < 0.00001 ? 'STABLE' : `${rate >= 0 ? '+' : ''}${absRate < 0.001 ? rate.toExponential(2) : rate.toFixed(4)} u/s`;
            resEl.find(".res-rate").text(rateStr).css("color", absRate < 0.00001 ? 'rgba(255,255,255,0.25)' : rateColor);
            resEl.find(".res-amounts").text(`${currVal.toFixed(1)} / ${maxVal.toFixed(1)}`);
            resEl.find(".res-time").text(timeStr).css("color", timeColor);
        });
    }

    // =========================================================================
    // Environment & Hazard Matrix
    // =========================================================================
    function updateEnvironment(data) {
        if (data["kerbalism.radiation"] !== undefined && data["kerbalism.radiation"] !== null)
            $("#env-rad").html(`${data["kerbalism.radiation"].toFixed(4)} <span class="unit">rad/h</span>`);
        if (data["kerbalism.habitatRadiation"] !== undefined && data["kerbalism.habitatRadiation"] !== null)
            $("#hab-rad").html(`${data["kerbalism.habitatRadiation"].toFixed(4)} <span class="unit">rad/h</span>`);
        if (data["kerbalism.envTemperature"] !== undefined && data["kerbalism.envTemperature"] !== null)
            $("#env-temp").html(`${data["kerbalism.envTemperature"].toFixed(1)} <span class="unit">K</span>`);
        if (data["kerbalism.habitatPressure"] !== undefined && data["kerbalism.habitatPressure"] !== null)
            $("#hab-pres").html(`${data["kerbalism.habitatPressure"].toFixed(2)} <span class="unit">atm</span>`);

        // CO2 Toxicity
        if (data["kerbalism.co2Level"] !== undefined && data["kerbalism.co2Level"] !== null) {
            const co2 = data["kerbalism.co2Level"] * 100;
            const co2Color = co2 > 5 ? 'var(--accent-red)' : (co2 > 1 ? 'var(--accent-amber)' : 'var(--accent-green)');
            $("#env-co2").html(`${co2.toFixed(1)}%`).css("color", co2Color);
        }

        // Radiation Shielding
        if (data["kerbalism.radiationShielding"] !== undefined && data["kerbalism.radiationShielding"] !== null) {
            const shield = data["kerbalism.radiationShielding"] * 100;
            $("#env-shield").html(`${shield.toFixed(0)}%`).css("color", shield > 50 ? 'var(--accent-green)' : 'var(--accent-amber)');
        }

        // Comfort
        if (data["kerbalism.habitatComfort"] !== undefined && data["kerbalism.habitatComfort"] !== null) {
            const comfort = data["kerbalism.habitatComfort"] * 100;
            $("#env-comfort").html(`${comfort.toFixed(0)}%`).css("color", comfort > 50 ? 'var(--accent-green)' : 'var(--accent-amber)');
        }

        // Solar Activity
        if (data["kerbalism.stellarActivity"] !== undefined && data["kerbalism.stellarActivity"] !== null) {
            const sa = data["kerbalism.stellarActivity"];
            const saColor = sa > 0.7 ? 'var(--accent-red)' : (sa > 0.3 ? 'var(--accent-amber)' : 'var(--accent-green)');
            $("#env-solar").html(`${(sa * 100).toFixed(0)}%`).css("color", saColor);
        }

        // Magnetosphere / Belts
        if (data["kerbalism.magnetosphere"] !== undefined) {
            const mag = data["kerbalism.magnetosphere"];
            $("#env-mag").text(mag ? "PROTECTED" : "EXPOSED").css("color", mag ? "var(--accent-green)" : "var(--accent-red)");
        }

        let belt = "CLEAN";
        let beltColor = "var(--accent-cyan)";
        if (data["kerbalism.innerBelt"]) { belt = "INNER BELT"; beltColor = "var(--accent-amber)"; }
        if (data["kerbalism.outerBelt"]) { belt = "OUTER BELT"; beltColor = "var(--accent-amber)"; }
        if (data["kerbalism.innerBelt"] !== undefined || data["kerbalism.outerBelt"] !== undefined)
            $("#env-belt").text(belt).css("color", beltColor);

        // Storm Countdown — require state=1 (incoming) and >60s to avoid false alarms from tiny float values
        const stormTime = data["kerbalism.storm_countdown"];
        const stormState = data["kerbalism.stellarStormState"];
        if (stormState === 1 && stormTime > 60) {
            $("#storm-banner").show();
            $("#storm-timer").text("⚠ IMPACT IN " + formatDuration(stormTime));
        } else if (stormState === 2) {
            $("#storm-banner").show();
            $("#storm-timer").text("⚡ STORM ACTIVE ⚡").css("font-size", "1rem");
        } else {
            $("#storm-banner").hide();
        }
    }

    // =========================================================================
    // Vessel Diagnostics (Malfunctions, EC, Drive, TX)
    // =========================================================================
    function updateSystems(data) {
        // Malfunctions
        const rel = data["kerbalism.reliability"];
        if (rel) {
            const malf = rel.malfunctions || 0;
            $("#sys-malf").text(malf).css("color", malf > 0 ? 'var(--accent-red)' : 'var(--accent-green)');
        }

        // Net EC
        if (data["kerbalism.res_rate[ElectricCharge]"] !== undefined && data["kerbalism.res_rate[ElectricCharge]"] !== null) {
            const ecRate = data["kerbalism.res_rate[ElectricCharge]"];
            $("#sys-ec").html(`${ecRate >= 0 ? '+' : ''}${ecRate.toFixed(2)} <span class="unit">u/s</span>`)
                .css("color", ecRate < 0 ? 'var(--accent-red)' : 'var(--accent-green)');
        }

        // Drive Space (used / total)
        const free = data["kerbalism.drivesFreeSpace"];
        const cap = data["kerbalism.drivesCapacity"];
        if (free !== undefined && free !== null && cap !== undefined && cap !== null) {
            const used = cap - free;
            $("#sys-drive").html(`${used.toFixed(1)}/${cap.toFixed(1)} <span class="unit">MB</span>`);
        } else if (free !== undefined && free !== null) {
            $("#sys-drive").html(`${free.toFixed(1)} <span class="unit">MB free</span>`);
        }

        // Data TX Rate
        if (data["kerbalism.connectionRate"] !== undefined && data["kerbalism.connectionRate"] !== null) {
            const rate = data["kerbalism.connectionRate"];
            $("#sys-tx").html(`${rate.toFixed(2)} <span class="unit">MB/s</span>`)
                .css("color", rate > 0 ? 'var(--accent-cyan)' : 'inherit');
        }
    }

    // =========================================================================
    // Parts Health Matrix (Engines + All Reliability Modules)
    // =========================================================================
    function updatePartsHealth(data) {
        const parts = data["kerbalism.parts"];
        if (!parts || !Array.isArray(parts) || parts.length === 0) return;

        const container = $("#parts-container");
        container.find(".placeholder-msg").remove();

        // Count malfunctions for the diagnostics counter
        const malfCount = parts.filter(p => p.malfunctioned).length;
        $("#sys-malf").text(malfCount).css("color", malfCount > 0 ? 'var(--accent-red)' : 'var(--accent-green)');

        parts.forEach((part, i) => {
            const safeId = `part-${i}`;
            let el = $(`#${safeId}`);
            if (el.length === 0) {
                el = $(`<div class="part-row" id="${safeId}"><span class="part-led"></span><span class="part-type-tag"></span><span class="part-name"></span><span class="part-badges"></span><span class="part-status"></span></div>`);
                container.append(el);
            }
            const malf = part.malfunctioned === true;
            let ledColor = malf ? 'var(--accent-red)' : 'var(--accent-green)';
            let statusText = malf ? 'MALF' : 'OK';
            let badgeHtml = '';

            if (part.isCommand) {
                // COMMAND POD / PROBE CORE
                const ctrl = part.hasControl === true;
                ledColor = ctrl ? 'var(--accent-green)' : 'var(--accent-red)';
                statusText = ctrl ? 'CTRL' : 'NO CTRL';
                if (part.crew && part.crew.length > 0)
                    part.crew.forEach(n => { badgeHtml += '<span class="part-badge" style="color:var(--accent-cyan)">' + n.split(' ')[0] + '</span>'; });
                else
                    badgeHtml += '<span class="part-badge" style="color:rgba(255,255,255,0.25)">PROBE</span>';
                if (part.controlStatus) badgeHtml += '<span class="part-badge" style="color:rgba(255,255,255,0.4)">' + part.controlStatus + '</span>';
            } else if (part.isAntenna) {
                // ANTENNA
                const broken = part.isBroken === true;
                const deployed = part.isDeployed === true;
                const canTx = part.canTransmit === true;
                ledColor = broken ? 'var(--accent-red)' : (deployed && canTx ? 'var(--accent-cyan)' : 'var(--accent-amber)');
                statusText = broken ? 'BROKEN' : (deployed ? 'READY' : 'STOWED');
                if (part.antennaPower !== undefined && part.antennaPower !== null) {
                    const p = part.antennaPower;
                    const ps = p >= 1e9 ? (p/1e9).toFixed(1) + 'G' : p >= 1e6 ? (p/1e6).toFixed(1) + 'M' : p.toFixed(0);
                    badgeHtml += '<span class="part-badge" style="color:var(--accent-cyan)">' + ps + '</span>';
                }
                if (part.antennaType) badgeHtml += '<span class="part-badge" style="color:rgba(255,255,255,0.3)">' + part.antennaType + '</span>';
                if (part.deployState && part.deployState !== 'FIXED') badgeHtml += '<span class="part-badge" style="color:rgba(255,255,255,0.35)">' + part.deployState + '</span>';
            } else if (part.isEngine) {
                // ENGINE
                const thrStr = (part.thrust !== undefined && part.thrust !== null) ? part.thrust.toFixed(1) + 'kN' : 'OFF';
                const ignStr = (part.ignitions !== undefined && part.ignitions !== null) ? 'IGN:' + part.ignitions : '';
                const thrColor = part.isActive ? 'var(--accent-amber)' : 'rgba(255,255,255,0.3)';
                const ignColor = (part.ignitions !== null && part.ignitions <= 1) ? 'var(--accent-red)' : 'rgba(255,255,255,0.4)';
                if (ignStr) badgeHtml += '<span class="part-badge" style="color:' + ignColor + '">' + ignStr + '</span>';
                badgeHtml += '<span class="part-badge" style="color:' + thrColor + '">THR:' + thrStr + '</span>';
            } else {
                // GENERIC RELIABILITY MODULE
                if (part.crew && part.crew.length > 0)
                    part.crew.forEach(n => { badgeHtml += '<span class="part-badge" style="color:var(--accent-cyan)">' + n.split(' ')[0] + '</span>'; });
            }

            el.find(".part-led").css({ "background": ledColor, "box-shadow": "0 0 4px " + ledColor });
            el.find(".part-type-tag").text(part.partType || '').css("color", "rgba(255,255,255,0.25)");
            el.find(".part-name").text(part.name || "UNKNOWN PART");
            el.find(".part-badges").html(badgeHtml);
            el.find(".part-status").text(statusText).css("color", ledColor);
        });
    }


    // =========================================================================
    // Process Controllers (Scrubbers, Recyclers, ISRU)
    // =========================================================================
    function updateProcesses(data) {
        const procs = data["kerbalism.processes"];
        if (!procs || !Array.isArray(procs) || procs.length === 0) return;

        const container = $("#process-container");
        container.find(".placeholder-msg").remove();

        procs.forEach((proc, i) => {
            let el = $(`#proc-${i}`);
            if (el.length === 0) {
                el = $(`<div class="process-row" id="proc-${i}">
                    <span class="proc-led"></span>
                    <span class="proc-name"></span>
                    <span class="proc-status"></span>
                </div>`);
                container.append(el);
            }
            const running = proc.running === true;
            el.find(".proc-led").css("background", running ? 'var(--accent-green)' : 'var(--accent-red)');
            el.find(".proc-name").text(proc.name || "UNKNOWN");
            el.find(".proc-status").text(running ? "ACTIVE" : "STOPPED")
                .css("color", running ? 'var(--accent-green)' : 'var(--accent-red)');
        });
    }

    // =========================================================================
    // Crew Biometrics (Radiation Dose, Stress per Kerbal)
    // =========================================================================
    function updateCrew(data) {
        const crew = data["kerbalism.crew"];
        if (!crew || !Array.isArray(crew)) return;

        const list = $("#crew-list");
        crew.forEach(k => {
            const cardId = `crew-${k.name.replace(/[^a-zA-Z0-9]/g, '-')}`;
            let card = $(`#${cardId}`);

            // radiation & stress rules are lowercased from C# (e.g. "radiation", "stress")
            // problem field is a 0..1 scalar
            const doseRaw = k.radiation !== undefined ? k.radiation : (k['lifetime_radiation'] || 0);
            const stressRaw = k.stress !== undefined ? k.stress : (k['lifetime_stress'] || 0);
            const dose = Math.min(100, Math.abs(doseRaw) * 100);
            const stress = Math.min(100, Math.abs(stressRaw) * 100);

            if (card.length === 0) {
                card = $(`
                    <div class="crew-card" id="${cardId}">
                        <div class="crew-header">
                            <span class="crew-name">${k.name.toUpperCase()}</span>
                            <span class="crew-trait">${k.trait || '?'} LVL ${k.level || 0}</span>
                        </div>
                        <div class="bio-grid">
                            <div>
                                <div class="haz-lbl">RADIATION DOSE</div>
                                <div class="res-bar-bg" style="height:4px;"><div class="dose-bar" style="height:100%; transition:width 0.5s;"></div></div>
                                <div class="bio-val dose-val">--</div>
                            </div>
                            <div>
                                <div class="haz-lbl">STRESS LEVEL</div>
                                <div class="res-bar-bg" style="height:4px;"><div class="stress-bar" style="height:100%; transition:width 0.5s;"></div></div>
                                <div class="bio-val stress-val">--</div>
                            </div>
                        </div>
                        <div class="bio-rules" style="margin-top:6px; font-size:0.45rem; opacity:0.5; font-family:var(--font-data);"></div>
                    </div>
                `);
                list.append(card);
            }

            // Always update — not conditional on card creation
            const doseColor = dose > 70 ? 'var(--accent-red)' : (dose > 30 ? 'var(--accent-amber)' : 'var(--accent-green)');
            const stressColor = stress > 70 ? 'var(--accent-red)' : (stress > 30 ? 'var(--accent-amber)' : 'var(--accent-cyan)');

            card.find(".dose-bar").css({ "width": dose + "%", "background": doseColor });
            card.find(".stress-bar").css({ "width": stress + "%", "background": stressColor });
            card.find(".dose-val").text(`${dose.toFixed(2)}%`).css("color", doseColor);
            card.find(".stress-val").text(`${stress.toFixed(2)}%`).css("color", stressColor);

            // Show all other rule values as mini tags
            const exclude = ['name','trait','level','radiation','stress'];
            const extras = Object.keys(k).filter(key => !exclude.includes(key));
            if (extras.length > 0) {
                const tags = extras.map(key => {
                    const v = k[key];
                    const numV = typeof v === 'number' ? (v * 100).toFixed(1) : v;
                    return `<span style="margin-right:6px">${key.toUpperCase()}: ${numV}%</span>`;
                }).join('');
                card.find(".bio-rules").html(tags);
            }
        });
    }

    // =========================================================================
    // Utility
    // =========================================================================
    function formatDuration(s) {
        if (!s || s <= 0) return "N/A";
        if (s > 86400) return `${(s / 86400).toFixed(1)} days`;
        if (s > 3600) return `${(s / 3600).toFixed(1)} hours`;
        if (s > 60) return `${(s / 60).toFixed(0)} mins`;
        return `${s.toFixed(0)} secs`;
    }
});
