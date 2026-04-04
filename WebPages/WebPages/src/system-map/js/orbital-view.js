/**
 * SystemOrbitalMap (ES6)
 * A modern, independent Three.js renderer for the Telemachus 3D Map.
 */
class SystemOrbitalMap {
  constructor(positionDataFormatter, datalink, containerID) {
    this.container = document.getElementById(containerID);
    this.datalink = datalink;

    this.GUIParameters = {
      "focusBody": 'current vessel'
    };

    this.distanceScaleFactor = 1;
    this.referenceBodyScaleFactor = 1;
    this.sunBodyScaleFactor = 1.5; 
    this.dashedLineLength = 100000;
    this.maxLengthInThreeJS = 2000;
    this.vehicleLength = 25000;
    this.defaultZoomFactor = 40;

    this.bodyNames = ['current vessel', 'Sun', 'Kerbin', 'Mun', 'Minmus'];
    this.orbitPathColors = [
      "#4d94ff", "#ff00ff", "#00e600", "#ff9900", "#9933ff",
      "#ffcc00", "#00ccff", "#ff5050", "#00cccc", "#ffccff"
    ];
    this.targetColor = '#51ff07';

    this.cameraSet = false;
    this.registry = {
      bodies: {},
      orbits: {},
      vessels: {},
      nodes: {},
      patches: {},
      paths: {}
    };
    this.bodyRadii = {};
    this.bodyToggles = {}; 
    this.isSliderInteracting = false;
    this.activeNodeIndex = 0;
    this.maneuverInterval = null;

    this.buildSceneCameraAndRenderer();
    this.setupCustomUI();
    
    this.navball = new Navball('navball-container');

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

    // Body Toggles
    const toggleContainer = document.getElementById('body-toggles');
    if (toggleContainer) {
      this.bodyNames.forEach(body => {
        if (body === 'current vessel') return;
        this.bodyToggles[body] = true;
        const item = document.createElement('label');
        item.className = 'toggle-item';
        item.innerHTML = '<input type="checkbox" checked data-body="' + body + '"><span>' + body.toUpperCase() + '</span>';
        item.querySelector('input').addEventListener('change', (e) => {
          this.bodyToggles[body] = e.target.checked;
          this.triggerRender();
        });
        toggleContainer.appendChild(item);
      });
    }

    // Target Link UI
    const btnTarget = document.getElementById('btn-target');
    if (btnTarget) {
        btnTarget.addEventListener('click', () => {
            const idx = parseInt(document.getElementById('target-vessel-index').value) || 0;
            const cmd = `tar.setTargetVessel[${idx}]`;
            this.datalink.sendMessage({ [cmd]: cmd });
            this.cameraSet = false; // Reset camera to snap to new target if focus is 'current vessel'
        });
    }
  }

  addNodeAt(type) {
    if (!this.lastFormattedData) return;
    const currentUT = this.lastFormattedData.currentUniversalTime;
    const d = this.datalink.lastData;
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
    this.camera = new THREE.PerspectiveCamera(75, this.container.clientWidth / this.container.clientHeight, 0.1, 10000000);
    this.camera.up.set(0, -1, 0); 
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
    if (ut === this.lastRenderUT && !this.isSliderInteracting) return;
    this.lastRenderUT = ut;
    this.lastFormattedData = formattedData;

    this.updateReferenceBodyGeometry(formattedData);
    this.updateVesselGeometry(formattedData);
    this.updateOrbitPathGeometry(formattedData);
    this.updateManeuverNodeGeometry(formattedData);
    this.updateReferenceBodyOrbitPaths(formattedData);
    this.updateCamera(formattedData);
    this.updateHUD(formattedData);
  }

  updateHUD(formattedData) {
    const ut = formattedData.currentUniversalTime;
    const timeElem = document.getElementById('time-readout');
    if (timeElem) timeElem.innerText = 'UT: ' + (ut || 0).toFixed(0);

    const statsGrid = document.getElementById('vessel-stats-grid');
    if (statsGrid && this.datalink.lastData) {
      const d = this.datalink.lastData;
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

      // Target Readout Update
      const targetReadout = document.getElementById('target-readout');
      if (targetReadout) {
          if (d['tar.name'] && d['tar.name'] !== "No Target" && d['tar.name'] !== "No Target Selected.") {
              targetReadout.innerText = `LOCKED: ${d['tar.name']}`.toUpperCase();
          } else {
              targetReadout.innerText = "NO TARGET SELECTED";
          }
      }

      // Encounter Info
      const encElem = document.getElementById('encounter-info');
      if (encElem) {
        const encBody = d['o.encounterBody'];
        if (encBody && encBody !== 'None' && encBody !== '') {
          const encTime = d['o.encounterTime'] || 0;
          encElem.innerText = `${encBody.toUpperCase()} ENCOUNTER: T-${(encTime/3600).toFixed(1)}h`;
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

    if (this.datalink.lastData && this.datalink.lastData['o.maneuverNodes']) {
      const nodes = this.datalink.lastData['o.maneuverNodes'];
      
      // Predicted Stats for Node
      const predElem = document.getElementById('pred-stats');
      if (this.activeNodeIndex < nodes.length) {
        this.lastNodeData = nodes[this.activeNodeIndex];
        this.activeNodePosition = this.lastNodeData.truePosition;
        
        // Sliders Update (dv labels)
        const proLabel = document.getElementById('dv-pro');
        const normLabel = document.getElementById('dv-norm');
        const radLabel = document.getElementById('dv-rad');
        if (proLabel) proLabel.innerText = this.lastNodeData.deltaV[2].toFixed(1);
        if (normLabel) normLabel.innerText = this.lastNodeData.deltaV[1].toFixed(1);
        if (radLabel) radLabel.innerText = this.lastNodeData.deltaV[0].toFixed(1);

        if (predElem && formattedData.maneuverNodes[this.activeNodeIndex]) {
          const node = formattedData.maneuverNodes[this.activeNodeIndex];
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
          const totalDV = Math.sqrt(Math.pow(n.deltaV[0], 2) + Math.pow(n.deltaV[1], 2) + Math.pow(n.deltaV[2], 2)).toFixed(1);
          const activeStyle = (idx === this.activeNodeIndex) ? 'color: #00ffff; font-weight: bold;' : '';
          summaryHTML += `<div style="${activeStyle}">NODE ${idx+1}: ${totalDV} m/s</div>`;
        });
        summaryElem.innerHTML = summaryHTML;
      }
    }
  }

  updateReferenceBodyGeometry(formattedData) {
    var bodies = formattedData.referenceBodies || [];
    for (var i = 0; i < bodies.length; i++) {
      var info = bodies[i];
      var name = info.name;
      if (this.bodyToggles[name] === false && name !== "Sun") {
        if (this.registry.bodies[name]) {
          this.group.remove(this.registry.bodies[name]);
          delete this.registry.bodies[name];
        }
        continue;
      }
      
      var radius = info.radius * this.referenceBodyScaleFactor;
      if (name === "Sun") radius *= this.sunBodyScaleFactor;
      this.bodyRadii[name] = radius;

      let mesh = this.registry.bodies[name];
      if (!mesh) {
        var material = name === "Sun" ? new THREE.MeshBasicMaterial({ color: 'yellow' }) : new THREE.MeshPhongMaterial({ color: info.type === "targetBodyCurrentPosition" ? this.targetColor : info.color, shininess: 30 });
        mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, 32, 32), material);
        this.group.add(mesh);
        this.registry.bodies[name] = mesh;
      }

      if (info.truePosition) mesh.position.set(info.truePosition[0], info.truePosition[1], info.truePosition[2]);
      if (name === "Sun") this.sunLight.position.set(info.truePosition[0], info.truePosition[1], info.truePosition[2]);
    }
  }

  updateVesselGeometry(formattedData) {
    var vessels = formattedData.vessels || [];
    var seenVessels = {};
    for (var i = 0; i < vessels.length; i++) {
      var info = vessels[i];
      var id = info.name || "vessel-" + i;
      seenVessels[id] = true;
      let mesh = this.registry.vessels[id];
      if (!mesh) {
        mesh = new THREE.Mesh(new THREE.BoxGeometry(this.vehicleLength, this.vehicleLength, this.vehicleLength), new THREE.MeshBasicMaterial({ color: info.type === "currentVessel" ? 'white' : this.targetColor }));
        this.group.add(mesh);
        this.registry.vessels[id] = mesh;
      }
      mesh.position.set(info.truePosition[0], info.truePosition[1], info.truePosition[2]);
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

  updateOrbitPathGeometry(formattedData) {
    var patches = formattedData.orbitPatches || [];
    var seenPatches = {};
    for (var i = 0; i < patches.length; i++) {
        var patch = patches[i];
        var id = "patch-" + i;
        seenPatches[id] = true;
        var points = patch.truePositions.map(p => new THREE.Vector3(p[0], p[1], p[2]));
        let line = this.registry.orbits[id];
        if (!line) {
            var geometry = this.createGeometryFromPoints(points, 256);
            line = new THREE.Line(geometry, new THREE.LineBasicMaterial({ color: patch.parentType === "targetVessel" ? this.targetColor : this.orbitPathColors[i % 10] }));
            this.group.add(line);
            this.registry.orbits[id] = line;
        } else {
            this.updateLineGeometry(line, points);
        }
    }
    // Cleanup
    for (var key in this.registry.orbits) {
        if (!seenPatches[key]) {
            this.group.remove(this.registry.orbits[key]);
            delete this.registry.orbits[key];
        }
    }
  }

  updateManeuverNodeGeometry(formattedData) {
    var nodes = formattedData.maneuverNodes || [];
    var seenNodes = {};
    for (var i = 0; i < nodes.length; i++) {
        var node = nodes[i];
        var id = "node-" + i;
        seenNodes[id] = true;
        let marker = this.registry.nodes[id];
        if (!marker) {
            marker = new THREE.Mesh(new THREE.SphereGeometry(this.vehicleLength * 0.5, 16, 16), new THREE.MeshBasicMaterial({ color: 0xffcc00 }));
            this.group.add(marker);
            this.registry.nodes[id] = marker;
        }
        if (node.truePosition) marker.position.set(node.truePosition[0], node.truePosition[1], node.truePosition[2]);

        // Maneuver Orbits
        var nodePatches = node.orbitPatches || [];
        for (var j = 0; j < nodePatches.length; j++) {
            var patch = nodePatches[j];
            var patchId = "node-" + i + "-patch-" + j;
            seenNodes[patchId] = true;
            var points = patch.truePositions.map(p => new THREE.Vector3(p[0], p[1], p[2]));
            let line = this.registry.patches[patchId];
            if (!line) {
                var geometry = this.createGeometryFromPoints(points, 256);
                geometry.computeBoundingBox();
                var dashSize = geometry.boundingBox.size().x / 40;
                line = new THREE.Line(geometry, new THREE.LineDashedMaterial({ color: '#00ffff', dashSize: dashSize, gapSize: dashSize / 2, linewidth: 3 }));
                this.group.add(line);
                this.registry.patches[patchId] = line;
            } else {
                this.updateLineGeometry(line, points);
            }
        }
    }

    // Ghost Preview Sphere with Multi-Patch Support
    const utInput = document.getElementById('node-ut-offset');
    if (utInput) {
        const offset = parseFloat(utInput.value) || 0;
        const targetUT = formattedData.currentUniversalTime + offset;
        const ghostId = "ghost-node";
        let ghost = this.registry.nodes[ghostId];
        
        if (!ghost) {
            ghost = new THREE.Mesh(new THREE.SphereGeometry(this.vehicleLength * 0.4, 32, 32), new THREE.MeshBasicMaterial({ color: 0x00ff00, transparent: true, opacity: 0.5 }));
            this.group.add(ghost);
            this.registry.nodes[ghostId] = ghost;
        }

        // Target the ACTIVE maneuver node's patches for stacked planning
        let targetPatches = formattedData.orbitPatches || [];
        if (formattedData.maneuverNodes && formattedData.maneuverNodes[this.activeNodeIndex]) {
            const activeNode = formattedData.maneuverNodes[this.activeNodeIndex];
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

        if (selectedPatch && selectedPatch.truePositions) {
            const points = selectedPatch.truePositions;
            const duration = selectedPatch.endUT - selectedPatch.startUT;
            const progress = (targetUT - selectedPatch.startUT) / (duration || 1);
            const index = Math.min(points.length - 1, Math.max(0, Math.floor(progress * points.length)));
            foundPoint = points[index];
        }

        if (foundPoint) {
            ghost.position.set(foundPoint[0], foundPoint[1], foundPoint[2]);
            seenNodes[ghostId] = true;
        }
    }

    // Cleanup
    for (var key in this.registry.nodes) { if (!seenNodes[key]) { this.group.remove(this.registry.nodes[key]); delete this.registry.nodes[key]; } }
    for (var key in this.registry.patches) { if (!seenNodes[key]) { this.group.remove(this.registry.patches[key]); delete this.registry.patches[key]; } }
  }

  updateReferenceBodyOrbitPaths(formattedData) {
    var paths = formattedData.referenceBodyPaths || [];
    var seenPaths = {};
    for (var i = 0; i < paths.length; i++) {
        var path = paths[i];
        var name = path.referenceBodyName;
        seenPaths[name] = true;
        if (this.bodyToggles[name] === false) {
            if (this.registry.paths[name]) { this.group.remove(this.registry.paths[name]); delete this.registry.paths[name]; }
            continue;
        }
        var points = path.truePositions.map(p => new THREE.Vector3(p[0], p[1], p[2]));
        let line = this.registry.paths[name];
        if (!line) {
            var geometry = this.createGeometryFromPoints(points, 256);
            line = new THREE.Line(geometry, new THREE.LineBasicMaterial({ color: 'rgba(255,255,255,0.2)', transparent: true, opacity: 0.2 }));
            this.group.add(line);
            this.registry.paths[name] = line;
        } else {
            this.updateLineGeometry(line, points);
        }
    }
    // Cleanup
    for (var key in this.registry.paths) { if (!seenPaths[key]) { this.group.remove(this.registry.paths[key]); delete this.registry.paths[key]; } }
  }

  updateLineGeometry(line, points) {
    var curve = new THREE.CatmullRomCurve3(points);
    var newPoints = curve.getPoints(256);
    line.geometry.vertices = newPoints;
    line.geometry.verticesNeedUpdate = true;
    if (line.material.type === "LineDashedMaterial") {
        line.geometry.computeLineDistances();
        line.geometry.computeBoundingBox();
        var dashSize = line.geometry.boundingBox.size().x / 40;
        line.material.dashSize = dashSize;
        line.material.gapSize = dashSize / 2;
    }
  }

  createGeometryFromPoints(points, resolution) {
    var curve = new THREE.CatmullRomCurve3(points);
    var geometry = new THREE.Geometry();
    geometry.vertices = curve.getPoints(resolution || 256);
    geometry.computeLineDistances(); 
    return geometry;
  }

  updateCamera(formattedData) {
    if (this.lastFocusBody !== this.GUIParameters.focusBody) {
      var boundingBox = new THREE.Box3().setFromObject(this.group);
      if (!boundingBox.isEmpty()) {
        var size = boundingBox.size(new THREE.Vector3());
        this.mapScaleFactor = this.maxLengthInThreeJS / (Math.max(size.x, size.y, size.z) || 1);
        this.group.scale.set(this.mapScaleFactor, this.mapScaleFactor, this.mapScaleFactor);
      }
      this.lastFocusBody = this.GUIParameters.focusBody;
    }

    var focusPos = new THREE.Vector3(), focusRadius = 600000;
    if (this.GUIParameters.focusBody === 'current vessel' && this.currentVesselMesh) {
      if (this.isSliderInteracting && this.activeNodePosition) {
        focusPos.set(this.activeNodePosition[0], this.activeNodePosition[1], this.activeNodePosition[2]);
        focusRadius = this.vehicleLength;
      } else {
        focusPos.copy(this.currentVesselMesh.position);
        focusRadius = 25000;
      }
    } else if (this.registry.bodies[this.GUIParameters.focusBody]) {
      focusPos.copy(this.registry.bodies[this.GUIParameters.focusBody].position);
      focusRadius = this.bodyRadii[this.GUIParameters.focusBody] || 600000;
    }

    var scaledTarget = focusPos.clone().multiplyScalar(this.mapScaleFactor);
    this.controls.target.copy(scaledTarget);
    if (!this.cameraSet) {
      var offset = (focusRadius * 10 + this.vehicleLength * 20) * this.mapScaleFactor;
      this.camera.position.set(scaledTarget.x + offset, scaledTarget.y + offset/2, scaledTarget.z + offset);
      this.camera.lookAt(scaledTarget);
      this.cameraSet = true;
    }
  }

  resetPosition() { 
    this.cameraSet = false; 
    this.lastFocusBody = null; // Force rescale
  }
}

window.SystemOrbitalMap = SystemOrbitalMap;
