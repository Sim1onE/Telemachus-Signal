var SystemPositionDataFormatter = Class.create({
  initialize: function (orbitalPositionData, datalink, options) {
    this.datalink = datalink
    this.orbitalPositionData = orbitalPositionData;
    this.orbitalPositionData.options.onRecalculate = this.format.bind(this)

    this.rootReferenceBodyName = null

    this.options = Object.extend({
      onFormat: null,
      numberOfSegments: 400
    }, options)
  },

  format: function (positionData) {
    var formattedData = {
      "referenceBodies": [],
      "vessels": [],
      "orbitPatches": [],
      "maneuverNodes": [],
      "referenceBodyPaths": [],
      "distancesFromRootReferenceBody": [],
      "currentUniversalTime": positionData.currentUniversalTime
    }

    this.rootOrigin = positionData.referenceBodies && positionData.referenceBodies["Kerbin"]
      ? positionData.referenceBodies["Kerbin"].currentTruePosition
      : [0, 0, 0];

    this.formatReferenceBodies(positionData, formattedData)
    this.formatCurrentVessel(positionData, formattedData)
    this.formatTargetVessel(positionData, formattedData)
    this.formatOrbitalPatches(positionData, formattedData)
    this.formatManeuverNodes(positionData, formattedData)
    this.formatTargetOrbitPatches(positionData, formattedData)
    this.formatReferenceBodyPaths(positionData, formattedData)
    // this.formatDistancesFromRootReferenceBody(positionData, formattedData)

    this.options.onFormat && this.options.onFormat(formattedData)
  },

  formatReferenceBodies: function (positionData, formattedData) {
    referenceBodyNames = Object.keys(positionData.referenceBodies)

    for (var i = referenceBodyNames.length - 1; i >= 0; i--) {
      var name = referenceBodyNames[i]
      var info = positionData.referenceBodies[name]
      var type = "currentPosition"

      if (positionData["tar.type"] == "CelestialBody" && positionData["tar.name"] == name) {
        type = "targetBodyCurrentPosition"
      }

      var truePosition = this.formatTruePositionVector(info.currentTruePosition);

      // ULTIMATE INTERSECTION: If this body has an orbit path, snap the ball to the ring
      if (name !== "Kerbin" && info.sma !== undefined) {
        var rawOrbitPoints = this.generateOrbitFromKeplerian(info.sma, info.eccentricity, info.inclination, info.argPe, info.lan);
        var bInfo = this.datalink.getOrbitalBodyInfo(name);
        var parentName = bInfo && bInfo.referenceBodyName ? bInfo.referenceBodyName : "Sun";
        var parentObj = positionData.referenceBodies[parentName];
        var rawParentPosition = parentObj ? parentObj.currentTruePosition : [0, 0, 0];

        var worldOrbitPoints = [];
        for (var p = 0; p < rawOrbitPoints.length; p++) {
          worldOrbitPoints.push(this.formatTruePositionVector(Math.matrixAdd(rawParentPosition, rawOrbitPoints[p])));
        }
        
        truePosition = this.findClosestPointOnPath(truePosition, worldOrbitPoints);
      }

      var x = this.buildReferenceBody({
        name: name,
        type: type,
        radius: info.radius,
        truePosition: truePosition,
        atmosphericRadius: this.datalink.getOrbitalBodyInfo(name).atmosphericRadius,
        color: this.datalink.getOrbitalBodyInfo(name).color
      })

      formattedData["referenceBodies"].push(x)
    }
  },

  findClosestPointOnPath: function (targetVector, points) {
    var minDistance = Infinity;
    var closestPoint = targetVector;

    for (var i = 0; i < points.length; i++) {
      var p = points[i];
      var dist = Math.pow(targetVector[0] - p[0], 2) +
        Math.pow(targetVector[1] - p[1], 2) +
        Math.pow(targetVector[2] - p[2], 2);
      if (dist < minDistance) {
        minDistance = dist;
        closestPoint = p;
      }
    }
    return closestPoint;
  },

  formatReferenceBodyPaths: function (positionData, formattedData) {
    var referenceBodyNames = Object.keys(positionData.referenceBodies);

    for (var i = referenceBodyNames.length - 1; i >= 0; i--) {
      var name = referenceBodyNames[i];
      if (name.startsWith("Parent_")) continue;

      var info = positionData.referenceBodies[name];
      if (!info) continue;

      // We skip Kerbin's path because it is our center [0,0,0]
      if (name === "Kerbin") continue;

      var bInfo = this.datalink.getOrbitalBodyInfo(name);
      // Only draw paths for objects orbiting Kerbin (like Mun/Minmus)
      if (bInfo && bInfo.referenceBodyName !== "Kerbin") continue;

      if (info.sma !== undefined && info.eccentricity !== undefined && info.inclination !== undefined && info.argPe !== undefined && info.lan !== undefined) {

        var parentName = bInfo && bInfo.referenceBodyName ? bInfo.referenceBodyName : "Sun";
        var parentObj = positionData.referenceBodies[parentName];

        // The parent's position (e.g., Kerbin) already has the origin shift applied
        var liveParentPosition = parentObj && parentObj.currentTruePosition
          ? this.formatTruePositionVector(parentObj.currentTruePosition)
          : [0, 0, 0];

        // 1. Generate the raw mathematical points [x, y, z]
        var rawOrbitPoints = this.generateOrbitFromKeplerian(info.sma, info.eccentricity, info.inclination, info.argPe, info.lan);
        var transformedPositions = [];

        for (var p = 0; p < rawOrbitPoints.length; p++) {
          var point = rawOrbitPoints[p];
          
          // Bible Fix: Use RAW parent position for addition to match the body's own formatter
          var rawParentPosition = parentObj ? parentObj.currentTruePosition : [0, 0, 0];
          var combinedVector = Math.matrixAdd(rawParentPosition, point);
          transformedPositions.push(this.formatTruePositionVector(combinedVector));
        }

        var x = this.buildReferenceBodyPath({
          referenceBodyName: name,
          truePositions: transformedPositions
        });

        formattedData.referenceBodyPaths.push(x);
      }
    }
  },

  generateOrbitFromKeplerian: function (sma, ecc, inc, argPe, lan) {
    if (!sma) return [];
    var points = [];
    var segments = 720;

    var radInc = - (inc * Math.PI / 180.0); // Inverted Inclination for Tilt Parity
    var radArgPe = - (argPe * Math.PI / 180.0); // Inverse Rotation
    var radLan = - (lan * Math.PI / 180.0) + (Math.PI / 2.0);     // Inverse Rotation + 90deg Unity Offset

    for (var i = 0; i <= segments; i++) {
      var trueAnomaly = (i / segments) * 2 * Math.PI;
      var r = (sma * (1 - ecc * ecc)) / (1 + ecc * Math.cos(trueAnomaly));

      var theta = radArgPe + trueAnomaly;

      var x = r * (Math.cos(radLan) * Math.cos(theta) - Math.sin(radLan) * Math.sin(theta) * Math.cos(radInc));
      var y = r * (Math.sin(radInc) * Math.sin(theta));
      var z = r * (Math.sin(radLan) * Math.cos(theta) + Math.cos(radLan) * Math.sin(theta) * Math.cos(radInc));

      points.push([x, y, z]);
    }
    return points;
  },

  formatDistancesFromRootReferenceBody: function (positionData, formattedData) {
    referenceBodyNames = Object.keys(positionData.referenceBodies)
    var rootReferenceBody = positionData.referenceBodies[this.rootReferenceBodyName]

    for (var i = referenceBodyNames.length - 1; i >= 0; i--) {
      var name = referenceBodyNames[i]
      if (name == this.rootReferenceBodyName) { continue; }

      var body = positionData.referenceBodies[name]
      var sortedUniversalTimes = this.sortedUniversalTimes(body.positionData)

      var renderPoints = [sortedUniversalTimes.first(), sortedUniversalTimes.last(), sortedUniversalTimes[59]]

      for (var j = 0; j < renderPoints.length; j++) {
        var firstUniversalTime = renderPoints[j]

        var projectedPositionOfReferenceBody = this.findProjectedPositionOfReferenceBody(rootReferenceBody, body, firstUniversalTime)

        var positions = [
          rootReferenceBody.currentTruePosition,
          projectedPositionOfReferenceBody
        ]

        var x = this.buildDistanceFromRootReferenceBody({
          referenceBodyName: name,
          truePositions: positions
        })

        formattedData.distancesFromRootReferenceBody.push(x)
      }
    }
  },

  formatCurrentVessel: function (positionData, formattedData) {
    var currentVesselTruePosition = this.truePositionForRelativePosition(
      positionData["vesselCurrentPosition"]["relativePosition"],
      this.formatTruePositionVector(positionData.referenceBodies[positionData["vesselBody"]].currentTruePosition)
    )

    this.rootReferenceBodyName = positionData["vesselBody"]

    formattedData.vessels.push(
      this.buildVessel({
        name: "current vessel",
        type: "currentVessel",
        truePosition: currentVesselTruePosition,
        referenceBodyName: positionData["vesselBody"]
      })
    )
  },

  formatTargetVessel: function (positionData, formattedData) {
    if (!positionData['tar.type']) { return }
    if (positionData["tar.type"] == "Vessel") {
      var targetCurrentTruePosition = this.truePositionForRelativePosition(
        positionData["targetCurrentPosition"]["relativePosition"],
        this.formatTruePositionVector(positionData.referenceBodies[positionData["tar.o.orbitingBody"]].currentTruePosition)
      )

      formattedData.vessels.push(this.buildVessel({
        name: positionData["tar.name"],
        type: "targetVessel",
        truePosition: targetCurrentTruePosition,
        referenceBodyName: positionData["tar.o.orbitingBody"]
      }))
    }
  },

  formatTargetOrbitPatches: function (positionData, formattedData) {
    if (!positionData['tar.type']) { return }
    if (positionData["tar.o.orbitPatches"].length > 0) {
      formattedData.orbitPatches = formattedData.orbitPatches.concat(this.formatOrbitPatches(
        formattedData, positionData, positionData["tar.o.orbitPatches"], {
        type: "orbitPatch",
        parentType: "targetVessel",
        parentName: positionData["tar.name"]
      }, { linkedPatchType: "orbitPatch" }
      ))
    }
  },

  formatOrbitalPatches: function (positionData, formattedData) {
    formattedData.orbitPatches = this.formatOrbitPatches(formattedData,
      positionData, positionData["o.orbitPatches"], {
      type: "orbitPatch",
      parentType: "vessel",
      parentName: "current vessel"
    }, { linkedPatchType: "orbitPatch" }
    )
  },

  formatManeuverNodes: function (positionData, formattedData) {
    for (var i = 0; i < positionData["o.maneuverNodes"].length; i++) {
      var maneuverNode = positionData["o.maneuverNodes"][i]
      var orbitPatches = this.formatOrbitPatches(formattedData, positionData, maneuverNode.orbitPatches, {
        type: "maneuverNode", parentType: "vessel", parentName: "current vessel"
      }, { linkedPatchType: "maneuverNode" })

      for (var j = 0; j < maneuverNode.orbitPatches.length; j++) {
        var orbitPatch = maneuverNode.orbitPatches[j]
        if (orbitPatch.referenceBody != this.rootReferenceBodyName) {
          var referenceBody = positionData.referenceBodies[orbitPatch.referenceBody]
          var sortedUniversalTimes = this.sortedUniversalTimes(orbitPatch.positionData)
          var middleUniversalTime = sortedUniversalTimes[Math.floor((sortedUniversalTimes.length - 1) / 2.0)]

          var frameOfReferenceVector = this.findProjectedPositionOfReferenceBody(
            this.rootReferenceBody(positionData), referenceBody, middleUniversalTime
          )
        }
      }

      formattedData.maneuverNodes.push(this.buildManeuverNode({
        type: "maneuverNode",
        parentType: "vessel",
        parentName: "current vessel",
        orbitPatches: orbitPatches,
        truePosition: (orbitPatches.length > 0 && orbitPatches[0].truePositions.length > 0) ? orbitPatches[0].truePositions[0] : null
      }))
    }
  },

  findDistanceVectorBetweenBodiesAtTime: function (rootBody, targetBody, universalTime) {
    var closestUniversalTime = this.findTruePositionClosestToRelativeTime(universalTime, rootBody.positionData)

    return [
      rootBody.positionData[closestUniversalTime].truePosition,
      targetBody.positionData[universalTime].truePosition
    ]
  },

  findProjectedPositionOfReferenceBody: function (rootReferenceBody, body, universalTime) {
    var distancePoints = this.findDistanceVectorBetweenBodiesAtTime(rootReferenceBody, body, universalTime)
    var distanceVector = Math.matrixAdd(
      distancePoints[1],
      Math.scaleMatrix(-1, distancePoints[0])
    )
    return distanceVector
  },

  truePositionForRelativePosition: function (relativePositionVector, frameOfReferenceVector) {
    // Telemachus relativePosition is [X, Z, Y] (Z-up), so we swap back to [X, Y, Z] (Y-up world)
    var transformedRelativePositionVector = [relativePositionVector[0], relativePositionVector[2], relativePositionVector[1]];
    return Math.matrixAdd(frameOfReferenceVector, transformedRelativePositionVector)
  },

  findTruePositionClosestToRelativeTime: function (universalTime, positionData) {
    var positionDataKeys = Object.keys(positionData)
    var sortedUniversalTimes = positionDataKeys.sort(function (a, b) { return parseFloat(a) - parseFloat(b) }).map(function (x) { return parseFloat(x) })

    var closestTime = null
    var closestDistance = null

    for (var i = 0; i < sortedUniversalTimes.length; i++) {
      var time = sortedUniversalTimes[i]
      var distance = Math.abs(universalTime - time)

      if ((closestTime == null && closestDistance == null) || distance < closestDistance) {
        closestTime = time
        closestDistance = distance
      }
    }

    return closestTime
  },

  formatOrbitPatches: function (formattedData, positionData, rawOrbitPatches, orbitPatchOptions, referenceBodyOptions) {
    var formattedOrbitPatches = []
    var lastPatchesPoint = null
    var firstPointInPatch = null
    referenceBodyOptions = referenceBodyOptions || {}

    for (var j = 0; j < rawOrbitPatches.length; j++) {
      var orbitPatch = rawOrbitPatches[j]
      var referenceBody = positionData.referenceBodies[orbitPatch.referenceBody]
      var sortedUniversalTimes = this.sortedUniversalTimes(orbitPatch.positionData)
      var positions = []
      var distanceFromLastPatchesPoint = null
      var middleUniversalTime = sortedUniversalTimes[Math.floor((sortedUniversalTimes.length - 1) / 2)]

      for (var k = 0; k < sortedUniversalTimes.length; k++) {
        var key = sortedUniversalTimes[k]
        var utVal = parseFloat(key)

        if (orbitPatch.referenceBody == this.rootReferenceBodyName || orbitPatch.referenceBody == "Sun") {
          var frameOfReferenceVector = this.formatTruePositionVector(referenceBody.currentTruePosition)
        } else {
          var frameOfReferenceVector = this.findProjectedPositionOfReferenceBody(
            this.rootReferenceBody(positionData), referenceBody, utVal
          )
        }

        var relativePositionVector = orbitPatch.positionData[key].relativePosition

        var projectedTruePosition = this.truePositionForRelativePosition(
          relativePositionVector, frameOfReferenceVector
        )

        if (lastPatchesPoint != null) {
          if (k == 0) {
            firstPointInPatch = projectedTruePosition
            distanceFromLastPatchesPoint = [
              lastPatchesPoint[0] - firstPointInPatch[0],
              lastPatchesPoint[1] - firstPointInPatch[1],
              lastPatchesPoint[2] - firstPointInPatch[2],
            ]
          }

          var projectedTruePosition = [
            projectedTruePosition[0] + distanceFromLastPatchesPoint[0],
            projectedTruePosition[1] + distanceFromLastPatchesPoint[1],
            projectedTruePosition[2] + distanceFromLastPatchesPoint[2],
          ]

          if (middleUniversalTime == sortedUniversalTimes[k] && orbitPatch.referenceBody != this.rootReferenceBodyName) {
            var positionOfReferenceBody = [
              frameOfReferenceVector[0] + distanceFromLastPatchesPoint[0],
              frameOfReferenceVector[1] + distanceFromLastPatchesPoint[1],
              frameOfReferenceVector[2] + distanceFromLastPatchesPoint[2],
            ]

            formattedData["referenceBodies"].push(this.buildReferenceBody(Object.extend({
              name: orbitPatch.referenceBody,
              type: "projected",
              radius: referenceBody.radius,
              truePosition: positionOfReferenceBody,
              linkedPatchID: j,
              atmosphericRadius: this.datalink.getOrbitalBodyInfo(orbitPatch.referenceBody).atmosphericRadius
            }, referenceBodyOptions)))
          }
        }

        positions.push(projectedTruePosition)
      }

      lastPatchesPoint = positions.last()

      formattedOrbitPatches.push(this.buildOrbitPatch(Object.extend({
        truePositions: positions
      }, orbitPatchOptions)))
    }

    return formattedOrbitPatches
  },

  formatTruePositionVector: function (vector) {
    if (this.rootOrigin && vector) {
      // THE BIBLE: X stays X, Z stays Z, but Y is Inverted (10 to -20 logic)
      return [
        vector[0] - this.rootOrigin[0],
        -(vector[1] - this.rootOrigin[1]), // VERTICAL INVERSION
        vector[2] - this.rootOrigin[2]
      ];
    }
    return vector;
  },

  buildReferenceBody: function (options) {
    return {
      name: options.name,
      type: options.type,
      radius: options.radius,
      truePosition: options.truePosition,
      linkedPatchID: options.linkedPatchID,
      linkedPatchType: options.linkedPatchType,
      atmosphericRadius: options.atmosphericRadius,
      color: options.color
    }
  },

  buildReferenceBodyPath: function (options) {
    return {
      referenceBodyName: options.referenceBodyName,
      truePositions: options.truePositions
    }
  },

  buildVessel: function (options) {
    return {
      name: options.name,
      type: options.type,
      truePosition: options.truePosition,
      referenceBodyName: options.referenceBodyName
    }
  },

  buildOrbitPatch: function (options) {
    return {
      type: options.type,
      parentType: options.parentType,
      parentName: options.parentName,
      truePositions: options.truePositions
    }
  },

  buildManeuverNode: function (options) {
    return {
      type: options.type,
      parentType: options.parentType,
      parentName: options.parentName,
      orbitPatches: options.orbitPatches,
      truePosition: options.truePosition
    }
  },

  buildDistanceFromRootReferenceBody: function (options) {
    return {
      referenceBodyName: options.referenceBodyName,
      truePositions: options.truePositions
    }
  },

  sortedUniversalTimes: function (positionData) {
    var positionDataKeys = Object.keys(positionData)
    return positionDataKeys.sort(function (a, b) { return parseFloat(a) - parseFloat(b) })
  },

  rootReferenceBody: function (positionData) {
    return positionData.referenceBodies[this.rootReferenceBodyName]
  }
})