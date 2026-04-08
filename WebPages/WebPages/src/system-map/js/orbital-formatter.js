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
      "type": type
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
        pos = { x: pos.x + relPos.x, y: pos.y + relPos.y, z: pos.z + relPos.z };

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

    // v21.8.20: rootOrigin stays at [0,0,0] (Sun-centered inertial frame)
    // Scene-group anchoring in the View handles precision.
    // We still compute the focus position for the View to use.
    if (focusName === "current vessel") {
      const vesselBodyName = positionData["vesselBody"] || "Kerbin";
      const actualVesselBodyKey = refKeys.find(k => k.toLowerCase() === vesselBodyName.toLowerCase()) || vesselBodyName;
      const vesselRelPos = (positionData["vesselCurrentPosition"] && positionData["vesselCurrentPosition"]["relativePosition"]) || { x: 0, y: 0, z: 0 };
      const bodyAbs = getAbsolutePos(actualVesselBodyKey);
      this.focusAbsolutePos = {
        x: bodyAbs.x + vesselRelPos.x,
        y: bodyAbs.y + vesselRelPos.y,
        z: bodyAbs.z + vesselRelPos.z
      };
    } else {
      this.focusAbsolutePos = getAbsolutePos(actualFocusKey);
    }

    if (shouldLog) {
      console.log(`[SystemMap] Frame Stats — Focus: ${actualFocusKey} | FocusPos: [${this.focusAbsolutePos.x.toExponential(2)}, ${this.focusAbsolutePos.y.toExponential(2)}, ${this.focusAbsolutePos.z.toExponential(2)}]`);
    }

    this.getAbsolutePos = getAbsolutePos; // Expose for sub-formatters

    this.formatReferenceBodies(positionData, formattedData);
    this.formatCurrentVessel(positionData, formattedData);
    this.formatTargetVessel(positionData, formattedData);

    // v21.8.150: Orbit patches recomputed every frame so the trail follows
    // Kerbin analytically (the body pos used in getAbsolutePos is smooth).
    // formatReferenceBodyPaths is dead code (View doesn't read it) — removed.
    this.formatOrbitalPatches(positionData, formattedData);
    this.formatManeuverNodes(positionData, formattedData);
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
        truePositions: worldOrbitPoints, // v21.8.150: backward compat with updateReferenceBodyOrbitPaths
        rotationAngle: orbitInfo.rotationAngle || (positionData.bodyRotations && positionData.bodyRotations[name]) || 0,
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
        truePositions: transformedPositions,
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
    const sma   = orbit.sma;
    const ecc   = orbit.eccentricity || orbit.ecc || 0;
    const inc   = (orbit.inclination || orbit.inc || 0) * Math.PI / 180;
    const argPe = (orbit.argPe || 0) * Math.PI / 180;
    const period = orbit.period || 1;
    const m0    = orbit.m0 || 0;
    const epoch = orbit.epoch || 0;

    // Meridian offset (same logic as generateOrbitFromKeplerian)
    let offsetDeg = 0;
    const lastData = this.datalink.lastDatalinkData || {};
    if (lastData["pl.meridianOffset"] !== undefined) {
      offsetDeg = (360 - lastData["pl.meridianOffset"]) % 360;
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
    for (let i = 0; i < 10; i++) {
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
    const vesselBodyName = positionData["vesselBody"] || "Kerbin";

    // v21.8.125: Back to basics. Use ONLY the RAW position to avoid jumping and rotation errors.
    if (!positionData["vesselCurrentPosition"] || !positionData["vesselCurrentPosition"]["relativePosition"]) return;

    const bodyAbsolutePos = this.getAbsolutePos(vesselBodyName);
    const vesselRelPos = positionData["vesselCurrentPosition"]["relativePosition"];
    const vesselAbsolutePos = {
      x: bodyAbsolutePos.x + vesselRelPos.x,
      y: bodyAbsolutePos.y + vesselRelPos.y,
      z: bodyAbsolutePos.z + vesselRelPos.z
    };

    formattedData["vessels"].push({
      type: "currentVessel",
      truePosition: this.formatTruePositionVector(vesselAbsolutePos)
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
        truePositions: [],
        parentType: parentType,
        referenceBody: orbitPatch.referenceBody,
        startUT: orbitPatch.startUT,
        endUT: orbitPatch.endUT,
        ApA: orbitPatch.ApA,
        PeA: orbitPatch.PeA
      };

      const patchBodyAbsolutePos = this.getAbsolutePos(orbitPatch.referenceBody || "Kerbin");

      orbitPatch.points.forEach(rawPos => {
        const absolutePatchPos = {
          x: patchBodyAbsolutePos.x + rawPos.x,
          y: patchBodyAbsolutePos.y + rawPos.y,
          z: patchBodyAbsolutePos.z + rawPos.z
        };
        patch.truePositions.push(this.formatTruePositionVector(absolutePatchPos));
      });

      formattedOrbitPatches.push(patch);
    });

    formattedData.orbitPatches = formattedData.orbitPatches.concat(formattedOrbitPatches);
  }

  formatManeuverNodes(positionData, formattedData) {
    const nodes = positionData['o.maneuverNodes'];
    if (!nodes || !Array.isArray(nodes)) return;

    nodes.forEach(node => {
      let truePosition = null;
      if (node.points && node.points.length > 0) {
        const vesselBodyName = positionData["vesselBody"] || "Kerbin";
        const bodyAbsolutePos = this.getAbsolutePos(vesselBodyName);
        const pt = node.points[0];
        const nodeAbsolutePos = {
          x: bodyAbsolutePos.x + pt.x,
          y: bodyAbsolutePos.y + pt.y,
          z: bodyAbsolutePos.z + pt.z
        };
        truePosition = this.formatTruePositionVector(nodeAbsolutePos);
      }

      const manNode = {
        deltaV: node.deltaV || { x: 0, y: 0, z: 0 },
        ut: node.startUT || 0,
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
        truePositions: [],
        referenceBody: orbitPatch.referenceBody,
        startUT: orbitPatch.startUT,
        endUT: orbitPatch.endUT,
        ApA: orbitPatch.ApA,
        PeA: orbitPatch.PeA
      };

      const patchBodyAbsolutePos = this.getAbsolutePos(orbitPatch.referenceBody || "Kerbin");

      orbitPatch.points.forEach(rawPos => {
        const absolutePatchPos = {
          x: patchBodyAbsolutePos.x + rawPos.x,
          y: patchBodyAbsolutePos.y + rawPos.y,
          z: patchBodyAbsolutePos.z + rawPos.z
        };
        patch.truePositions.push(this.formatTruePositionVector(absolutePatchPos));
      });
      formattedOrbitPatches.push(patch);
    });
    return formattedOrbitPatches;
  }

  formatTruePositionVector(vector) {
    if (!vector) return { x: 0, y: 0, z: 0 };

    // v21.8.41: Unified Transformation Matrix
    // Maps Standard Righthanded Orbital Frame (X, Y, Z_elevation) 
    // to Three.js Righthanded Space (X, Y_elevation, -Z_north)

    // 1. KSP X (East) -> Map X
    // 2. KSP Z (Elevation) -> Map Y (Up)
    // 3. KSP Y (North) -> Map -Z (Flipping depth for handedness consistency)

    const x = (vector.x || 0);
    const y = (vector.y || 0);
    const z = (vector.z || 0);

    return { x: x, y: z, z: -y };
  }


}
