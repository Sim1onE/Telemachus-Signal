/**
 * Telemachus Client (ES6)
 * A standalone, high-performance bridge to the KSP Telemachus DataLink.
 * Replaces the legacy Prototype.js-based telemachus.js.
 * Optimized for real-time telemetry and 2D/3D maneuver manipulation.
 */
class Telemachus {
  constructor(host, port) {
    this.host = host;
    this.port = port;
    this.receiverFunctions = [];
    this.subscribedFields = {};
    this.orbitingBodies = this.getOrbitalBodies();
    
    // v21.8: WebSocket Connection (SignalLink)
    const streamUrl = TelemachusSignalLink.detectStreamUrl();
    this.signalLink = new TelemachusSignalLink(streamUrl, this);

    this.signalLink.on('open', () => {
        console.log("[SystemMap] WebSocket Link established.");
        this.signalLink.subscribeTick(); // Basic clock
        this.resubscribeAll();
    });

    this.signalLink.on('datalink_update', (msg) => {
        this.dispatchMessages(msg.data);
    });

    this.signalLink.connect();
  }

  get lastDatalinkData() {
    return this.signalLink ? this.signalLink.lastDatalinkData : {};
  }

  resubscribeAll() {
    const keys = Object.keys(this.subscribedFields);
    if (keys.length > 0) {
        this.signalLink.subscribeTelemetry(keys);
    }
  }

  updateConnection(host, port) {
    this.host = host;
    this.port = port;
    // SignalLink normally detects the URL automatically, 
    // but if we force it, we'd need to recreate the link.
  }

  addReceiverFunction(func) {
    this.receiverFunctions.push(func);
  }

  subscribeToData(fields) {
    fields.forEach(field => {
      this.subscribedFields[field] = field;
    });
    if (this.signalLink.ws && this.signalLink.ws.readyState === WebSocket.OPEN) {
        this.signalLink.subscribeTelemetry(fields);
    }
  }

  /**
   * v21.8: Sending generic datalink parameters via WebSocket command.
   */
  async sendMessage(params, callback) {
    this.signalLink.sendRequest("command", "telemetry", { values: params }, (data) => {
        if (callback) callback(data);
    });
  }

  /**
   * Command Bridge (SEND commands instead of polling data).
   */
  sendManeuverUpdate(index, ut, radial, normal, prograde) {
    const cmd = `o.updateManeuverNode[${index},${ut},${radial},${normal},${prograde}]`;
    this.sendMessage({ [cmd]: cmd });
  }

  sendNodeAction(action, nodeIndex = 0, utOffset = 1000) {
    if (action === 'add') {
      this.sendMessage({ "t.universalTime": "t.universalTime" }, (data) => {
        const ut = data["t.universalTime"] + utOffset;
        const cmd = `o.addManeuverNode[${ut},0,0,0]`;
        this.sendMessage({ [cmd]: cmd });
      });
    } else {
      const cmd = `o.removeManeuverNode[${nodeIndex}]`; 
      this.sendMessage({ [cmd]: cmd });
    }
  }

  convertData(rawData) {
    const data = {};
    Object.keys(rawData).forEach(key => {
      const convertedFieldName = key.replace(/\{/g, "[").replace(/\}/g, "]");
      data[convertedFieldName] = rawData[key];
    });
    return data;
  }

  dispatchMessages(data) {
    // v21.8.10: Enrich data with last known UT to satisfy legacy modules
    if (data && !data['t.universalTime'] && this.signalLink && this.signalLink.lastPacketUT) {
        data['t.universalTime'] = this.signalLink.lastPacketUT;
    }

    this.receiverFunctions.forEach(func => {
      try { func(data); } catch (e) { console.error("Telemachus Dispatch Error:", e); }
    });
  }

  startPolling() {
      // Obsolete in WebSocket mode
  }

  getOrbitalBodyInfo(name) {
    // Case-insensitive lookup
    const key = Object.keys(this.orbitingBodies).find(k => k.toLowerCase() === (name || '').toLowerCase()) || name;
    const properties = this.orbitingBodies[key];
    return properties ? Object.assign({ name: key }, properties) : null;
  }

  // v21.8.19: Update orbital body registry from dynamic server manifest
  updateOrbitalBodies(manifest) {
    Object.keys(manifest).forEach(bodyName => {
      const body = manifest[bodyName];
      if (!this.orbitingBodies[bodyName]) {
        this.orbitingBodies[bodyName] = {};
      }
      // Overwrite with authoritative server data
      if (body.parent !== undefined) this.orbitingBodies[bodyName].referenceBodyName = body.parent;
      if (body.radius !== undefined) this.orbitingBodies[bodyName].radius = body.radius;
    });
  }

  getOrbitalBodies() {
    return {
      "Sun": { id: 0, referenceBodyName: null, color: '#FFFF00', surfaceGravity: 17.1 },
      "Kerbin": { id: 1, referenceBodyName: "Sun", atmosphericRadius: 70000, color: '#4a5472', surfaceGravity: 9.81 },
      "Mun": { id: 2, referenceBodyName: "Kerbin", atmosphericRadius: 0, color: '#e2e0d7', surfaceGravity: 1.63 },
      "Minmus": { id: 3, referenceBodyName: "Kerbin", atmosphericRadius: 0, color: '#98f2c5', surfaceGravity: 0.491 },
      "Moho": { id: 4, referenceBodyName: "Sun", atmosphericRadius: 0, color: '#fdc39e', surfaceGravity: 2.70 },
      "Eve": { id: 5, referenceBodyName: "Sun", atmosphericRadius: 90000, color: '#c394fe', surfaceGravity: 16.7 },
      "Duna": { id: 6, referenceBodyName: "Sun", atmosphericRadius: 50000, color: '#fc5e49', surfaceGravity: 2.94 },
      "Ike": { id: 7, referenceBodyName: "Duna", atmosphericRadius: 0, color: '#e2e0d7', surfaceGravity: 1.10 },
      "Jool": { id: 8, referenceBodyName: "Sun", atmosphericRadius: 200000, color: '#C5DCAB', surfaceGravity: 7.85 },
      "Laythe": { id: 9, referenceBodyName: "Jool", atmosphericRadius: 50000, color: '#a8b4fe', surfaceGravity: 7.85 },
      "Vall": { id: 10, referenceBodyName: "Jool", atmosphericRadius: 0, color: '#b0f4fe', surfaceGravity: 2.31 },
      "Bop": { id: 11, referenceBodyName: "Jool", atmosphericRadius: 0, color: '#c64605', surfaceGravity: 0.589 },
      "Tylo": { id: 12, referenceBodyName: "Jool", atmosphericRadius: 0, color: '#fdf7ed', surfaceGravity: 7.85 },
      "Gilly": { id: 13, referenceBodyName: "Eve", atmosphericRadius: 0, color: '#fdcbb1', surfaceGravity: 0.049 },
      "Pol": { id: 14, referenceBodyName: "Jool", atmosphericRadius: 0, color: '#fec681', surfaceGravity: 0.373 },
      "Dres": { id: 15, referenceBodyName: "Sun", atmosphericRadius: 0, color: '#fef8f9', surfaceGravity: 1.13 },
      "Eeloo": { id: 16, referenceBodyName: "Sun", atmosphericRadius: 0, color: '#e5fafe', surfaceGravity: 1.69 }
    };
  }
}

class Settings {
  constructor(defaultHost, defaultPort) {
    this.defaultHost = defaultHost || window.location.hostname || "localhost";
    this.defaultPort = defaultPort || window.location.port || "8085";
  }
  get host() { return localStorage.getItem('host') || this.defaultHost; }
  set host(value) { localStorage.setItem('host', value); }
  get port() { return localStorage.getItem('port') || this.defaultPort; }
  set port(value) { localStorage.setItem('port', value); }
}

window.Telemachus = Telemachus;
window.Settings = Settings;
