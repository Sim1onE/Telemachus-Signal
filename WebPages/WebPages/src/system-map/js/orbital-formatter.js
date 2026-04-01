/**
 * SystemPositionDataFormatter (ES6)
 * The "Bible" of the 3D Map. Handles the transformation of raw Telemachus data
 * into formatted 3D coordinates with perfect axis alignment and body snapping.
 * Hardened for maneuver node stability.
 */
class SystemPositionDataFormatter {
  constructor(orbitalPositionData, datalink, options = {}) {
    this.datalink = datalink;
    this.orbitalPositionData = orbitalPositionData;
    this.orbitalPositionData.options.onRecalculate = this.format.bind(this);

    this.rootReferenceBodyName = null;
    this.rootOrigin = [0, 0, 0];

    this.options = Object.assign({
      onFormat: null,
      numberOfSegments: 512 // Resolution for vessel patches
    }, options);
  }

  format(positionData) {
    if (!positionData) return;
    const formattedData = {
      "referenceBodies": [],
      "vessels": [],
      "orbitPatches": [],
      "maneuverNodes": [],
      "referenceBodyPaths": [],
      "distancesFromRootReferenceBody": [],
      "currentUniversalTime": positionData.currentUniversalTime
    };

    this.rootOrigin = positionData.referenceBodies && positionData.referenceBodies["Kerbin"]
      ? positionData.referenceBodies["Kerbin"].currentTruePosition
      : [0, 0, 0];

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
      let type = "currentPosition";

      if (positionData["tar.type"] === "CelestialBody" && positionData["tar.name"] === name) {
        type = "targetBodyCurrentPosition";
      }

      let truePosition = this.formatTruePositionVector(info.currentTruePosition);

      if (name !== "Kerbin" && info.sma !== undefined) {
        const rawOrbitPoints = this.generateOrbitFromKeplerian(info.sma, info.eccentricity, info.inclination, info.argPe, info.lan);
        const bInfo = this.datalink.getOrbitalBodyInfo(name);
        const parentName = bInfo ? bInfo.referenceBodyName : "Sun";
        const parentObj = positionData.referenceBodies[parentName];
        const rawParentPosition = parentObj ? parentObj.currentTruePosition : [0, 0, 0];

        const worldOrbitPoints = rawOrbitPoints.map(p =>
          this.formatTruePositionVector(Math.matrixAdd(rawParentPosition, p))
        );

        truePosition = this.findClosestPointOnPath(truePosition, worldOrbitPoints);
      }

      formattedData["referenceBodies"].push({
        name: name, type: type, radius: info.radius,
        truePosition: truePosition,
        atmosphericRadius: this.datalink.getOrbitalBodyInfo(name).atmosphericRadius,
        color: this.datalink.getOrbitalBodyInfo(name).color
      });
    });
  }

  findClosestPointOnPath(targetVector, points) {
    if (!targetVector || !points || !points.length) return targetVector;
    let minDistance = Infinity;
    let closestPoint = targetVector;
    for (const p of points) {
      if (!p) continue;
      const dist = Math.pow(targetVector[0] - p[0], 2) + Math.pow(targetVector[1] - p[1], 2) + Math.pow(targetVector[2] - p[2], 2);
      if (dist < minDistance) { minDistance = dist; closestPoint = p; }
    }
    return closestPoint;
  }

  formatReferenceBodyPaths(positionData, formattedData) {
    if (!positionData.referenceBodies) return;
    Object.keys(positionData.referenceBodies).forEach(name => {
      if (name.startsWith("Parent_") || name === "Kerbin") return;
      const info = positionData.referenceBodies[name];
      if (!info || info.sma === undefined) return;

      const bInfo = this.datalink.getOrbitalBodyInfo(name);
      const parentName = bInfo ? bInfo.referenceBodyName : "Sun";
      const parentObj = positionData.referenceBodies[parentName];
      const rawParentPosition = parentObj ? parentObj.currentTruePosition : [0, 0, 0];

      const rawOrbitPoints = this.generateOrbitFromKeplerian(info.sma, info.eccentricity, info.inclination, info.argPe, info.lan);
      const transformedPositions = rawOrbitPoints.map(p =>
        this.formatTruePositionVector(Math.matrixAdd(rawParentPosition, p))
      );

      formattedData.referenceBodyPaths.push({
        referenceBodyName: name,
        truePositions: transformedPositions
      });
    });
  }

  generateOrbitFromKeplerian(sma, ecc, inc, argPe, lan) {
    if (!sma) return [];
    const points = [];
    const segments = 1024;
    const radInc = (inc * Math.PI / 180.0);
    const radArgPe = - (argPe * Math.PI / 180.0);
    const radLan = - (lan * Math.PI / 180.0) + (Math.PI / 2.0);

    for (let i = 0; i <= segments; i++) {
      const trueAnomaly = (i / segments) * 2 * Math.PI;
      const r = (sma * (1 - ecc * ecc)) / (1 + ecc * Math.cos(trueAnomaly));
      const theta = radArgPe + trueAnomaly;
      const x = r * (Math.cos(radLan) * Math.cos(theta) - Math.sin(radLan) * Math.sin(theta) * Math.cos(radInc));
      const y = r * (Math.sin(radInc) * Math.sin(theta));
      const z = r * (Math.sin(radLan) * Math.cos(theta) + Math.cos(radLan) * Math.sin(theta) * Math.cos(radInc));
      points.push([x, y, z]);
    }
    return points;
  }

  formatCurrentVessel(positionData, formattedData) {
    if (!positionData["vesselBody"] || !positionData.referenceBodies[positionData["vesselBody"]] || !positionData["vesselCurrentPosition"]["relativePosition"]) return;
    const currentVesselTruePosition = this.truePositionForRelativePosition(
      positionData["vesselCurrentPosition"]["relativePosition"],
      this.formatTruePositionVector(positionData.referenceBodies[positionData["vesselBody"]].currentTruePosition)
    );
    this.rootReferenceBodyName = positionData["vesselBody"];
    formattedData.vessels.push({
      name: "current vessel", type: "currentVessel",
      truePosition: currentVesselTruePosition,
      referenceBodyName: positionData["vesselBody"]
    });
  }

  formatTargetVessel(positionData, formattedData) {
    if (!positionData["tar.type"] || positionData["tar.type"] !== "Vessel" || !positionData.referenceBodies[positionData["tar.o.orbitingBody"]] || !positionData["targetCurrentPosition"]["relativePosition"]) return;
    const targetCurrentTruePosition = this.truePositionForRelativePosition(
      positionData["targetCurrentPosition"]["relativePosition"],
      this.formatTruePositionVector(positionData.referenceBodies[positionData["tar.o.orbitingBody"]].currentTruePosition)
    );
    formattedData.vessels.push({
      name: positionData["tar.name"], type: "targetVessel",
      truePosition: targetCurrentTruePosition,
      referenceBodyName: positionData["tar.o.orbitingBody"]
    });
  }

  formatOrbitalPatches(positionData, formattedData) {
    formattedData.orbitPatches = this.formatOrbitPatches(formattedData, positionData, positionData["o.orbitPatches"], {
      type: "orbitPatch", parentType: "vessel", parentName: "current vessel"
    });
  }

  formatManeuverNodes(positionData, formattedData) {
    if (!positionData["o.maneuverNodes"] || !positionData["o.maneuverNodes"].length) return;
    positionData["o.maneuverNodes"].forEach((node, i) => {
      // Robustly format patches; skip if empty
      const orbitPatches = this.formatOrbitPatches(formattedData, positionData, node.orbitPatches || [], {
        type: "maneuverNode", parentType: "vessel", parentName: "current vessel"
      });

      if (orbitPatches && orbitPatches.length > 0) {
        formattedData.maneuverNodes.push({
          type: "maneuverNode",
          parentType: "vessel",
          parentName: "current vessel",
          orbitPatches: orbitPatches,
          truePosition: (orbitPatches[0].truePositions && orbitPatches[0].truePositions.length > 0) ? orbitPatches[0].truePositions[0] : null
        });
      }
    });
  }

  formatTargetOrbitPatches(positionData, formattedData) {
    if (!positionData["tar.type"] || !positionData["tar.o.orbitPatches"] || !positionData["tar.o.orbitPatches"].length) return;
    const targetPatches = this.formatOrbitPatches(formattedData, positionData, positionData["tar.o.orbitPatches"], {
      type: "orbitPatch", parentType: "targetVessel", parentName: positionData["tar.name"]
    });
    formattedData.orbitPatches = formattedData.orbitPatches.concat(targetPatches);
  }

  formatOrbitPatches(formattedData, positionData, rawOrbitPatches, orbitPatchOptions) {
    const formattedOrbitPatches = [];
    let lastPatchesPoint = null;
    let distanceFromLastPatchesPoint = null;
    var patchIds = Object.keys(rawOrbitPatches || {});
    for (var i = 0; i < patchIds.length; i++) {
      var id = patchIds[i];
      var orbitPatch = rawOrbitPatches[id];
      const referenceBody = positionData.referenceBodies[orbitPatch.referenceBody];
      if (!referenceBody || !orbitPatch.positionData) continue;

      const sortedTimes = this.sortedUniversalTimes(orbitPatch.positionData);
      if (!sortedTimes.length) continue;
      const positions = [];
      const middleUT = sortedTimes[Math.floor((sortedTimes.length - 1) / 2)];

      sortedTimes.forEach((key, k) => {
        const utVal = parseFloat(key);
        let frameOfReferenceVector;
        if (orbitPatch.referenceBody === this.rootReferenceBodyName || orbitPatch.referenceBody === "Sun") {
          frameOfReferenceVector = this.formatTruePositionVector(referenceBody.currentTruePosition);
        } else {
          frameOfReferenceVector = this.findProjectedPositionOfReferenceBody(positionData.referenceBodies[this.rootReferenceBodyName], referenceBody, utVal);
        }

        const relativePosition = orbitPatch.positionData[key].relativePosition;
        if (!relativePosition) return;
        let projectedTruePosition = this.truePositionForRelativePosition(relativePosition, frameOfReferenceVector);

        if (lastPatchesPoint != null) {
          if (k === 0) distanceFromLastPatchesPoint = [lastPatchesPoint[0] - projectedTruePosition[0], lastPatchesPoint[1] - projectedTruePosition[1], lastPatchesPoint[2] - projectedTruePosition[2]];
          projectedTruePosition = [projectedTruePosition[0] + distanceFromLastPatchesPoint[0], projectedTruePosition[1] + distanceFromLastPatchesPoint[1], projectedTruePosition[2] + distanceFromLastPatchesPoint[2]];
          if (key === middleUT && orbitPatch.referenceBody !== this.rootReferenceBodyName) {
            const bodyPos = [frameOfReferenceVector[0] + distanceFromLastPatchesPoint[0], frameOfReferenceVector[1] + distanceFromLastPatchesPoint[1], frameOfReferenceVector[2] + distanceFromLastPatchesPoint[2]];
            formattedData["referenceBodies"].push({
              name: orbitPatch.referenceBody, type: "projected", radius: referenceBody.radius, truePosition: bodyPos, linkedPatchID: i,
              atmosphericRadius: this.datalink.getOrbitalBodyInfo(orbitPatch.referenceBody).atmosphericRadius
            });
          }
        }
        positions.push(projectedTruePosition);
      });
      if (positions.length) lastPatchesPoint = positions[positions.length - 1];
      var patch = {};
      Object.keys(orbitPatchOptions).forEach(function (k) { patch[k] = orbitPatchOptions[k]; });
      patch.truePositions = positions;
      patch.ApA = orbitPatch.ApA;
      patch.PeA = orbitPatch.PeA;
      formattedOrbitPatches.push(patch);
    }
    return formattedOrbitPatches;
  }

  formatTruePositionVector(vector) {
    if (!this.rootOrigin || !vector) return vector;
    return [vector[0] - this.rootOrigin[0], -(vector[1] - this.rootOrigin[1]), vector[2] - this.rootOrigin[2]];
  }

  truePositionForRelativePosition(relativePositionVector, frameOfReferenceVector) {
    const transformedRelative = [relativePositionVector[0], relativePositionVector[2], relativePositionVector[1]];
    return Math.matrixAdd(frameOfReferenceVector, transformedRelative);
  }

  findProjectedPositionOfReferenceBody(rootReferenceBody, body, universalTime) {
    if (!rootReferenceBody || !body) return [0, 0, 0];
    const rootKeys = this.getSortedKeys(rootReferenceBody.positionData);
    const rootPos = rootReferenceBody.positionData[this.findClosestUTBinary(universalTime, rootKeys)].truePosition;
    const targetPos = body.positionData[universalTime].truePosition;
    return [targetPos[0] - rootPos[0], targetPos[1] - rootPos[1], targetPos[2] - rootPos[2]];
  }

  getSortedKeys(positionData) {
    if (!positionData) return [];
    if (positionData._sortedKeys) return positionData._sortedKeys;
    positionData._sortedKeys = Object.keys(positionData).map(parseFloat).sort(function(a, b) { return a - b; });
    return positionData._sortedKeys;
  }

  findClosestUTBinary(target, keys) {
    if (!keys || !keys.length) return target;
    var low = 0, high = keys.length - 1;
    while (low < high) {
        var mid = (low + high) / 2 | 0;
        if (target < keys[mid]) high = mid;
        else low = mid + 1;
    }
    // Check if the previous one is closer
    if (low > 0 && Math.abs(target - keys[low - 1]) < Math.abs(target - keys[low])) return keys[low - 1];
    return keys[low];
  }

  sortedUniversalTimes(positionData) {
    return this.getSortedKeys(positionData);
  }
}

window.SystemPositionDataFormatter = SystemPositionDataFormatter;
