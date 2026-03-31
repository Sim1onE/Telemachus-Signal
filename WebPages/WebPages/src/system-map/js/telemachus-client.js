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
    this.rate = 500;
    this.loopTimeout = null;

    // Start the polling loop
    this.startPolling();
  }

  get url() {
    // Dynamically resolve protocol and host to support secure tunnels (ngrok)
    const protocol = window.location.protocol === 'https:' ? 'https:' : 'http:';
    const host = this.host === "localhost" || !this.host ? window.location.hostname : this.host;
    const port = this.port || window.location.port;

    return `${protocol}//${host}${port ? ':' + port : ''}/telemachus/datalink`;
  }

  updateConnection(host, port) {
    this.host = host;
    this.port = port;
  }

  addReceiverFunction(func) {
    this.receiverFunctions.push(func);
  }

  subscribeToData(fields) {
    fields.forEach(field => {
      this.subscribedFields[field] = field;
    });
  }

  /**
   * Sending generic datalink parameters (polling strategy).
   */
  async sendMessage(params, callback) {
    try {
      const response = await fetch(this.url, {
        method: "POST",
        body: JSON.stringify(params),
        headers: {
          "Content-Type": "application/json"
        }
      });

      if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);

      const rawData = await response.json();
      const data = this.convertData(rawData);
      if (callback) callback(data);
    } catch (e) {
      console.error("Telemachus POST Error:", e);
    }
  }

  /**
   * Command Bridge (SEND commands instead of polling data).
   * Follows Houston's "command-as-key" pattern.
   */
  async sendCommand(command, callback) {
    const params = {};
    params[command] = command;

    try {
      const response = await fetch(this.url, {
        method: "POST",
        body: JSON.stringify(params),
        headers: {
          "Content-Type": "application/json"
        }
      });

      if (response.ok) {
        const rawData = await response.json();
        const data = this.convertData(rawData);
        if (callback) callback(data);
      }
    } catch (e) {
      console.error("Telemachus Command Error:", e);
    }
  }

  addManeuverNode(ut, callback) {
    const cmd = `o.addManeuverNode[${ut},0,0,0]`;
    this.sendCommand(cmd, callback);
  }

  updateManeuverNode(index, ut, radial, normal, prograde, callback) {
    const cmd = `o.updateManeuverNode[${index},${ut},${radial},${normal},${prograde}]`;
    this.sendCommand(cmd, callback);
  }

  removeManeuverNode(index, callback) {
    const cmd = `o.removeManeuverNode[${index}]`;
    this.sendCommand(cmd, callback);
  }

  convertData(rawData) {
    const data = {};
    Object.keys(rawData).forEach(key => {
      const convertedFieldName = key.replace(/\{/g, "[").replace(/\}/g, "]");
      data[convertedFieldName] = rawData[key];
    });
    return data;
  }

  async poll() {
    const fieldsToPoll = this.subscribedFields;
    const params = Object.keys(fieldsToPoll).map(field => {
      const sanitizedFieldName = field.replace(/\[/g, "{").replace(/\]/g, "}");
      return `${sanitizedFieldName}=${field}`;
    });
    const requestURL = `${this.url}?${params.join("&")}`;

    try {
      const response = await fetch(requestURL);
      if (response.ok) {
        const rawData = await response.json();
        const data = this.convertData(rawData);
        this.dispatchMessages(data);
      }
    } catch (e) {
      console.warn("Telemachus Poll Error (Likely LOS):", e);
      document.dispatchEvent(new CustomEvent('telemachus:loss-of-signal'));
    }

    this.loopTimeout = setTimeout(() => this.poll(), this.rate);
  }

  dispatchMessages(data) {
    this.receiverFunctions.forEach(func => {
      try { func(data); } catch (e) { console.error("Telemachus Dispatch Error:", e); }
    });
  }

  startPolling() {
    if (this.loopTimeout) clearTimeout(this.loopTimeout);
    this.poll();
  }

  getOrbitalBodyInfo(name) {
    const properties = this.orbitingBodies[name];
    return properties ? Object.assign({ name: name }, properties) : null;
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

    if (!this.host) this.host = this.defaultHost;
    if (!this.port) this.port = this.defaultPort;
  }
  get host() { return localStorage.getItem('host') }
  set host(value) { localStorage.setItem('host', value); }

  get port() { return localStorage.getItem('port') }
  set port(value) { localStorage.setItem('port', value); }
}

window.Telemachus = Telemachus;
window.Settings = Settings;
走
