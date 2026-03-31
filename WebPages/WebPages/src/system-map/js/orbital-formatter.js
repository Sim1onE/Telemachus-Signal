/**
 * SystemPositionDataFormatter (ES6)
 * The "Bible" of the 3D Map. Handles the transformation of raw Telemachus data
 * into formatted 3D coordinates with perfect axis alignment and body snapping.
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
      numberOfSegments: 4096 // Increased resolution for vessels
    }, options);
  }

  format(positionData) {
    const formattedData = {
      "referenceBodies": [],
      "vessels": [],
      "orbitPatches": [],
      "maneuverNodes": [],
      "referenceBodyPaths": [],
      "distancesFromRootReferenceBody": [],
      "currentUniversalTime": positionData.currentUniversalTime
    };

    // Use Kerbin as the center of the world [0,0,0]
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
    const referenceBodyNames = Object.keys(positionData.referenceBodies);

    referenceBodyNames.forEach(name => {
      const info = positionData.referenceBodies[name];
      let type = "currentPosition";

      if (positionData["tar.type"] === "CelestialBody" && positionData["tar.name"] === name) {
        type = "targetBodyCurrentPosition";
      }

      // 1. Initial true position with Bible inversion
      let truePosition = this.formatTruePositionVector(info.currentTruePosition);

      // 2. ULTIMATE INTERSECTION: Snapping celestial bodies to their generated paths
      if (name !== "Kerbin" && info.sma !== undefined) {
        const rawOrbitPoints = this.generateOrbitFromKeplerian(info.sma, info.eccentricity, info.inclination, info.argPe, info.lan);
        const bInfo = this.datalink.getOrbitalBodyInfo(name);
        const parentName = bInfo && bInfo.referenceBodyName ? bInfo.referenceBodyName : "Sun";
        const parentObj = positionData.referenceBodies[parentName];
        const rawParentPosition = parentObj ? parentObj.currentTruePosition : [0, 0, 0];

        const worldOrbitPoints = rawOrbitPoints.map(p =>
          this.formatTruePositionVector(Math.matrixAdd(rawParentPosition, p))
        );

        truePosition = this.findClosestPointOnPath(truePosition, worldOrbitPoints);
      }

      const body = this.buildReferenceBody({
        name: name,
        type: type,
        radius: info.radius,
        truePosition: truePosition,
        atmosphericRadius: this.datalink.getOrbitalBodyInfo(name).atmosphericRadius,
        color: this.datalink.getOrbitalBodyInfo(name).color
      });

      formattedData["referenceBodies"].push(body);
    });
  }

  findClosestPointOnPath(targetVector, points) {
    if (!points || !points.length) return targetVector;
    let minDistance = Infinity;
    let closestPoint = targetVector;

    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      if (!p) continue;
      const dist = Math.pow(targetVector[0] - p[0], 2) +
        Math.pow(targetVector[1] - p[1], 2) +
        Math.pow(targetVector[2] - p[2], 2);
      if (dist < minDistance) {
        minDistance = dist;
        closestPoint = p;
      }
    }
    return closestPoint;
  }

  formatReferenceBodyPaths(positionData, formattedData) {
    if (!positionData.referenceBodies) return;
    const referenceBodyNames = Object.keys(positionData.referenceBodies);

    referenceBodyNames.forEach(name => {
      if (name.startsWith("Parent_") || name === "Kerbin") return;

      const info = positionData.referenceBodies[name];
      if (!info || info.sma === undefined) return;

      const bInfo = this.datalink.getOrbitalBodyInfo(name);
      if (bInfo && bInfo.referenceBodyName !== "Kerbin") return;

      const parentName = bInfo && bInfo.referenceBodyName ? bInfo.referenceBodyName : "Sun";
      const parentObj = positionData.referenceBodies[parentName];
      const rawParentPosition = parentObj ? parentObj.currentTruePosition : [0, 0, 0];

      // Generate mathematical orbit
      const rawOrbitPoints = this.generateOrbitFromKeplerian(info.sma, info.eccentricity, info.inclination, info.argPe, info.lan);

      const transformedPositions = rawOrbitPoints.map(p =>
        this.formatTruePositionVector(Math.matrixAdd(rawParentPosition, p))
      );

      formattedData.referenceBodyPaths.push(this.buildReferenceBodyPath({
        referenceBodyName: name,
        truePositions: transformedPositions
      }));
    });
  }

  /**
   * THE KEPLERIAN BIBLE
   * Generates a 3D orbital path using Keplerian elements with vertical and axis corrections.
   */
  generateOrbitFromKeplerian(sma, ecc, inc, argPe, lan) {
    if (!sma) return [];
    const points = [];
    const segments = 16384; // Increased resolution for celestial rings

    const radInc = (inc * Math.PI / 180.0); // No negation here; formatter handles vertical inversion
    const radArgPe = - (argPe * Math.PI / 180.0); // Bible: Inverse Rotation
    const radLan = - (lan * Math.PI / 180.0) + (Math.PI / 2.0); // Bible: Inverse Rotation + 90deg Unity Offset

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
    if (!positionData.referenceBodies || !positionData["vesselBody"] || !positionData.referenceBodies[positionData["vesselBody"]]) return;
    const vesselBody = positionData["vesselBody"];
    const currentVesselTruePosition = this.truePositionForRelativePosition(
      positionData["vesselCurrentPosition"]["relativePosition"],
      this.formatTruePositionVector(positionData.referenceBodies[vesselBody].currentTruePosition)
    );

    this.rootReferenceBodyName = vesselBody;

    formattedData.vessels.push(this.buildVessel({
      name: "current vessel",
      type: "currentVessel",
      truePosition: currentVesselTruePosition,
      referenceBodyName: vesselBody
    }));
  }

  formatTargetVessel(positionData, formattedData) {
    if (!positionData['tar.type'] || positionData["tar.type"] !== "Vessel" || !positionData.referenceBodies || !positionData.referenceBodies[positionData["tar.o.orbitingBody"]]) return;

    const targetCurrentTruePosition = this.truePositionForRelativePosition(
      positionData["targetCurrentPosition"]["relativePosition"],
      this.formatTruePositionVector(positionData.referenceBodies[positionData["tar.o.orbitingBody"]].currentTruePosition)
    );

    formattedData.vessels.push(this.buildVessel({
      name: positionData["tar.name"],
      type: "targetVessel",
      truePosition: targetCurrentTruePosition,
      referenceBodyName: positionData["tar.o.orbitingBody"]
    }));
  }

  formatOrbitalPatches(positionData, formattedData) {
    formattedData.orbitPatches = this.formatOrbitPatches(formattedData, positionData, positionData["o.orbitPatches"], {
      type: "orbitPatch", parentType: "vessel", parentName: "current vessel"
    });
  }

  formatTargetOrbitPatches(positionData, formattedData) {
    if (!positionData['tar.type'] || !positionData["tar.o.orbitPatches"].length) return;

    const targetPatches = this.formatOrbitPatches(formattedData, positionData, positionData["tar.o.orbitPatches"], {
      type: "orbitPatch", parentType: "targetVessel", parentName: positionData["tar.name"]
    });
    formattedData.orbitPatches = formattedData.orbitPatches.concat(targetPatches);
  }

  formatManeuverNodes(positionData, formattedData) {
    if (!positionData["o.maneuverNodes"]) return;
    positionData["o.maneuverNodes"].forEach((node, i) => {
      const orbitPatches = this.formatOrbitPatches(formattedData, positionData, node.orbitPatches, {
        type: "maneuverNode", parentType: "vessel", parentName: "current vessel"
      });

      formattedData.maneuverNodes.push(this.buildManeuverNode({
        type: "maneuverNode",
        parentType: "vessel",
        parentName: "current vessel",
        orbitPatches: orbitPatches,
        truePosition: (orbitPatches.length > 0 && orbitPatches[0].truePositions.length > 0) ? orbitPatches[0].truePositions[0] : null
      }));
    });
  }

  formatOrbitPatches(formattedData, positionData, rawOrbitPatches, orbitPatchOptions) {
    const formattedOrbitPatches = [];
    let lastPatchesPoint = null;
    let distanceFromLastPatchesPoint = null;

    if (!rawOrbitPatches) return formattedOrbitPatches;

    rawOrbitPatches.forEach((orbitPatch, j) => {
      const referenceBody = positionData.referenceBodies[orbitPatch.referenceBody];
      if (!referenceBody) return;

      const sortedTimes = this.sortedUniversalTimes(orbitPatch.positionData);
      const positions = [];
      const middleUT = sortedTimes[Math.floor((sortedTimes.length - 1) / 2)];

      sortedTimes.forEach((key, k) => {
        const utVal = parseFloat(key);
        let frameOfReferenceVector;

        if (orbitPatch.referenceBody === this.rootReferenceBodyName || orbitPatch.referenceBody === "Sun") {
          frameOfReferenceVector = this.formatTruePositionVector(referenceBody.currentTruePosition);
        } else {
          frameOfReferenceVector = this.findProjectedPositionOfReferenceBody(
            positionData.referenceBodies[this.rootReferenceBodyName], referenceBody, utVal
          );
        }

        const relativePosition = orbitPatch.positionData[key].relativePosition;
        let projectedTruePosition = this.truePositionForRelativePosition(relativePosition, frameOfReferenceVector);

        // Continuation logic for patched orbits
        if (lastPatchesPoint != null) {
          if (k === 0) {
            distanceFromLastPatchesPoint = [
              lastPatchesPoint[0] - projectedTruePosition[0],
              lastPatchesPoint[1] - projectedTruePosition[1],
              lastPatchesPoint[2] - projectedTruePosition[2],
            ];
          }

          projectedTruePosition = [
            projectedTruePosition[0] + distanceFromLastPatchesPoint[0],
            projectedTruePosition[1] + distanceFromLastPatchesPoint[1],
            projectedTruePosition[2] + distanceFromLastPatchesPoint[2],
          ];

          // Add projected body markers if in a different reference frame
          if (key === middleUT && orbitPatch.referenceBody !== this.rootReferenceBodyName) {
            const bodyPos = [
              frameOfReferenceVector[0] + distanceFromLastPatchesPoint[0],
              frameOfReferenceVector[1] + distanceFromLastPatchesPoint[1],
              frameOfReferenceVector[2] + distanceFromLastPatchesPoint[2],
            ];

            formattedData["referenceBodies"].push(this.buildReferenceBody({
              name: orbitPatch.referenceBody,
              type: "projected",
              radius: referenceBody.radius,
              truePosition: bodyPos,
              linkedPatchID: j,
              atmosphericRadius: this.datalink.getOrbitalBodyInfo(orbitPatch.referenceBody).atmosphericRadius
            }));
          }
        }

        positions.push(projectedTruePosition);
      });

      if (positions.length) lastPatchesPoint = positions[positions.length - 1];
      formattedOrbitPatches.push(this.buildOrbitPatch(Object.assign({ truePositions: positions }, orbitPatchOptions)));
    });

    return formattedOrbitPatches;
  }

  /**
   * THE BIBLE: Vector Transformation
   * Map Kerbin-centric world space with the required vertical inversion.
   */
  formatTruePositionVector(vector) {
    if (this.rootOrigin && vector) {
      return [
        vector[0] - this.rootOrigin[0],
        -(vector[1] - this.rootOrigin[1]), // BIBLE: Vertical Inversion
        vector[2] - this.rootOrigin[2]
      ];
    }
    return vector;
  }

  truePositionForRelativePosition(relativePositionVector, frameOfReferenceVector) {
    // Telemachus relative is [X, Z, Y] (Z-up), we convert to [X, Y, Z] (Y-up world)
    const transformedRelative = [relativePositionVector[0], relativePositionVector[2], relativePositionVector[1]];
    return Math.matrixAdd(frameOfReferenceVector, transformedRelative);
  }

  findProjectedPositionOfReferenceBody(rootReferenceBody, body, universalTime) {
    if (!rootReferenceBody || !body) return [0, 0, 0];
    const rootPos = rootReferenceBody.positionData[this.findClosestUT(universalTime, rootReferenceBody.positionData)].truePosition;
    const targetPos = body.positionData[universalTime].truePosition;

    return Math.matrixAdd(targetPos, Math.scaleMatrix(-1, rootPos));
  }

  findClosestUT(universalTime, positionData) {
    const keys = Object.keys(positionData).map(parseFloat).sort((a, b) => a - b);
    let closest = keys[0];
    let minDiff = Math.abs(universalTime - closest);

    for (let time of keys) {
      let diff = Math.abs(universalTime - time);
      if (diff < minDiff) {
        minDiff = diff;
        closest = time;
      }
    }
    return closest;
  }

  sortedUniversalTimes(positionData) {
    return Object.keys(positionData).sort((a, b) => parseFloat(a) - parseFloat(b));
  }

  buildReferenceBody(opts) { return { ...opts }; }
  buildReferenceBodyPath(opts) { return { ...opts }; }
  buildVessel(opts) { return { ...opts }; }
  buildOrbitPatch(opts) { return { ...opts }; }
  buildManeuverNode(opts) { return { ...opts }; }
}

window.SystemPositionDataFormatter = SystemPositionDataFormatter;
走
