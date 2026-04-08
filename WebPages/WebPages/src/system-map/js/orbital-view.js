/**
 * SystemOrbitalMap (ES6)
 * A modern, independent Three.js renderer for the Telemachus 3D Map.
 */
class SystemOrbitalMap {
  constructor(positionDataFormatter, datalink, containerID) {
    this.positionDataFormatter = positionDataFormatter;
    this.container = document.getElementById(containerID);
    this.datalink = datalink;
    this.targetReadout = null;
    this.btnRendezvous = null;

    this.lastNodeData = {
      UT: 0,
      deltaV: [0, 0, 0]
    };

    this.GUIParameters = {
      "focusBody": 'current vessel'
    };

    this.distanceScaleFactor = 1;
    this.referenceBodyScaleFactor = 1;
    this.sunBodyScaleFactor = 1.1; // Minimal boost for Sun visibility
    this.dashedLineLength = 100000; // 100km dashes
    this.maxLengthInThreeJS = 2000;
    this.vehicleLength = 20000.0; // 20km indicator in pure meters
    this.defaultZoomFactor = 40;

    this.bodyNames = []; // v21.8.15: Populated dynamically from manifest
    this.orbitPathColors = [
      "#4d94ff", "#ff00ff", "#00e600", "#ff9900", "#9933ff",
      "#ffcc00", "#00ccff", "#ff5050", "#00cccc", "#ffccff"
    ];
    this.targetColor = '#51ff07';

    this.cameraSet = false;
    this.registry = {
      bodies: {},
      orbits: {},
      celestialOrbits: {}, // v21.8.15: Registry for static planetary orbits
      vessels: {},
      nodes: {},
      patches: {},
      paths: {}
    };

    // v21.8.31: Inject registry into the formatter for stable analytical solving
    if (this.positionDataFormatter) {
      this.positionDataFormatter.registry = this.registry;
    }
    this.bodyRadii = {};
    this.bodyToggles = {};
    this.isSliderInteracting = false;
    this.activeNodeIndex = 0;
    this.maneuverInterval = null;

    this.buildSceneCameraAndRenderer();
    this.navball = new Navball('navball-container');

    // v21.8.12: Load global planetary texture (shared legacy asset)
    this.textureLoader = new THREE.TextureLoader();
    this.planetTexture = this.textureLoader.load('../assets/images/navball.png');

    this.positionDataFormatter = positionDataFormatter;
    this.positionDataFormatter.options.onFormat = (data) => this.render(data);
  }

  setupCustomUI() {
    // Focus Selector
    const focusSelector = document.getElementById('focus-selector');
    if (focusSelector) {
      focusSelector.addEventListener('change', (e) => {
        this.GUIParameters.focusBody = e.target.value;
        this.cameraSet = false;
        this.triggerRender();
      });
    }


    // Node Selector
    const nodeSelector = document.getElementById('node-selector');
    if (nodeSelector) {
      nodeSelector.addEventListener('change', (e) => {
        this.activeNodeIndex = parseInt(e.target.value);
        this.cameraSet = false;
        this.triggerRender();
      });
    }

    // Action Buttons
    const btnReset = document.getElementById('btn-reset');
    if (btnReset) btnReset.addEventListener('click', () => this.resetPosition());

    const btnFull = document.getElementById('btn-fullscreen');
    if (btnFull) btnFull.addEventListener('click', () => this.toggleFullscreen());

    // Tactical Add Buttons
    const btnAddAtUt = document.getElementById('btn-add-at-ut');
    if (btnAddAtUt) btnAddAtUt.addEventListener('click', () => this.addNodeAt('UT'));

    const utInput = document.getElementById('node-ut-offset');
    if (utInput) {
      utInput.addEventListener('input', () => this.triggerRender());
    }

    const btnDel = document.getElementById('btn-del-node');
    if (btnDel) btnDel.addEventListener('click', () => {
      this.datalink.sendNodeAction('del', this.activeNodeIndex);
      if (this.activeNodeIndex > 0) this.activeNodeIndex--;
      const selector = document.getElementById('node-selector');
      if (selector) selector.value = this.activeNodeIndex;
    });

    // Spring-Loaded Sliders
    const sliders = ['pro', 'norm', 'rad'];
    sliders.forEach(type => {
      const slider = document.getElementById('slider-' + type);
      if (slider) {
        slider.addEventListener('input', () => {
          this.isSliderInteracting = true;
          slider.classList.remove('slider-snap');
          this.startManeuverLoop();
        });

        const resetSlider = () => {
          this.isSliderInteracting = false;
          slider.classList.add('slider-snap');
          slider.value = 0;
          this.stopManeuverLoop();
        };

        slider.addEventListener('mouseup', resetSlider);
        slider.addEventListener('touchend', resetSlider);
        slider.addEventListener('mouseleave', resetSlider);
      }
    });


    this.btnRendezvous = document.getElementById('btn-rendezvous');
    if (this.btnRendezvous) {
      this.btnRendezvous.addEventListener('click', () => this.initiateRendezvous());
    }
  }

  initiateRendezvous() {
    const d = this.datalink.lastDatalinkData;
    if (!d || !d['tar.type']) return;

    // 1. Gather Vessel Elements
    const vessel = {
      sma: d['o.sma'],
      period: d['o.period'],
      trueAnomaly: d['o.trueAnomaly'],
      lan: d['o.lan'],
      argumentOfPeriapsis: d['o.argumentOfPeriapsis'],
      eccentricity: d['o.eccentricity'] || 0
    };

    // 2. Gather Target Elements
    const target = {
      sma: d['tar.o.sma'],
      period: d['tar.o.period'],
      trueAnomaly: d['tar.o.trueAnomaly'],
      lan: d['tar.o.lan'],
      argumentOfPeriapsis: d['tar.o.argumentOfPeriapsis'],
      eccentricity: d['tar.o.eccentricity'] || 0
    };

    // 3. Get Mu from formatted reference body
    const bodyName = d['v.body'];
    const refBody = this.lastFormattedData && this.lastFormattedData.referenceBodies
      ? this.lastFormattedData.referenceBodies.find(b => b.name === bodyName)
      : null;
    const mu = refBody ? refBody.gravParameter : null;
    const ut = d['t.universalTime'];

    if (!vessel.sma || !target.sma || !mu) {
      console.warn("Rendezvous calculation data check failed:", { vessel, target, mu });
      alert("INSUFFICIENT ORBITAL DATA FOR RENDEZVOUS CALCULATION.\n\nEnsure you have a vessel targeted and the map has refreshed.");
      return;
    }

    const result = OrbitalPhysics.calculateBestRendezvous(vessel, target, mu, ut, 5);

    if (result) {
      console.log("Best Rendezvous calculated:", result);
      const utStr = result.ut.toFixed(2);
      const dvStr = result.dv.toFixed(3);
      const distStr = (result.separation || 0).toFixed(0);

      // Confirm with user
      if (confirm(`BEST ENCOUNTER FOUND (Window #${result.window + 1})\n\nBurn in: ${Math.floor(result.waitTime / 3600)}h ${Math.floor((result.waitTime % 3600) / 60)}m\nPredicted Separation: ${distStr}m\nDelta-V: ${dvStr} m/s\n\nCreate maneuver node?`)) {
        const cmd = `o.addManeuverNode[${result.ut},0,0,${result.dv}]`;
        this.datalink.sendMessage({ [cmd]: cmd });
      }
    } else {
      alert("ERROR: COULD NOT CALCULATE RENDEZVOUS. CHECK RELATIVE INCLINATION.");
    }
  }

  addNodeAt(type) {
    if (!this.lastFormattedData) return;
    const currentUT = this.lastFormattedData.currentUniversalTime;
    const d = this.datalink.lastDatalinkData;
    const offset = parseFloat(document.getElementById('node-ut-offset').value) || 60;

    // Logic for Stacking: we want the node to be at (currentBurnUT + offset)
    // If no nodes, currentBurnUT = vesselCurrentUT
    let targetUT = currentUT + offset;
    const nodes = d['o.maneuverNodes'] || [];
    if (nodes.length > 0) {
      // Find the UT of the LAST created node to 'stack' the new one after it
      const lastNode = nodes[nodes.length - 1];
      targetUT = lastNode.UT + offset;
    }

    const cmd = `o.addManeuverNode[${targetUT},0,0,0]`;
    this.datalink.sendMessage({ [cmd]: cmd });

    // Auto-Select Logic
    const currentNodes = d['o.maneuverNodes'] || [];
    this.activeNodeIndex = currentNodes.length;
    const selector = document.getElementById('node-selector');
    if (selector) selector.value = this.activeNodeIndex;
    this.cameraSet = false;
  }

  startManeuverLoop() {
    if (this.maneuverInterval) return;
    this.maneuverInterval = setInterval(() => {
      if (!this.lastNodeData) return;
      const proVal = parseFloat(document.getElementById('slider-pro').value);
      const normVal = parseFloat(document.getElementById('slider-norm').value);
      const radVal = parseFloat(document.getElementById('slider-rad').value);
      if (proVal === 0 && normVal === 0 && radVal === 0) return;
      const multiplier = 15;
      const getDelta = (v) => Math.sign(v) * Math.pow(Math.abs(v), 2) * multiplier;
      this.lastNodeData.deltaV[2] += getDelta(proVal);
      this.lastNodeData.deltaV[1] += getDelta(normVal);
      this.lastNodeData.deltaV[0] += getDelta(radVal);
      this.datalink.sendManeuverUpdate(this.activeNodeIndex, this.lastNodeData.UT, this.lastNodeData.deltaV[0], this.lastNodeData.deltaV[1], this.lastNodeData.deltaV[2]);
      this.triggerRender();
    }, 100);
  }

  stopManeuverLoop() {
    if (this.maneuverInterval) { clearInterval(this.maneuverInterval); this.maneuverInterval = null; }
  }

  triggerRender() { if (this.lastFormattedData) this.render(this.lastFormattedData); }

  toggleFullscreen() {
    if (!document.fullscreenEnabled) return;
    if (!document.fullscreenElement) this.container.requestFullscreen();
    else document.exitFullscreen();
  }

  buildSceneCameraAndRenderer() {
    while (this.container.firstChild) {
      this.container.removeChild(this.container.firstChild);
    }

    this.renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true });
    this.renderer.setSize(this.container.clientWidth, this.container.clientHeight);
    this.renderer.setClearColor(0x000000, 0);
    this.container.appendChild(this.renderer.domElement);
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(75, this.container.clientWidth / this.container.clientHeight, 0.1, 1e12); // Gigabit scale for full Kerbol system (meters)
    this.camera.up.set(0, 1, 0);
    this.controls = new THREE.OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.05;
    this.controls.rotateSpeed = 0.5;

    this.scene.add(new THREE.AmbientLight(0x404040));
    this.sunLight = new THREE.PointLight(0xffffff, 2, 0);
    this.scene.add(this.sunLight);
    this.group = new THREE.Group();
    this.scene.add(this.group);

    const animate = () => {
      requestAnimationFrame(animate);
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
    };
    animate();
  }

  render(formattedData) {
    if (!formattedData) return;
    var ut = formattedData.currentUniversalTime;
    const type = formattedData.type;

    // v21.8.135: Geographic vs Topological Pipeline Split
    const isFullBatch = (type === 'orbit');

    this.lastRenderUT = ut;
    this.lastFormattedData = formattedData;

    // v21.8.175: Global Geometry Flush on SOI transition
    // Prevents "ghost" orbits from flickering in the wrong coordinate system.
    if (formattedData.isBodyChanged) {
      this.clearAllOrbitPaths();
    }

    // v21.8.150: Bridge new formatter schema to legacy View API.
    // The formatter now emits referenceBodies[] and vessels[] (flat arrays).
    // Normalize them into the shapes that downstream methods expect.
    const bodies = formattedData.referenceBodies || [];

    const vesselsList = Array.isArray(formattedData.vessels) ? formattedData.vessels : [];
    const activeVessel = vesselsList.find(v => v.type === 'currentVessel') || null;
    const targetVessel = vesselsList.find(v => v.type === 'targetVessel') || null;

    // Reconstruct legacy vesselData shape expected by updateVesselGeometry etc.
    const vesselData = {
      active: activeVessel ? Object.assign({ id: 'vessel-active', orbitPatches: formattedData.orbitPatches ? formattedData.orbitPatches.filter(p => p.parentType === 'currentVessel') : [], maneuverNodes: formattedData.maneuverNodes || [] }, activeVessel) : { id: 'vessel-active', truePosition: null, orbitPatches: [], maneuverNodes: [] },
      target: targetVessel ? Object.assign({ id: 'vessel-target', orbitPatches: formattedData.orbitPatches ? formattedData.orbitPatches.filter(p => p.parentType === 'targetVessel') : [] }, targetVessel) : null
    };

    // Pipeline A: Geographic State (Every Frame - Analytical Smoothness)
    this.updateReferenceBodyGeometry(bodies);
    this.updateReferenceBodyOrbitPaths(bodies);
    this.updateVesselGeometry(vesselData);
    // v21.8.150: Orbit patches also in Pipeline A \u2014 the formatter recomputes
    // absolute patch positions every frame using the analytical body pos.
    // This makes the vessel trail follow Kerbin smoothly instead of jumping.
    this.updateOrbitPathGeometry(vesselData);
    this.updateCamera(Object.assign({}, formattedData, { bodies: bodies }));
    this.updateHUD(Object.assign({}, formattedData, { vessels: vesselData }));

    // v21.8.198: 60Hz Node Animation
    // Maneuver nodes must be recalculated every frame to stay on track during smooth extrapolation.
    this.updateManeuverNodeGeometry(vesselData.active, ut, isFullBatch);
    if (vesselData.target) {
      this.updateManeuverNodeGeometry(vesselData.target, ut, isFullBatch);
    }
  }

  updateHUD(formattedData) {
    const ut = formattedData.currentUniversalTime;
    const timeElem = document.getElementById('time-readout');
    if (timeElem) timeElem.innerText = 'UT: ' + (ut || 0).toFixed(0);

    const statsGrid = document.getElementById('vessel-stats-grid');
    if (statsGrid && this.datalink.lastDatalinkData) {
      const d = this.datalink.lastDatalinkData;
      const ap = (d['o.ApA'] / 1000).toFixed(1);
      const pe = (d['o.PeA'] / 1000).toFixed(1);
      const inc = (d['o.inclination'] || 0).toFixed(2);
      const ecc = (d['o.eccentricity'] || 0).toFixed(4);
      const alt = (d['v.altitude'] / 1000).toFixed(1);
      const body = (d['v.body'] || 'NONE').toUpperCase();

      statsGrid.innerHTML = `
        <div class="data-row"><span>BODY</span><span>${body}</span></div>
        <div class="data-row"><span>ALT</span><span>${alt}km</span></div>
        <div class="data-row"><span>AP/PE</span><span>${ap}/${pe}km</span></div>
        <div class="data-row"><span>INC/ECC</span><span>${inc}°/${ecc}</span></div>
      `;

      // Target Readout Update (Read-only, Safe)
      const targetReadout = document.getElementById('target-readout');
      if (targetReadout) {
        if (d['tar.name'] && d['tar.name'] !== "No Target" && d['tar.name'] !== "No Target Selected.") {
          targetReadout.innerText = d['tar.name'].toUpperCase();
          if (this.btnRendezvous) this.btnRendezvous.style.display = 'block';
        } else {
          targetReadout.innerText = "NO TARGET";
          if (this.btnRendezvous) this.btnRendezvous.style.display = 'none';
        }
      }


      // Encounter Info
      const encElem = document.getElementById('encounter-info');
      if (encElem) {
        const encBody = d['o.encounterBody'];
        if (encBody && encBody !== 'None' && encBody !== '') {
          const encTime = d['o.encounterTime'] || 0;
          encElem.innerText = `${encBody.toUpperCase()} ENCOUNTER: T-${(encTime / 3600).toFixed(1)}h`;
        } else {
          encElem.innerText = '';
        }
      }

      // Astrogator Delta-V (No countdown)
      const astgElem = document.getElementById('astrogator-dv');
      if (astgElem) {
        const dest = d['astg.nextDestination'] || 'NONE';
        const dv = d['astg.nextDeltaV'] ? d['astg.nextDeltaV'].toFixed(1) : '0';
        astgElem.innerText = dest !== 'NONE' ? `ASTROGATOR: ${dest.toUpperCase()} (${dv} m/s)` : '';
      }

      if (this.navball && d['n.pitch'] !== undefined) this.navball.updateOrientation(d['n.pitch'], d['n.roll'], d['n.heading']);
    }

    if (this.datalink.lastDatalinkData && this.datalink.lastDatalinkData['o.maneuverNodes']) {
      const nodes = this.datalink.lastDatalinkData['o.maneuverNodes'];

      // Predicted Stats for Node
      const predElem = document.getElementById('pred-stats');
      if (this.activeNodeIndex < nodes.length) {
        this.lastNodeData = nodes[this.activeNodeIndex];
        this.activeNodePosition = this.lastNodeData.truePosition;

        // Sliders Update (dv labels)
        const proLabel = document.getElementById('dv-pro');
        const normLabel = document.getElementById('dv-norm');
        const radLabel = document.getElementById('dv-rad');
        if (proLabel) proLabel.innerText = this.lastNodeData.deltaV.z.toFixed(1);
        if (normLabel) normLabel.innerText = this.lastNodeData.deltaV.y.toFixed(1);
        if (radLabel) radLabel.innerText = this.lastNodeData.deltaV.x.toFixed(1);

        if (predElem && formattedData.vessels.active.maneuverNodes[this.activeNodeIndex]) {
          const node = formattedData.vessels.active.maneuverNodes[this.activeNodeIndex];
          const lastPatch = node.orbitPatches[node.orbitPatches.length - 1];
          if (lastPatch && lastPatch.ApA !== undefined) {
            predElem.innerText = `PRED AP: ${(lastPatch.ApA / 1000).toFixed(1)}km | PE: ${(lastPatch.PeA / 1000).toFixed(1)}km`;
          }
        }
      }

      // Multi-Node Summary
      const summaryElem = document.getElementById('node-list-summary');
      if (summaryElem) {
        let summaryHTML = '';
        nodes.forEach((n, idx) => {
          const totalDV = Math.sqrt(Math.pow(n.deltaV.x, 2) + Math.pow(n.deltaV.y, 2) + Math.pow(n.deltaV.z, 2)).toFixed(1);
          const activeStyle = (idx === this.activeNodeIndex) ? 'color: #00ffff; font-weight: bold;' : '';
          summaryHTML += `<div style="${activeStyle}">NODE ${idx + 1}: ${totalDV} m/s</div>`;
        });
        summaryElem.innerHTML = summaryHTML;
      }
    }
  }

  updateReferenceBodyGeometry(bodies) {
    if (!bodies) return;
    for (var i = 0; i < bodies.length; i++) {
      var info = bodies[i];
      var name = info.name;
      // v22.3.2: Allow hiding any body including root stars (Sun)
      if (this.bodyToggles[name] === false) {
        if (this.registry.bodies[name]) {
          this.group.remove(this.registry.bodies[name]);
          delete this.registry.bodies[name];
        }
        // v22.3.1: Also cleanup analytical celestial orbits correctly
        const orbitId = "celestial-orbit-" + name;
        if (this.registry.celestialOrbits[orbitId]) {
          this.group.remove(this.registry.celestialOrbits[orbitId]);
          delete this.registry.celestialOrbits[orbitId];
        }
        continue;
      }

      var radius = info.radius;
      this.bodyRadii[name] = radius;

      let mesh = this.registry.bodies[name];
      if (!mesh) {
        var material = name === "Sun" ? new THREE.MeshBasicMaterial({ color: 'yellow' }) : new THREE.MeshPhongMaterial({
          color: info.color,
          shininess: 30,
          map: (name !== "Sun") ? this.planetTexture : null
        });
        mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, 32, 32), material);
        this.group.add(mesh);
        this.registry.bodies[name] = mesh;
      }

      if (info.truePosition) mesh.position.set(info.truePosition.x, info.truePosition.y, info.truePosition.z);
      
      // v22.3.2: Dynamic Stellar Lighting
      // If the body is a root (star) or named Sun, update light position
      if (name === "Sun" || !info.parent) {
          if (info.truePosition) this.sunLight.position.set(info.truePosition.x, info.truePosition.y, info.truePosition.z);
      }

      mesh.rotation.y = ((info.rotationAngle || 0) + (info.initialRotation || 0)) * (Math.PI / 180);
      this.updateCelestialOrbitGeometry(name, info);
    }
  }

  updateCelestialOrbitGeometry(name, info) {
    if (!info.orbitPath || info.orbitPath.length < 2) return;
    const id = "celestial-orbit-" + name;
    let line = this.registry.celestialOrbits[id];
    const points = info.orbitPath.map(p => new THREE.Vector3(p.x, p.y, p.z));
    const colorVal = info.color || '#555555';

    if (!line) {
      const geometry = this.createGeometryFromPoints(points, info.orbitResolution || 256);
      line = new THREE.Line(geometry, new THREE.LineBasicMaterial({
        color: colorVal,
        transparent: true,
        opacity: 0.4 // Subtle for planetary paths
      }));
      this.group.add(line);
      this.registry.celestialOrbits[id] = line;
    } else {
      this.updateLineGeometry(line, points, info.orbitResolution || 256);
    }
  }

  updateVesselGeometry(vesselData) {
    var vessels = [vesselData.active];
    if (vesselData.target) vessels.push(vesselData.target);

    var seenVessels = {};
    for (var i = 0; i < vessels.length; i++) {
      var info = vessels[i];
      if (!info || !info.truePosition) continue;

      var id = info.id;
      seenVessels[id] = true;
      let mesh = this.registry.vessels[id];
      if (!mesh) {
        mesh = new THREE.Mesh(new THREE.BoxGeometry(this.vehicleLength, this.vehicleLength, this.vehicleLength), new THREE.MeshBasicMaterial({ color: info.type === "currentVessel" ? 'white' : this.targetColor }));
        this.group.add(mesh);
        this.registry.vessels[id] = mesh;
      }
      mesh.position.set(info.truePosition.x, info.truePosition.y, info.truePosition.z);
      if (info.type === "currentVessel") this.currentVesselMesh = mesh;
    }
    // Cleanup old vessels
    for (var key in this.registry.vessels) {
      if (!seenVessels[key]) {
        this.group.remove(this.registry.vessels[key]);
        delete this.registry.vessels[key];
      }
    }
  }

  updateOrbitPathGeometry(vesselData) {
    const vessels = [vesselData.active];
    if (vesselData.target) vessels.push(vesselData.target);

    var seenPatches = {};
    var typeCounts = {}; // v21.8.38: Track active segments per entity type independently

    vessels.forEach(vessel => {
      const patches = vessel.orbitPatches || [];
      const pType = vessel.type || "vessel";

      patches.forEach((patch, idx) => {
        // v21.8.38: Identify the sliding patch for EACH entity type individually
        if (!typeCounts[pType]) typeCounts[pType] = 0;
        var isFirstForType = (typeCounts[pType] === 0);
        typeCounts[pType]++;

        var id = isFirstForType ? "patch-" + pType + "-active" : "patch-" + pType + "-" + Math.floor(patch.startUT || 0);
        seenPatches[id] = true;

        var points = patch.orbitPath.map(p => new THREE.Vector3(p.x, p.y, p.z));
        let line = this.registry.orbits[id];

        let colorVal = (pType === "targetVessel") ? this.targetColor : (isFirstForType ? "#00f2ff" : this.orbitPathColors[(typeCounts[pType] - 1) % 10]);

        if (!line) {
          var geometry = this.createGeometryFromPoints(points, 256);
          line = new THREE.Line(geometry, new THREE.LineBasicMaterial({ color: colorVal }));
          this.group.add(line);
          this.registry.orbits[id] = line;
        } else {
          line.material.color.set(colorVal);
          this.updateLineGeometry(line, points);
        }
      });
    });

    // Cleanup
    for (var key in this.registry.orbits) {
      if (!seenPatches[key]) {
        this.group.remove(this.registry.orbits[key]);
        delete this.registry.orbits[key];
      }
    }
  }

  updateManeuverNodeGeometry(activeVessel, currentUT, isFullBatch = true) {
    var nodes = activeVessel.maneuverNodes || [];
    var seenNodes = {};
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      // v21.8.39: Revert to stable index-based IDs for nodes
      // This is the most reliable anchor when UT is sliding during a countdown.
      var id = "node-" + i;
      seenNodes[id] = true;
      let marker = this.registry.nodes[id];
      if (!marker) {
        marker = new THREE.Mesh(new THREE.SphereGeometry(this.vehicleLength * 0.5, 16, 16), new THREE.MeshBasicMaterial({ color: 0xffcc00 }));
        this.group.add(marker);
        this.registry.nodes[id] = marker;
      }
      if (node.truePosition) marker.position.set(node.truePosition.x, node.truePosition.y, node.truePosition.z);

      // Maneuver Orbits
      var nodePatches = node.orbitPatches || [];
      for (var j = 0; j < nodePatches.length; j++) {
        var patch = nodePatches[j];
        var isFirstForNode = (j === 0);

        // v21.8.39: Stable Maneuver Patch ID based on Node Index
        // This prevents object recycling during UT slides.
        var patchId = id + "-patch-" + j;
        seenNodes[patchId] = true;
        // v21.8.220: Conditional Geometry Rebuild
        // We only rebuild the polyline meshes during a full server batch.
        // During smooth frames, we keep the existing lines to save performance.
        var points = patch.orbitPath.map(p => new THREE.Vector3(p.x, p.y, p.z));
        let line = this.registry.patches[patchId];
        if (!line) {
          var geometry = this.createGeometryFromPoints(points, 256);
          if (geometry) {
            geometry.computeBoundingBox();
            var dashSize = geometry.boundingBox.size().x / 40;
            line = new THREE.Line(geometry, new THREE.LineDashedMaterial({ color: '#00ffff', dashSize: dashSize, gapSize: dashSize / 2, linewidth: 3 }));
            this.group.add(line);
            this.registry.patches[patchId] = line;
          }
        } else {
          this.updateLineGeometry(line, points);
        }
      }
    }

    // Ghost Preview Sphere with Multi-Patch Support
    const utInput = document.getElementById('node-ut-offset');
    if (utInput) {
      const offset = parseFloat(utInput.value) || 0;
      const targetUT = currentUT + offset;
      const ghostId = "ghost-node";
      let ghost = this.registry.nodes[ghostId];

      if (!ghost) {
        ghost = new THREE.Mesh(new THREE.SphereGeometry(this.vehicleLength * 0.4, 32, 32), new THREE.MeshBasicMaterial({ color: 0x00ff00, transparent: true, opacity: 0.5 }));
        this.group.add(ghost);
        this.registry.nodes[ghostId] = ghost;
      }

      // Target the ACTIVE maneuver node's patches for stacked planning
      let targetPatches = activeVessel.orbitPatches || [];
      if (nodes[this.activeNodeIndex]) {
        const activeNode = nodes[this.activeNodeIndex];
        if (activeNode.orbitPatches && activeNode.orbitPatches.length > 0) {
          targetPatches = activeNode.orbitPatches;
        }
      }

      // Find the correct orbit patch for targetUT across all available paths
      let foundPoint = null;
      let selectedPatch = null;

      // Traverse patches to find where targetUT fits temporally
      for (let patch of targetPatches) {
        if (targetUT >= patch.startUT && targetUT <= patch.endUT) {
          selectedPatch = patch;
          break;
        }
      }

      // Fallback to first patch if outside range (e.g. initial setup)
      if (!selectedPatch && targetPatches.length > 0) selectedPatch = targetPatches[0];

      if (selectedPatch && selectedPatch.orbitPath) {
        // v21.8.215: High-Precision Utility Bridge
        // We use the official Formatter logic to ensure rotation and axis alignment
        if (selectedPatch.elements && selectedPatch.elements.sma && this.positionDataFormatter) {
          const solvedRel = this.positionDataFormatter.solveKeplerAnalytical(selectedPatch.elements, targetUT);
          if (solvedRel) {
            const bodyName = selectedPatch.referenceBody || "Kerbin";
            const parentAbs = this.positionDataFormatter.getAbsolutePos(bodyName);
            const absPos = {
              x: parentAbs.x + solvedRel.x,
              y: parentAbs.y + solvedRel.y,
              z: parentAbs.z + solvedRel.z
            };
            // This applies axial transformation {x, z, -y} and focal shift automatically
            foundPoint = this.positionDataFormatter.formatTruePositionVector(absPos);
          }
        }

        if (!foundPoint) {
          const points = selectedPatch.orbitPath;
          const duration = selectedPatch.endUT - selectedPatch.startUT;
          const progress = (targetUT - selectedPatch.startUT) / (duration || 1);
          const index = Math.min(points.length - 1, Math.max(0, Math.floor(progress * points.length)));
          foundPoint = points[index];
        }
      }

      if (foundPoint) {
        ghost.position.set(foundPoint.x, foundPoint.y, foundPoint.z);
        seenNodes[ghostId] = true;
      }
    }

    // v21.8.230: Cleanup Barrier (Maneuver Persistence Shield)
    // We only perform scene cleanup if we are in a full server update (isFullBatch).
    // This prevents smooth extrapolation frames from clearing existing paths.
    if (isFullBatch) {
      for (var key in this.registry.nodes) { if (!seenNodes[key]) { this.group.remove(this.registry.nodes[key]); delete this.registry.nodes[key]; } }
      for (var key in this.registry.patches) { if (!seenNodes[key]) { this.group.remove(this.registry.patches[key]); delete this.registry.patches[key]; } }
    }
  }

  updateReferenceBodyOrbitPaths(bodies) {
    var paths = bodies || [];
    var seenPaths = {};
    for (var i = 0; i < paths.length; i++) {
      var path = paths[i];
      var name = path.name;
      seenPaths[name] = true;
      if (this.bodyToggles[name] === false) {
        if (this.registry.paths[name]) { this.group.remove(this.registry.paths[name]); delete this.registry.paths[name]; }
        continue;
      }
      if (!path.orbitPath || path.orbitPath.length < 2) continue;
      var points = path.orbitPath.map(p => new THREE.Vector3(p.x, p.y, p.z));
      let line = this.registry.paths[name];
      if (!line) {
        var geometry = this.createGeometryFromPoints(points, path.orbitResolution || 256);
        if (!geometry) continue;

        // v21.8.21: Dynamic Color Sync (fixes THREE.Color Alpha warning)
        const bodyColor = path.color || '#ffffff';
        line = new THREE.Line(geometry, new THREE.LineBasicMaterial({
          color: new THREE.Color(bodyColor),
          transparent: true,
          opacity: 0.2
        }));

        this.group.add(line);
        this.registry.paths[name] = line;
      } else {
        this.updateLineGeometry(line, points, path.orbitResolution || 256);
        if (path.color) {
          line.material.color.set(path.color);
        }
      }
    }
    // Cleanup
    for (var key in this.registry.paths) { if (!seenPaths[key]) { this.group.remove(this.registry.paths[key]); delete this.registry.paths[key]; } }
  }

  updateLineGeometry(line, points, resolution = 256) {
    // v22.4: Resolution now dynamic
    var curve = new THREE.CatmullRomCurve3(points);
    var newPoints = curve.getPoints(resolution);

    line.geometry.vertices = newPoints;
    line.geometry.verticesNeedUpdate = true;
    line.geometry.computeBoundingSphere(); // v21.8.33: Recalculate culling sphere
    line.geometry.computeBoundingBox();    // v21.8.33: Recalculate culling box
    if (line.material.type === "LineDashedMaterial") {
      line.geometry.computeLineDistances();
      line.geometry.computeBoundingBox();
      if (line.geometry.boundingBox) {
        var size = line.geometry.boundingBox.size();
        var dashSize = size.x / 40;
        line.material.dashSize = dashSize;
        line.material.gapSize = dashSize / 2;
      }
    }
  }

  createGeometryFromPoints(points, resolution) {
    if (!points || points.length < 2) return null;
    var curve = new THREE.CatmullRomCurve3(points);
    var geometry = new THREE.Geometry();
    geometry.vertices = curve.getPoints(resolution || 256);
    geometry.computeLineDistances();
    geometry.computeBoundingSphere(); // v21.8.33: Stabilize culling
    geometry.computeBoundingBox();    // v21.8.33: Stabilize culling
    return geometry;
  }

  updateCamera(formattedData) {
    if (this.lastFocusBody !== this.GUIParameters.focusBody) {
      // v21.8.15: Optimized Local System Scaling
      // We no longer scale based on the entire sun-centric system.
      // Instead, we scale based on the local neighborhood of the focus target.
      let localFocusRadius = 600000;
      if (this.GUIParameters.focusBody === 'current vessel') {
        localFocusRadius = 100000; // Small radius for precision around vessel
      } else {
        const bodyInfo = (formattedData.bodies || []).find(b => b.name === this.GUIParameters.focusBody);
        localFocusRadius = (bodyInfo ? bodyInfo.radius : 600000) * 12;
      }

      // v21.8.20: Pure Meter Scale (1:1). Precision is handled by rootOrigin subtraction.
      this.mapScaleFactor = 1.0;
      this.group.scale.set(1, 1, 1);

      this.lastFocusBody = this.GUIParameters.focusBody;
    }

    var focusPos = new THREE.Vector3(), focusRadius = 600000;
    if (this.GUIParameters.focusBody === 'current vessel' && this.currentVesselMesh) {
      if (this.isSliderInteracting && this.activeNodePosition) {
        focusPos.set(this.activeNodePosition.x, this.activeNodePosition.y, this.activeNodePosition.z);
        focusRadius = this.vehicleLength;
      } else {
        focusPos.copy(this.currentVesselMesh.position);
        focusRadius = 25000;
      }
    } else if (this.registry.bodies[this.GUIParameters.focusBody]) {
      focusPos.copy(this.registry.bodies[this.GUIParameters.focusBody].position);
      focusRadius = this.bodyRadii[this.GUIParameters.focusBody] || 600000;
    }

    // v21.8.155: Floating Origin Camera Logic
    // Since the focus target is now always at (0,0,0) via the Formatter,
    // we don't need to chase it. The camera stays fixed relative to the origin.
    this.group.position.set(0, 0, 0);

    if (!this.cameraSet) {
      var offset = (focusRadius * 15 + this.vehicleLength * 2);
      this.camera.position.set(focusPos.x + offset, focusPos.y + offset / 2, focusPos.z + offset);
      this.controls.target.set(0, 0, 0); // Always center on origin
      this.controls.update();
      this.cameraSet = true;
    } else {
      // Native OrbitControls update around (0,0,0)
      this.controls.target.set(0, 0, 0);
    }
  }


  resetPosition() {
    this.cameraSet = false;
    this.lastFocusBody = null; // Force rescale
  }

  clearAllOrbitPaths() {
    // v21.8.175: Deep scene cleanup for coordinate system resets
    const groups = ['paths', 'celestialOrbits', 'orbits', 'nodes', 'patches'];
    groups.forEach(groupKey => {
      const reg = this.registry[groupKey];
      if (!reg) return;
      for (let key in reg) {
        this.group.remove(reg[key]);
        delete reg[key];
      }
    });
  }
}

window.SystemOrbitalMap = SystemOrbitalMap;
