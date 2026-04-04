/**
 * SystemOrbitalPositionData (ES6)
 * Handles fetching and caching of orbital data from Telemachus.
 * Powering the premium 3D Map HUD and Orientation Sphere.
 */
class SystemOrbitalPositionData {
  constructor(datalink, options = {}) {
    this.datalink = datalink;
    this.timeoutRate = 1000;
    this.mutexTimestamp = null;
    this.rootReferenceBody = null;
    this.options = Object.assign({
      numberOfSegments: 256,
      onRecalculate: null
    }, options);

    this.planetStaticOrbitsFetched = false;
    this.staticOrbitRequestParams = {};
    this.cachedKeplerian = null;
    this.cachedPlanetPaths = {};

    this.initializeDatalink();
  }

  isLocked() {
    return this.mutexTimestamp && this.mutexTimestamp < ((Date.now() / 1000 | 0) + this.timeoutRate);
  }

  mutexLock() { this.mutexTimestamp = Date.now(); }
  mutexUnlock() { this.mutexTimestamp = null; }

  recalculate(data) {
    if (this.isLocked()) return;
    this.mutexLock();

    Object.assign(data, {
      "currentUniversalTime": data['t.universalTime'],
      "vesselBody": data['v.body'],
      "vesselCurrentPosition": { "relativePosition": null },
      "targetCurrentPosition": { "relativePosition": null },
    });

    this.getPositionsAndRecalculate(data);
  }

  getPositionsAndRecalculate(positionData) {
    const requestParams = {};
    const referenceBody = this.datalink.getOrbitalBodyInfo(positionData["vesselBody"]) || this.datalink.getOrbitalBodyInfo("Kerbin");
    this.rootReferenceBody = referenceBody;

    if (referenceBody) {
      requestParams["currentReferenceBodyRadius"] = `b.radius[${referenceBody.id}]`;
      requestParams["currentReferenceBodyTruePosition"] = `b.o.truePositionAtUT[${referenceBody.id},${positionData["currentUniversalTime"]}]`;
    }

    requestParams["vesselCurrentPositionRelativePosition"] = `o.relativePositionAtUTForOrbitPatch[0,${positionData["currentUniversalTime"]}]`;

    this.buildRelativePositionRequestsForOrbitPatches(requestParams, "vesselCurrentOrbit", positionData['o.orbitPatches'], positionData["currentUniversalTime"]);
    this.buildRelativePositionRequestsForManeuverNodeOrbitPatches(requestParams, "vesselManeuverNodes", positionData['o.maneuverNodes'], positionData["currentUniversalTime"]);

    if (positionData['tar.type']) {
      if (positionData['tar.o.orbitPatches'] && positionData['tar.o.orbitPatches'].length > 0) {
        this.buildRelativePositionRequestsForOrbitPatches(requestParams, "targetCurrentOrbit", positionData['tar.o.orbitPatches'], positionData["currentUniversalTime"], 'tar.o');
        requestParams["targetCurrentPositionRelativePosition"] = `tar.o.relativePositionAtUTForOrbitPatch[0,${positionData["currentUniversalTime"]}]`;
      } else {
        const body = this.datalink.getOrbitalBodyInfo(positionData['tar.name']);
        if (body) {
          requestParams[`${body.name}[metadata]radius`] = `b.radius[${body.id}]`;
          requestParams[`${body.name}[${positionData["currentUniversalTime"]}]TruePosition`] = `b.o.truePositionAtUT[${body.id},${positionData["currentUniversalTime"]}]`;
        }
      }
    }

    const bodies = this.datalink.getOrbitalBodies();
    Object.keys(bodies).forEach(bName => {
      const bInfo = bodies[bName];
      if (bName !== "Sun" && bName !== "Kerbin" && bInfo.referenceBodyName !== "Kerbin") return;

      requestParams[`${bName}[metadata]radius`] = `b.radius[${bInfo.id}]`;
      requestParams[`${bName}[metadata]currentTruePosition`] = `b.o.truePositionAtUT[${bInfo.id},${positionData["currentUniversalTime"]}]`;

      if (!this.planetStaticOrbitsFetched && bName !== "Sun") {
        requestParams[`${bName}[metadata]sma`] = `b.o.sma[${bInfo.id}]`;
        requestParams[`${bName}[metadata]eccentricity`] = `b.o.eccentricity[${bInfo.id}]`;
        requestParams[`${bName}[metadata]inclination`] = `b.o.inclination[${bInfo.id}]`;
        requestParams[`${bName}[metadata]argPe`] = `b.o.argumentOfPeriapsis[${bInfo.id}]`;
        requestParams[`${bName}[metadata]lan`] = `b.o.lan[${bInfo.id}]`;
      }
    });

    this.datalink.sendMessage(requestParams, (data) => {
      positionData["currentReferenceBodyRadius"] = data["currentReferenceBodyRadius"];
      positionData["currentReferenceBodyTruePosition"] = data["currentReferenceBodyTruePosition"];

      this.buildReferenceBodyPositionData(data, positionData);
      this.buildReferenceBodyMetadata(data, positionData);

      positionData["vesselCurrentPosition"]["relativePosition"] = data["vesselCurrentPositionRelativePosition"];
      this.buildRelativePositionPositionDataForOrbitPatches(data, positionData, "vesselCurrentOrbit", 'o.orbitPatches');

      if (positionData['o.maneuverNodes']) {
        this.buildRelativePositionPositionDataForManeuverNodeOrbitPatches(data, positionData, "vesselManeuverNodes", 'o.maneuverNodes');
      }

      if (positionData['tar.type'] && positionData['tar.o.orbitPatches'] && positionData['tar.o.orbitPatches'].length > 0) {
        if (data["targetCurrentPositionRelativePosition"]) {
            positionData["targetCurrentPosition"]["relativePosition"] = data["targetCurrentPositionRelativePosition"];
        }
        this.buildRelativePositionPositionDataForOrbitPatches(data, positionData, "targetCurrentOrbit", 'tar.o.orbitPatches');
      }

      this.mutexUnlock();
      if (this.options.onRecalculate) this.options.onRecalculate(positionData);
    });
  }

  buildRelativePositionRequestsForOrbitPatches(requestParams, orbitPatchType, orbitPatches, currentUniversalTime, requestPrefix = 'o') {
    if (!orbitPatches || !orbitPatches.length) return;
    for (let i = 0; i < orbitPatches.length; i++) {
      const orbitPatch = orbitPatches[i];
      const startUT = orbitPatch["startUT"];
      const endUT = orbitPatch["endUT"];
      const referenceBody = this.datalink.getOrbitalBodyInfo(orbitPatch["referenceBody"]);
      const timeInterval = (endUT - startUT) / this.options.numberOfSegments;

      for (let j = 0; j < this.options.numberOfSegments; j++) {
        let UTForInterval = startUT + (timeInterval * j);
        if (UTForInterval > endUT) UTForInterval = endUT;

        requestParams[`${this.rootReferenceBody.name}[${UTForInterval}]TruePosition`] = `b.o.truePositionAtUT[${this.rootReferenceBody.id},${UTForInterval}]`;
        requestParams[`${orbitPatchType}[${i}][${UTForInterval}]RelativePosition`] = `${requestPrefix}.relativePositionAtUTForOrbitPatch[${i},${UTForInterval}]`;
        requestParams[`${orbitPatch["referenceBody"]}[${UTForInterval}]TruePosition`] = `b.o.truePositionAtUT[${referenceBody.id},${UTForInterval}]`;
      }
    }
  }

  buildRelativePositionRequestsForManeuverNodeOrbitPatches(requestParams, maneuverNodeType, maneuverNodes, currentUniversalTime) {
    if (!maneuverNodes || !maneuverNodes.length) return;
    const requestPrefix = "o.maneuverNodes.relativePositionAtUTForManeuverNodesOrbitPatch";
    for (let i = 0; i < maneuverNodes.length; i++) {
      const maneuverNode = maneuverNodes[i];
      const labelPrefix = `${maneuverNodeType}[${i}]`;

      for (let j = 0; j < maneuverNode['orbitPatches'].length; j++) {
        const orbitPatch = maneuverNode['orbitPatches'][j];
        const startUT = orbitPatch["startUT"];
        const endUT = orbitPatch["endUT"];
        const period = orbitPatch["period"];
        const referenceBody = this.datalink.getOrbitalBodyInfo(orbitPatch["referenceBody"]);
        const expectedUT = startUT + period;

        const timeInterval = (endUT - startUT) / this.options.numberOfSegments;

        for (let k = 0; k < this.options.numberOfSegments; k++) {
          let UTForInterval = startUT + (timeInterval * k);
          if (UTForInterval > endUT) UTForInterval = endUT;

          requestParams[`${this.rootReferenceBody.name}[${UTForInterval}]TruePosition`] = `b.o.truePositionAtUT[${this.rootReferenceBody.id},${UTForInterval}]`;
          requestParams[`${labelPrefix}[${j}][${UTForInterval}]RelativePosition`] = `${requestPrefix}[${i},${j},${UTForInterval}]`;
          requestParams[`${orbitPatch["referenceBody"]}[${UTForInterval}]TruePosition`] = `b.o.truePositionAtUT[${referenceBody.id},${UTForInterval}]`;
        }
      }
    }
  }

  buildRelativePositionPositionDataForOrbitPatches(rawData, positionData, orbitPatchType, orbitPatchesKey) {
    const regex = new RegExp(`${orbitPatchType}\\[(\\d+)\\]\\[([\\d\\.]+)\\]RelativePosition`);
    const orbitPatches = positionData[orbitPatchesKey] = positionData[orbitPatchesKey] || {};

    Object.keys(rawData).forEach(key => {
      if (regex.test(key)) {
        const [, index, ut] = regex.exec(key);
        const orbitPatch = orbitPatches[index] = orbitPatches[index] || {};
        const posData = orbitPatch["positionData"] = orbitPatch["positionData"] || {};
        posData[ut] = posData[ut] || {};
        posData[ut]["relativePosition"] = rawData[key];
      }
    });
  }

  buildRelativePositionPositionDataForManeuverNodeOrbitPatches(rawData, positionData, maneuverNodeType, maneuverNodesKey) {
    const regex = new RegExp(`${maneuverNodeType}\\[(\\d+)\\]\\[(\\d+)\\]\\[([\\d\\.]+)\\]RelativePosition`);
    const maneuverNodes = positionData[maneuverNodesKey] = positionData[maneuverNodesKey] || {};

    Object.keys(rawData).forEach(key => {
      if (regex.test(key)) {
        const [, mIndex, oIndex, ut] = regex.exec(key);
        const orbitPatch = maneuverNodes[mIndex]['orbitPatches'][oIndex] = maneuverNodes[mIndex]['orbitPatches'][oIndex] || {};
        const posData = orbitPatch["positionData"] = orbitPatch["positionData"] || {};
        posData[ut] = posData[ut] || {};
        posData[ut]["relativePosition"] = rawData[key];
      }
    });
  }

  buildReferenceBodyPositionData(rawData, positionData) {
    const regex = new RegExp(/(\w+)\[([\d\.]+)\]TruePosition$/);
    Object.keys(rawData).forEach(key => {
      if (regex.test(key)) {
        const [, name, ut] = regex.exec(key);
        const refBodies = positionData["referenceBodies"] = positionData["referenceBodies"] || {};
        const body = refBodies[name] = refBodies[name] || {};
        body["positionData"] = body["positionData"] || {};
        body["positionData"][ut] = body["positionData"][ut] || {};
        body["positionData"][ut]["truePosition"] = rawData[key];
      }
    });
  }

  buildReferenceBodyMetadata(rawData, positionData) {
    const regex = new RegExp(/(\w+)\[metadata\](\w+)$/);
    Object.keys(rawData).forEach(key => {
      if (regex.test(key)) {
        const [, name, field] = regex.exec(key);
        const refBodies = positionData["referenceBodies"] = positionData["referenceBodies"] || {};
        const body = refBodies[name] = refBodies[name] || {};
        body[field] = rawData[key];
      }
    });
  }

  initializeDatalink() {
    this.datalink.subscribeToData([
      'o.orbitPatches', 't.universalTime', 'v.body',
      'tar.name', 'tar.type', 'tar.o.orbitingBody',
      'tar.o.orbitPatches', 'o.maneuverNodes',
      'v.altitude', 'o.ApA', 'o.PeA', 'o.inclination',
      'o.eccentricity', 'o.period',
      'n.pitch', 'n.roll', 'n.heading',
      'o.encounterBody', 'o.encounterTime',
      'astg.nextDestination', 'astg.nextBurnCountdown', 'astg.nextDeltaV'
    ]);
    this.datalink.addReceiverFunction(this.recalculate.bind(this));
  }
}

window.SystemOrbitalPositionData = SystemOrbitalPositionData;
