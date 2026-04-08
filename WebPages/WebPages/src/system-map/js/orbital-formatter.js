/**
 * SystemPositionDataFormatter (ES6)
 * The "Bible" of the 3D Map. Handles the transformation of raw Telemachus data
 * into formatted 3D coordinates with perfect axis alignment and body snapping.
 * Path-independent hierarchical resolver for 64-bit stability.
 */
class SystemPositionDataFormatter {
  constructor(orbitalPositionData, datalink, options = {}) {
    this.datalink = datalink;
    this.orbitalPositionData = orbitalPositionData;
    this.orbitalPositionData.options.onRecalculate = this.format.bind(this);
    this.registry = null; // v21.8.31: Injected by View at runtime

    this.rootReferenceBodyName = null;
    this.rootOrigin = { x: 0, y: 0, z: 0 };

    this.options = Object.assign({
      onFormat: null,
      numberOfSegments: 512 // Resolution for vessel patches
    }, options);

    // v21.8.20: Inertial Sun-Centered Scale (1 unit = 1m)
    // Absolute stability for planetary orbits. Precision is handled in the View.
    this.mapScaleFactor = 1.0;
    this.rootOrigin = { x: 0, y: 0, z: 0 };
  }

  format(msg) {
    const positionData = msg.data;
    const type = msg.type;
    const ut = msg.ut;

    if (!positionData || !positionData.referenceBodies || !positionData.referenceBodies["Kerbin"]) {
      if (positionData && !this._metadataWarningSent) {
        console.warn("[SystemMap] Waiting for critical celestial metadata (Kerbin)...");
        this._metadataWarningSent = true;
      }
      return;
    }
    this._metadataWarningSent = false;

    const formattedData = {
      "referenceBodies": [],
      "vessels": [],
      "orbitPatches": [],
      "maneuverNodes": [],
      "referenceBodyPaths": [],
      "distancesFromRootReferenceBody": [],
      "currentUniversalTime": ut,
      "type": type,
      "isBodyChanged": false // v21.8.175: Signal SOI transition to View
    };

    const bodies = positionData.referenceBodies || {};
    const refKeys = Object.keys(bodies);

    // v21.8.45: Universal Orbital Propagator
    // Resolves any entity's relative position using Keplerian formulas or raw fallbacks.
    this.solveOrbitalPosition = (info, ut) => {
      if (!info) return { x: 0, y: 0, z: 0 };

      // v21.8.45: Map authoritative Keplerian elements (favor direct info, then registry, then datalink)
      let orbit = (info.sma !== undefined) ? info : null;

      if (!orbit && info.name && this.registry && this.registry.bodies && this.registry.bodies[info.name]) {
        orbit = this.registry.bodies[info.name].metadata;
      }

      if (!orbit && info.name) {
        orbit = this.datalink.getOrbitalBodyInfo(info.name) || {};
      }

      // v21.8.150: Continuous Analytical Kepler Solver (replaces discrete array sampling)
      // This eliminates the "tac" stutter caused by discrete 128-point quantization.
      if (orbit && orbit.sma !== undefined && orbit.period) {
        return this.solveKeplerAnalytical(orbit, ut);
      }

      // Fallback to static point or sample
      return info.currentTruePosition || (info.points ? info.points[0] : { x: 0, y: 0, z: 0 });
    };

    // v22.1: Analytical Rotation Solver
    // Calculates the rotation angle (degrees) for any celestial body at a given UT.
    this.solveOrbitalRotation = (info, ut) => {
      if (!info || !info.rotates) return 0;

      // Handle Home Body / Focus Body specifically with Server-Side Meridian Sync
      // v22.6: Use vessel body for master sync to ensure landing accuracy anywhere.
      const vesselBodyName = positionData["vesselBody"] || "Kerbin";
      if (info.name === vesselBodyName && positionData["meridianOffset"] !== undefined) {
        return positionData["meridianOffset"];
      }

      const initial = info.initialRotation || 0;
      const speed = info.rotationalSpeed || 0; // degrees per second
      if (speed === 0) return initial;

      return (initial + (speed * ut)) % 360;
    };

    // Helper: Recursively sum relative positions to find absolute sun-centric pos (64-bit)
    const getAbsolutePos = (name) => {
      if (!name || name === "Sun" || name === "root") return { x: 0, y: 0, z: 0 };
      let pos = { x: 0, y: 0, z: 0 };
      let current = name;
      let depth = 0;
      while (current && current.toLowerCase() !== "sun" && current.toLowerCase() !== "root" && depth < 10) {
        const bodiesRef = positionData.referenceBodies || {};
        const actualKey = Object.keys(bodiesRef).find(k => k.toLowerCase() === current.toLowerCase()) || current;

        const info = bodiesRef[actualKey];
        // v21.8.21: Use universal propagator for absolute position chain
        const relPos = this.solveOrbitalPosition(Object.assign({ name: actualKey }, info || {}), positionData.currentUniversalTime);

        // v21.8.158: Fail-safe coordinate summation
        if (relPos && isFinite(relPos.x) && isFinite(relPos.y) && isFinite(relPos.z)) {
          pos = { x: pos.x + relPos.x, y: pos.y + relPos.y, z: pos.z + relPos.z };
        }

        const bInfo = this.datalink.getOrbitalBodyInfo(current);
        current = (bInfo && bInfo.referenceBodyName) || (info && info.parent);
        depth++;
      }
      return pos;
    };

    // v21.8.19: Dynamic Hierarchical Origin Shifting
    // The "Scaled Space" Solver: center the world (0,0,0) on the focused target.
    let focusName = (window.SystemMap && window.SystemMap.GUIParameters) ? window.SystemMap.GUIParameters.focusBody : "Kerbin";
    this.rootReferenceBodyName = focusName;

    const actualFocusKey = refKeys.find(k => k.toLowerCase() === focusName.toLowerCase()) || focusName;

    // v21.8.20: Periodic Logging for Diagnostic Verification
    if (!this._logDebounce) this._logDebounce = 0;
    this._logDebounce++;
    const shouldLog = (this._logDebounce % 60 === 0);

    // v21.8.155: Unified Analytical Focus Calculation
    // We determine the "active" vessel position (analytical or server) right at the start
    // so that the Floating Origin (this.focusAbsolutePos) is perfectly smooth for the camera.
    // v21.8.165: G-Force Hysteresis & Analytical Blending
    // We prevent "state struggle" by requiring 10 consecutive frames of low G-force
    const geeForce = Math.abs(positionData['v.geeForce'] || 0);
    this._passiveStabilityCounter = this._passiveStabilityCounter || 0;

    if (geeForce < 0.02) {
      this._passiveStabilityCounter = Math.min(10, this._passiveStabilityCounter + 1);
    } else {
      this._passiveStabilityCounter = Math.max(0, this._passiveStabilityCounter - 2); // Drop out faster than entering
    }

    const isPassive = (this._passiveStabilityCounter >= 10);
    const frameUT = positionData.currentUniversalTime || positionData['t.universalTime'] || msg.ut;

    // v21.8.170: Early Reference Body Determination
    // We need this BEFORE smoothing to detect coordinate system jumps
    const vesselBodyName = (isPassive && positionData['o.referenceBody']) ? positionData['o.referenceBody'] : (positionData["vesselBody"] || "Kerbin");
    const isBodyChanged = (this._lastVesselBody && this._lastVesselBody !== vesselBodyName);
    this._lastVesselBody = vesselBodyName;

    // Default to server position
    let serverRelPos = (positionData["vesselCurrentPosition"] && positionData["vesselCurrentPosition"]["relativePosition"]) || { x: 0, y: 0, z: 0 };
    let targetRelPos = serverRelPos;

    // Try analytical extrapolation if stable 
    if (isPassive && positionData['o.sma'] !== undefined && frameUT !== undefined && !isNaN(frameUT)) {
      const vesselOrbit = {
        sma: positionData['o.sma'], ecc: positionData['o.eccentricity'], inc: positionData['o.inclination'],
        argPe: positionData['o.argumentOfPeriapsis'], lan: positionData['o.lan'], period: positionData['o.period'],
        m0: positionData['o.m0'], epoch: positionData['o.epoch'],
        referenceBody: vesselBodyName // v21.8.188: Align rotation reference
      };

      const solved = this.solveKeplerAnalytical(vesselOrbit, frameUT);

      // v21.8.190: Mathematical Validity Shield
      // We trust the analytical solver as long as it produces valid numbers.
      // We no longer use 'distSq' against serverRelPos because serverRelPos is often stale (latent).
      if (solved && isFinite(solved.x) && isFinite(solved.y) && isFinite(solved.z)) {
        const isZero = (solved.x === 0 && solved.y === 0 && solved.z === 0);
        if (!isZero || !this._vesselRelPosSmooth) {
          targetRelPos = solved;
        }
      }
    }

    // v21.8.170: Position Blending with SOI Jump Protection
    // We blend towards the targetRelPos ONLY if we are in the same coordinate system (same body)
    if (!this._vesselRelPosSmooth || isBodyChanged) {
      // v21.8.176: Robust SOI Snap - Reject (0,0,0) during transition peaks
      const isZero = (targetRelPos.x === 0 && targetRelPos.y === 0 && targetRelPos.z === 0);
      if (!isZero || !this._vesselRelPosSmooth) {
        this._vesselRelPosSmooth = targetRelPos;
        formattedData.isBodyChanged = isBodyChanged; // Finalize signal
      }
    } else {
      const lerpFactor = 0.15; // Balanced 60Hz convergence
      this._vesselRelPosSmooth = {
        x: this._vesselRelPosSmooth.x + (targetRelPos.x - this._vesselRelPosSmooth.x) * lerpFactor,
        y: this._vesselRelPosSmooth.y + (targetRelPos.y - this._vesselRelPosSmooth.y) * lerpFactor,
        z: this._vesselRelPosSmooth.z + (targetRelPos.z - this._vesselRelPosSmooth.z) * lerpFactor
      };
    }

    const vesselRelPos = this._vesselRelPosSmooth;
    this._currentVesselRelPos = vesselRelPos;

    if (focusName === "current vessel") {
      const actualVesselBodyKey = refKeys.find(k => k.toLowerCase() === vesselBodyName.toLowerCase()) || vesselBodyName;
      const bodyAbs = getAbsolutePos(actualVesselBodyKey);

      this.focusAbsolutePos = {
        x: bodyAbs.x + vesselRelPos.x,
        y: bodyAbs.y + vesselRelPos.y,
        z: bodyAbs.z + vesselRelPos.z
      };
    } else {
      this.focusAbsolutePos = getAbsolutePos(actualFocusKey);
    }

    this.getAbsolutePos = getAbsolutePos; // Expose for sub-formatters

    const isFullBatch = (type === 'orbit');
    this.formatReferenceBodies(positionData, formattedData);
    this.formatCurrentVessel(positionData, formattedData);
    this.formatTargetVessel(positionData, formattedData);

    // v21.8.150: Orbit patches recomputed every frame so the trail follows
    // Kerbin analytically (the body pos used in getAbsolutePos is smooth).
    // formatReferenceBodyPaths is dead code (View doesn't read it) — removed.
    this.formatOrbitalPatches(positionData, formattedData);
    this.formatManeuverNodes(positionData, formattedData, isFullBatch);
    this.formatTargetOrbitPatches(positionData, formattedData);

    if (this.options.onFormat) this.options.onFormat(formattedData);
  }

  formatReferenceBodies(positionData, formattedData) {
    if (!positionData.referenceBodies) return;
    Object.keys(positionData.referenceBodies).forEach(name => {
      const info = positionData.referenceBodies[name];
      if (!info) return;

      let type = "currentPosition";
      if (positionData["tar.type"] === "CelestialBody" && positionData["tar.name"] === name) {
        type = "targetBodyCurrentPosition";
      }

      // v21.8.19: Resolve hierarchical position relative to Sun, then shift by rootOrigin
      // v21.8.20: Physical Orbital Solver
      // Server data is 600x too fast. We calculate the point on the orbit path 
      // based on UT and the real orbital period for perfect 1:1 sync.
      let truePosition;
      let worldOrbitPoints = [];

      const bInfo = this.datalink.getOrbitalBodyInfo(name);
      const parentName = (bInfo && bInfo.referenceBodyName) || (positionData.referenceBodies[name] ? positionData.referenceBodies[name].parent : "Sun");
      const parentAbsolutePos = this.getAbsolutePos(parentName);

      // v21.8.46: Unified hierarchal solver (Body/Vessel agnostic)
      const orbitRelPos = this.solveOrbitalPosition(Object.assign({ name: name }, info), positionData.currentUniversalTime);

      truePosition = this.formatTruePositionVector({ x: parentAbsolutePos.x + orbitRelPos.x, y: parentAbsolutePos.y + orbitRelPos.y, z: parentAbsolutePos.z + orbitRelPos.z });

      // v21.8.32: Autoritative reference for SMA if batch is missing it
      const orbitInfo = (info.sma !== undefined) ? info : (this.datalink.getOrbitalBodyInfo(name) || {});

      // Generate orbit path for rendering
      if (orbitInfo.sma !== undefined) {
        const rawOrbitPoints = this.generateOrbitFromKeplerian(orbitInfo.sma, orbitInfo.eccentricity || orbitInfo.ecc, orbitInfo.inclination || orbitInfo.inc, orbitInfo.argPe, orbitInfo.lan);
        worldOrbitPoints = rawOrbitPoints.map(p =>
          this.formatTruePositionVector({ x: parentAbsolutePos.x + p.x, y: parentAbsolutePos.y + p.y, z: parentAbsolutePos.z + p.z })
        );
      }

      formattedData["referenceBodies"].push({
        name: name,
        type: type,
        radius: info.radius || 1000,
        truePosition: truePosition,
        gravParameter: info.gravParameter,
        orbitPath: worldOrbitPoints,
        rotationAngle: this.solveOrbitalRotation(Object.assign({ name: name }, orbitInfo), positionData.currentUniversalTime),
        initialRotation: orbitInfo.initialRotation || 0,
        atmosphericRadius: (this.datalink.getOrbitalBodyInfo(name) || {}).atmosphericRadius || 0,
        color: (this.datalink.getOrbitalBodyInfo(name) || {}).color || '#ffffff'
      });
    });
  }

  findClosestPointOnPath(targetVector, points) {
    if (!targetVector || !points || !points.length) return targetVector;
    let minDistance = Infinity;
    let closestPoint = targetVector;
    for (const p of points) {
      if (!p) continue;
      const dist = Math.pow(targetVector.x - p.x, 2) + Math.pow(targetVector.y - p.y, 2) + Math.pow(targetVector.z - p.z, 2);
      if (dist < minDistance) { minDistance = dist; closestPoint = p; }
    }
    return closestPoint;
  }

  formatReferenceBodyPaths(positionData, formattedData) {
    if (!positionData.referenceBodies) return;
    Object.keys(positionData.referenceBodies).forEach(name => {
      if (name.startsWith("Parent_")) return; // Skip internal sentinel nodes
      const info = positionData.referenceBodies[name];
      if (!info || info.sma === undefined) return;

      const bInfo = this.datalink.getOrbitalBodyInfo(name);
      const parentName = (bInfo && bInfo.referenceBodyName) || info.parent || "Sun";
      const parentAbsolutePos = this.getAbsolutePos(parentName);

      const rawOrbitPoints = this.generateOrbitFromKeplerian(info.sma, info.eccentricity, info.inclination, info.argPe, info.lan);
      const transformedPositions = rawOrbitPoints.map(p =>
        this.formatTruePositionVector({ x: parentAbsolutePos.x + p.x, y: parentAbsolutePos.y + p.y, z: parentAbsolutePos.z + p.z })
      );

      formattedData.referenceBodyPaths.push({
        referenceBodyName: name,
        orbitPath: transformedPositions,
        color: (this.datalink.getOrbitalBodyInfo(name) || {}).color || '#ffffff'
      });
    });
  }

  generateOrbitFromKeplerian(sma, ecc, inc, argPe, lan, skipFix = false) {
    if (!sma) return [];
    // v21.8.150: Defensive defaults — undefined params produce NaN coordinates
    ecc = ecc || 0;
    inc = inc || 0;
    argPe = argPe || 0;
    lan = lan || 0;
    const points = [];
    const segments = 128;

    const radInc = (inc * Math.PI / 180.0);
    const radArgPe = (argPe * Math.PI / 180.0);

    // v21.8.65: Dynamic Meridian Alignment
    // Instead of a hardcoded 75, we use the raw KSP Meridian Offset.
    // If the server data is not yet available, we use 61.64 (standard for UT=0).
    let offset = 0;
    if (!skipFix) {
      const lastData = this.datalink.lastDatalinkData || {};
      if (lastData["pl.meridianOffset"] !== undefined) {
        // The correction to align Inertial LAN to World View is (360 - offset)
        offset = (360 - lastData["pl.meridianOffset"]) % 360;
      }
    }

    const radLan = ((lan + offset) * Math.PI / 180.0);

    for (let i = 0; i <= segments; i++) {
      const trueAnomaly = (i / segments) * 2 * Math.PI;
      const r = (sma * (1 - ecc * ecc)) / (1 + ecc * Math.cos(trueAnomaly));
      const theta = radArgPe + trueAnomaly;

      // Standard orbital mechanics (Z-up reference frame)
      const xStd = r * (Math.cos(radLan) * Math.cos(theta) - Math.sin(radLan) * Math.sin(theta) * Math.cos(radInc));
      const yStd = r * (Math.sin(radLan) * Math.cos(theta) + Math.cos(radLan) * Math.sin(theta) * Math.cos(radInc));
      const zStd = r * (Math.sin(radInc) * Math.sin(theta));

      // v21.8.41: Return raw orbital frame coordinates (Z-up)
      // The projection to 3D space is handled unified in formatTruePositionVector
      points.push({ x: xStd, y: yStd, z: zStd });
    }
    return points;
  }

  /**
   * v21.8.150: Analytical Kepler Solver (Newton-Raphson)
   * Computes the exact orbital position for a given UT without discrete array sampling.
   * This eliminates the "tac" stutter that occurred because getPointAtUT was limited
   * to 129 discrete positions, causing planets to freeze for minutes/hours at a time.
   */
  solveKeplerAnalytical(orbit, ut) {
    const sma = orbit.sma;
    const ecc = orbit.eccentricity || orbit.ecc || 0;
    const inc = (orbit.inclination || orbit.inc || 0) * Math.PI / 180;
    const argPe = (orbit.argPe || 0) * Math.PI / 180;
    const period = orbit.period;
    const m0 = orbit.m0 || 0;
    const epoch = orbit.epoch || 0;

    // v21.8.160: Orbital Period & Stability Guard
    // A period < 10s is physically impossible in KSP and indicates corrupted data or SOI jump artifacts.
    if (!sma || !period || period < 10 || ecc >= 1.0) {
      if (period > 0 && period < 10) {
        console.warn(`[SystemMap] Abnormal Orbit Period Detected: ${period}s. Analytical solver suspended.`);
      }
      return { x: 0, y: 0, z: 0 };
    }

    // v21.8.205: Robust Coordinate Alignment
    // Ensure we don't hit NaN if planetary data is missing during a smooth frame.
    let offsetDeg = 0;
    const store = this.datalink.lastDatalinkData || {};
    
    // Check for explicit orbital meridian offset or fallback to reference body metadata
    // In our store, it's saved as "meridianOffset" or inside referenceBodies[name].meridianOffset
    if (store["meridianOffset"] !== undefined) {
      offsetDeg = (360 - store["meridianOffset"]) % 360;
    } else if (orbit.referenceBody && store.referenceBodies && store.referenceBodies[orbit.referenceBody]) {
      const body = store.referenceBodies[orbit.referenceBody];
      offsetDeg = (360 - (body.meridianOffset || 0)) % 360;
    }

    const lan = ((orbit.lan || 0) + offsetDeg) * Math.PI / 180;

    // 1. Mean Anomaly at UT
    const utOffset = (ut - epoch) % period;
    const n = (2 * Math.PI) / period;
    let M = m0 + n * utOffset;
    // Normalize M to [0, 2π]
    M = M % (2 * Math.PI);
    if (M < 0) M += 2 * Math.PI;

    // 2. Solve Kepler's Equation: M = E - e*sin(E) via Newton-Raphson
    let E = M; // Initial guess
    for (let i = 0; i < 15; i++) {
      const dE = (M - E + ecc * Math.sin(E)) / (1 - ecc * Math.cos(E));
      E += dE;
      if (Math.abs(dE) < 1e-10) break;
    }

    // 3. True Anomaly from Eccentric Anomaly
    const sinV = (Math.sqrt(1 - ecc * ecc) * Math.sin(E)) / (1 - ecc * Math.cos(E));
    const cosV = (Math.cos(E) - ecc) / (1 - ecc * Math.cos(E));
    const v = Math.atan2(sinV, cosV); // True anomaly

    // 4. Radial distance
    const r = sma * (1 - ecc * Math.cos(E));

    // 5. Position in orbital plane
    const theta = argPe + v;
    const cosLan = Math.cos(lan), sinLan = Math.sin(lan);
    const cosInc = Math.cos(inc), sinInc = Math.sin(inc);

    const x = r * (cosLan * Math.cos(theta) - sinLan * Math.sin(theta) * cosInc);
    const y = r * (sinLan * Math.cos(theta) + cosLan * Math.sin(theta) * cosInc);
    const z = r * (sinInc * Math.sin(theta));

    return { x, y, z };
  }

  /**
   * Legacy: kept only for sampling the visual orbit line geometry.
   * NOT used for body position anymore.
   */
  getPointAtUT(points, orbit, ut) {
    if (!points || points.length === 0) return { x: 0, y: 0, z: 0 };
    const period = orbit.period || 1;
    const m0 = orbit.m0 || 0;
    const epoch = orbit.epoch || 0;
    const utOffset = (ut - epoch) % period;
    const n = (2 * Math.PI) / period;
    const meanAnomaly = m0 + n * utOffset;
    let progress = (meanAnomaly / (2 * Math.PI)) % 1;
    if (progress < 0) progress += 1;
    const index = Math.floor(progress * (points.length - 1));
    return points[index];
  }

  formatCurrentVessel(positionData, formattedData) {
    if (!positionData["vesselCurrentPosition"] || !positionData["vesselCurrentPosition"]["relativePosition"]) return;

    // v21.8.156: Use o.referenceBody for SOI consistency during analytical flight
    const geeForce = Math.abs(positionData['v.geeForce'] || 0);
    const isPassive = (geeForce < 0.02);
    const vesselBodyName = (isPassive && positionData['o.referenceBody']) ? positionData['o.referenceBody'] : (positionData["vesselBody"] || "Kerbin");

    const bodyAbsolutePos = this.getAbsolutePos(vesselBodyName);

    // v21.8.155: Use the cached relative position (analytical or server) calculated in format()
    // This ensures that the vessel mesh and the camera origin are perfectly synced.
    let vesselRelPos = this._currentVesselRelPos || positionData["vesselCurrentPosition"]["relativePosition"];

    const vesselAbsolutePos = {
      x: bodyAbsolutePos.x + vesselRelPos.x,
      y: bodyAbsolutePos.y + vesselRelPos.y,
      z: bodyAbsolutePos.z + vesselRelPos.z
    };

    const truePosition = this.formatTruePositionVector(vesselAbsolutePos);

    formattedData["vessels"].push({
      type: "currentVessel",
      truePosition: truePosition
    });
  }

  formatTargetVessel(positionData, formattedData) {
    if (!positionData["targetCurrentPosition"] || !positionData["targetCurrentPosition"]["relativePosition"]) return;
    if (positionData["tar.type"] !== "Vessel") return;

    const vesselBodyName = positionData["vesselBody"] || "Kerbin";
    const bodyAbsolutePos = this.getAbsolutePos(vesselBodyName);
    const targetRelPos = positionData["targetCurrentPosition"]["relativePosition"];
    const targetAbsolutePos = { x: bodyAbsolutePos.x + targetRelPos.x, y: bodyAbsolutePos.y + targetRelPos.y, z: bodyAbsolutePos.z + targetRelPos.z };
    const truePosition = this.formatTruePositionVector(targetAbsolutePos);

    formattedData["vessels"].push({
      type: "targetVessel",
      truePosition: truePosition
    });
  }

  formatOrbitalPatches(positionData, formattedData) {
    this.formatPatchData(positionData, formattedData, "o.orbitPatches", "currentVessel");
  }

  formatTargetOrbitPatches(positionData, formattedData) {
    this.formatPatchData(positionData, formattedData, "tar.o.orbitPatches", "targetVessel");
  }

  formatPatchData(positionData, formattedData, key, parentType) {
    const orbits = positionData[key];
    if (!orbits || !Array.isArray(orbits)) return;

    const formattedOrbitPatches = [];
    orbits.forEach(orbitPatch => {
      // v21.8.30: Direct Array Ingestion (No Dictionary Mapping)
      if (!orbitPatch.points || orbitPatch.points.length < 2) return;

      const patch = {
        orbitPath: [],
        parentType: parentType,
        referenceBody: orbitPatch.referenceBody,
        startUT: orbitPatch.startUT,
        endUT: orbitPatch.endUT,
        ApA: orbitPatch.ApA,
        PeA: orbitPatch.PeA,
        // v21.8.208: Sub-segment Analytical Metadata
        elements: {
          sma: orbitPatch.sma, ecc: orbitPatch.ecc, inc: orbitPatch.inc,
          argPe: orbitPatch.argPe, lan: orbitPatch.lan, period: orbitPatch.period,
          m0: orbitPatch.m0, epoch: orbitPatch.epoch
        }
      };

      const patchBodyAbsolutePos = this.getAbsolutePos(orbitPatch.referenceBody || "Kerbin");

      orbitPatch.points.forEach(rawPos => {
        const absolutePatchPos = {
          x: patchBodyAbsolutePos.x + rawPos.x,
          y: patchBodyAbsolutePos.y + rawPos.y,
          z: patchBodyAbsolutePos.z + rawPos.z
        };
        patch.orbitPath.push(this.formatTruePositionVector(absolutePatchPos));
      });

      formattedOrbitPatches.push(patch);
    });

    formattedData.orbitPatches = formattedData.orbitPatches.concat(formattedOrbitPatches);
  }

  formatManeuverNodes(positionData, formattedData, isFullBatch = true) {
    const nodes = positionData['o.maneuverNodes'];
    if (!nodes || !Array.isArray(nodes)) return;

    // v21.8.155: Compute Vessel Orbit once for analytical node positioning
    const vesselOrbit = {
      sma: positionData['o.sma'],
      ecc: positionData['o.eccentricity'],
      inc: positionData['o.inclination'],
      argPe: positionData['o.argumentOfPeriapsis'],
      lan: positionData['o.lan'],
      period: positionData['o.period'],
      m0: positionData['o.m0'],
      epoch: positionData['o.epoch'],
      referenceBody: positionData['o.referenceBody'] || positionData["vesselBody"] || "Kerbin" // v21.8.192: Align maneuver node rotation
    };

    nodes.forEach(node => {
      let truePosition = null;
      // If we have valid orbital elements, solve the node position analytically
      if (vesselOrbit.sma !== undefined) {
        // v21.8.156: Use o.referenceBody for SOI consistency
        const vesselBodyName = positionData['o.referenceBody'] || positionData["vesselBody"] || "Kerbin";
        const bodyAbsolutePos = this.getAbsolutePos(vesselBodyName);

        // Solve relative position on current orbit at node's UT
        const relNodePos = this.solveKeplerAnalytical(vesselOrbit, node.startUT || node.UT);

        const nodeAbsolutePos = {
          x: bodyAbsolutePos.x + relNodePos.x,
          y: bodyAbsolutePos.y + relNodePos.y,
          z: bodyAbsolutePos.z + relNodePos.z
        };
        truePosition = this.formatTruePositionVector(nodeAbsolutePos);
      }

      const manNode = {
        deltaV: node.deltaV || { x: 0, y: 0, z: 0 },
        ut: node.startUT || node.UT || 0,
        truePosition: truePosition,
        orbitPatches: this.formatNodeOrbitPatches(positionData, node)
      };
      formattedData["maneuverNodes"].push(manNode);
    });
  }

  formatNodeOrbitPatches(positionData, node) {
    if (!node || !node.patches || !Array.isArray(node.patches)) return [];

    const formattedOrbitPatches = [];
    node.patches.forEach(orbitPatch => {
      if (!orbitPatch.points || orbitPatch.points.length < 2) return;

      const patch = {
        orbitPath: [],
        referenceBody: orbitPatch.referenceBody,
        startUT: orbitPatch.startUT,
        endUT: orbitPatch.endUT,
        ApA: orbitPatch.ApA,
        PeA: orbitPatch.PeA,
        // v21.8.218: Sub-segment Analytical Metadata for Maneuver Preview
        elements: {
          sma: orbitPatch.sma, ecc: orbitPatch.ecc, inc: orbitPatch.inc,
          argPe: orbitPatch.argPe, lan: orbitPatch.lan, period: orbitPatch.period,
          m0: orbitPatch.m0, epoch: orbitPatch.epoch
        }
      };

      const patchBodyAbsolutePos = this.getAbsolutePos(orbitPatch.referenceBody || "Kerbin");

      orbitPatch.points.forEach(rawPos => {
        const absolutePatchPos = {
          x: patchBodyAbsolutePos.x + rawPos.x,
          y: patchBodyAbsolutePos.y + rawPos.y,
          z: patchBodyAbsolutePos.z + rawPos.z
        };
        patch.orbitPath.push(this.formatTruePositionVector(absolutePatchPos));
      });
      formattedOrbitPatches.push(patch);
    });
    return formattedOrbitPatches;
  }

  formatTruePositionVector(vector) {
    if (!vector) return { x: 0, y: 0, z: 0 };

    // v21.8.155: Floating Origin Translation
    // Subtract the absolute position of the focus target before transformation.
    // This keeps the center of interest at (0,0,0) and eliminates GPU jitter.
    const focus = this.focusAbsolutePos || { x: 0, y: 0, z: 0 };

    const x = (vector.x || 0) - focus.x;
    const y = (vector.y || 0) - focus.y;
    const z = (vector.z || 0) - focus.z;

    // Standard Righthanded Orbital (X,Y,Z_elev) -> Three.js (X, Z_elev, -Y_north)
    return { x: x, y: z, z: -y };
  }


}
