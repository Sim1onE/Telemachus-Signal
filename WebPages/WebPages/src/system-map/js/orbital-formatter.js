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

  format(positionData) {
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
      "currentUniversalTime": positionData.currentUniversalTime
    };

    const bodies = positionData.referenceBodies || {};
    const refKeys = Object.keys(bodies);

    // v21.8.21: Define Synchronized Solver BEFORE camera focus calculation
    this.getSynchronizedRelativePosition = (name, pData) => {
      const bodiesRef = pData.referenceBodies || {};
      const actualKey = Object.keys(bodiesRef).find(k => k.toLowerCase() === name.toLowerCase()) || name;
      const info = bodiesRef[actualKey];
      if (!info) return { x: 0, y: 0, z: 0 };

      const orbitInfo = (info.sma !== undefined) ? info : (this.registry.bodies[actualKey] ? this.registry.bodies[actualKey].metadata : info);
      if (orbitInfo.sma !== undefined && orbitInfo.period) {
        const rawOrbitPoints = this.generateOrbitFromKeplerian(orbitInfo.sma, orbitInfo.eccentricity, orbitInfo.inclination, orbitInfo.argPe, orbitInfo.lan);
        return this.getPointAtUT(rawOrbitPoints, orbitInfo, pData.currentUniversalTime);
      }
      return info.currentTruePosition || { x: 0, y: 0, z: 0 };
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

        // v21.8.21: Use synchronized relative position for camera focus consistency
        const relPos = this.getSynchronizedRelativePosition(actualKey, positionData);
        pos = { x: pos.x + relPos.x, y: pos.y + relPos.y, z: pos.z + relPos.z };

        const info = bodiesRef[actualKey];
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
    this.formatOrbitalPatches(positionData, formattedData);
    this.formatManeuverNodes(positionData, formattedData);
    this.formatTargetOrbitPatches(positionData, formattedData);
    this.formatReferenceBodyPaths(positionData, formattedData);

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

      // v21.8.21: Use the centralized orbital solver
      const orbitRelPos = this.getSynchronizedRelativePosition(name, positionData);
      truePosition = this.formatTruePositionVector({ x: parentAbsolutePos.x + orbitRelPos.x, y: parentAbsolutePos.y + orbitRelPos.y, z: parentAbsolutePos.z + orbitRelPos.z });

      // Generate orbit path for rendering
      const orbitInfo = (positionData.referenceBodies[name].sma !== undefined) ? positionData.referenceBodies[name] : (this.registry.bodies[name] ? this.registry.bodies[name].metadata : {});
      if (orbitInfo.sma !== undefined) {
        const rawOrbitPoints = this.generateOrbitFromKeplerian(orbitInfo.sma, orbitInfo.eccentricity, orbitInfo.inclination, orbitInfo.argPe, orbitInfo.lan);
        worldOrbitPoints = rawOrbitPoints.map(p =>
          this.formatTruePositionVector({ x: parentAbsolutePos.x + p.x, y: parentAbsolutePos.y + p.y, z: parentAbsolutePos.z + p.z })
        );
      }

      formattedData["referenceBodies"].push({
        name: name,
        type: type,
        radius: info.radius || 1000,
        truePosition: truePosition,
        orbitPath: worldOrbitPoints,
        rotationAngle: (positionData.bodyRotations && positionData.bodyRotations[name]) || 0,
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

  generateOrbitFromKeplerian(sma, ecc, inc, argPe, lan) {
    if (!sma) return [];
    const points = [];
    const segments = 128;

    // v21.8.21: Apply mirrored corrections from coordinate_system_bible.md
    // LAN: -(lan) + 90 | ArgPe: -(argPe) | Inc: -(inc)
    const radInc = (inc * Math.PI / 180.0);
    const radArgPe = (argPe * Math.PI / 180.0);
    const radLan = (lan * Math.PI / 180.0);

    for (let i = 0; i <= segments; i++) {
      const trueAnomaly = (i / segments) * 2 * Math.PI;
      const r = (sma * (1 - ecc * ecc)) / (1 + ecc * Math.cos(trueAnomaly));
      const theta = radArgPe + trueAnomaly;

      // Standard orbital mechanics (Z-up reference frame):
      const xStd = r * (Math.cos(radLan) * Math.cos(theta) - Math.sin(radLan) * Math.sin(theta) * Math.cos(radInc));
      const yStd = r * (Math.sin(radLan) * Math.cos(theta) + Math.cos(radLan) * Math.sin(theta) * Math.cos(radInc));
      const zStd = r * (Math.sin(radInc) * Math.sin(theta));

      // Mapping Standard [xStd, yStd, zStd] to Unity [X, Y, Z]
      // In the formula: X,Y is the Equator plane, Z is Elevation.
      // Unity: X,Z is the Equator plane, Y is Elevation.
      const xUni = xStd; 
      const yUni = zStd; // Elevation
      const zUni = yStd; 

      points.push({ x: xUni, y: yUni, z: zUni });
    }
    return points;
  }

  getPointAtUT(points, orbit, ut) {
    if (!points || points.length === 0) return { x: 0, y: 0, z: 0 };

    // v21.8.21: High-Precision Physical Orbital Clock
    // Uses Period, M0 (Mean Anomaly at Epoch) and Epoch from KSP for absolute sync.
    const period = orbit.period || 1;
    const m0 = orbit.m0 || 0;
    const epoch = orbit.epoch || 0;

    // Mean Anomaly (M) = M0 + n * (UT - Epoch)
    // n = 2 * PI / Period
    const n = (2 * Math.PI) / period;
    const utOffset = ut - epoch;
    const meanAnomaly = m0 + n * utOffset;

    // Progress (0 to 1) for point indexing
    let progress = (meanAnomaly / (2 * Math.PI)) % 1;
    if (progress < 0) progress += 1;

    const index = Math.floor(progress * (points.length - 1));
    return points[index];
  }

  formatCurrentVessel(positionData, formattedData) {
    if (!positionData["vesselCurrentPosition"] || !positionData["vesselCurrentPosition"]["relativePosition"]) return;

    const vesselBodyName = positionData["vesselBody"] || "Kerbin";
    const bodyAbsolutePos = this.getAbsolutePos(vesselBodyName);
    const vesselRelPos = positionData["vesselCurrentPosition"]["relativePosition"];
    const vesselAbsolutePos = { x: bodyAbsolutePos.x + vesselRelPos.x, y: bodyAbsolutePos.y + vesselRelPos.y, z: bodyAbsolutePos.z + vesselRelPos.z };
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
    if (!positionData[key]) return;
    var orbits = positionData[key];
    const formattedOrbitPatches = [];
    for (var key2 in orbits) {
      var orbitPatch = orbits[key2];
      // v21.8.4: Skip patches with no valid position data
      if (!orbitPatch || !orbitPatch.truePositions || Object.keys(orbitPatch.truePositions).length < 2) continue;
      var patch = { truePositions: [], parentType: parentType, referenceBody: orbitPatch.referenceBody };
      var sortedTimes = this.getSortedKeys(orbitPatch.truePositions);

      for (var k = 0; k < sortedTimes.length; k++) {
        const rawPos = orbitPatch.truePositions[sortedTimes[k]];
        if (!rawPos) continue;

        // v21.8.19: Resolve OrbitPatch positions to absolute (sun-centric) coordinates
        const patchBodyAbsolutePos = this.getAbsolutePos(orbitPatch.referenceBody || "Kerbin");
        var absolutePatchPos = {
          x: patchBodyAbsolutePos.x + rawPos.x,
          y: patchBodyAbsolutePos.y + rawPos.y,
          z: patchBodyAbsolutePos.z + rawPos.z
        };
        patch.truePositions.push(this.formatTruePositionVector(absolutePatchPos));
      }
      patch.startUT = sortedTimes[0];
      patch.endUT = sortedTimes[sortedTimes.length - 1];
      patch.ApA = orbitPatch.ApA;
      patch.PeA = orbitPatch.PeA;
      formattedOrbitPatches.push(patch);
    }
    formattedData.orbitPatches = formattedData.orbitPatches.concat(formattedOrbitPatches);
  }

  formatManeuverNodes(positionData, formattedData) {
    if (!positionData['o.maneuverNodes']) return;
    var nodes = positionData['o.maneuverNodes'];
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      if (!node) continue;
      let truePosition = null;
      if (node.truePosition) {
        const vesselBodyName = positionData["vesselBody"] || "Kerbin";
        const bodyAbsolutePos = this.getAbsolutePos(vesselBodyName);
        const nodeAbsolutePos = { x: bodyAbsolutePos.x + node.truePosition.x, y: bodyAbsolutePos.y + node.truePosition.y, z: bodyAbsolutePos.z + node.truePosition.z };
        truePosition = this.formatTruePositionVector(nodeAbsolutePos);
      }
      var manNode = {
        deltaV: node.deltaV || { x: 0, y: 0, z: 0 },
        ut: node.UT || 0,
        truePosition: truePosition,
        orbitPatches: this.formatNodeOrbitPatches(positionData, node)
      };
      formattedData["maneuverNodes"].push(manNode);
    }
  }

  formatNodeOrbitPatches(positionData, node) {
    if (!node || !node.orbitPatches) return [];
    const formattedOrbitPatches = [];
    for (var key in node.orbitPatches) {
      var orbitPatch = node.orbitPatches[key];
      if (!orbitPatch || !orbitPatch.truePositions || Object.keys(orbitPatch.truePositions).length < 2) continue;
      var patch = { truePositions: [], referenceBody: orbitPatch.referenceBody };
      var sortedTimes = this.getSortedKeys(orbitPatch.truePositions);
      for (var k = 0; k < sortedTimes.length; k++) {
        const rawPos = orbitPatch.truePositions[sortedTimes[k]];
        if (!rawPos) continue;

        const patchBodyAbsolutePos = this.getAbsolutePos(orbitPatch.referenceBody || "Kerbin");
        var absolutePatchPos = {
          x: patchBodyAbsolutePos.x + rawPos.x,
          y: patchBodyAbsolutePos.y + rawPos.y,
          z: patchBodyAbsolutePos.z + rawPos.z
        };
        patch.truePositions.push(this.formatTruePositionVector(absolutePatchPos));
      }
      patch.startUT = sortedTimes[0];
      patch.endUT = sortedTimes[sortedTimes.length - 1];
      patch.ApA = orbitPatch.ApA;
      patch.PeA = orbitPatch.PeA;
      formattedOrbitPatches.push(patch);
    }
    return formattedOrbitPatches;
  }

  formatTruePositionVector(vector) {
    if (!vector) return { x: 0, y: 0, z: 0 };

    // v21.8.22: Unity (LH) [X, Y, Z] -> Three.js (RH) [X, Y, -Z]
    // 1. KSP X -> Map X (Right)
    // 2. KSP Y -> Map Y (Up)
    // 3. KSP Z -> Map -Z (North/Forward)
    // This resolves the "Retrograde/Mirror" issue by correctly flipping handedness.
    const x = (vector.x || 0);
    const y = (vector.y || 0);
    const z = (vector.z || 0);

    return { x: x, y: y, z: -z };
  }

  getSortedKeys(positionData) {
    if (!positionData) return [];
    if (positionData._sortedKeys) return positionData._sortedKeys;
    positionData._sortedKeys = Object.keys(positionData).map(parseFloat).sort(function (a, b) { return a - b; });
    return positionData._sortedKeys;
  }
}
