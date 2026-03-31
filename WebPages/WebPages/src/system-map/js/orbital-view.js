/**
 * SystemOrbitalMap (ES6)
 * A modern, independent Three.js renderer for the Telemachus 3D Map.
 * Decoupled from Houston and modernized with high-precision splines, 
 * an interactive Maneuver HUD, and a 3D Orientation Navball.
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
    this.colors = ["#b4f489", "#f48e77", "#a4d1f2", "#99ffc6", "#fcc2e7", "#99ffc6", "#9d67e5", "#f49ab2", "#ffcc99", "#b7fca4", "#ff7cd1", "#ffc9de", "#a4f9ac", "#b6ff77", "#80e6f2", "#f9bdbb", "#e79bef", "#85f7d5", "#88c4ea", "#68a9d8"];
    this.orbitPathColors = ["#00ffcc", "#b4c6f7", "#987cf9", "#6baedb", "#d0f788", "#f774dd", "#9dc3f9", "#edef70", "#f97292", "#adffb6", "#efc9ff", "#bfc0ff", "#ffe3c4", "#8eb2f9", "#83f7b7", "#8cfc8a", "#97f4b5", "#96dff7", "#ffaabe", "#eda371"];
    this.targetColor = '#51ff07';

    this.cameraSet = false;
    this.bodyMeshes = {};
    this.bodyToggles = {}; 

    this.buildSceneCameraAndRenderer();
    this.setupCustomUI();
    
    // Initialize Navball
    this.navball = new Navball('navball-container');

    this.positionDataFormatter = positionDataFormatter;
    this.positionDataFormatter.options.onFormat = (data) => this.render(data);
  }

  setupCustomUI() {
    // 1. Focus Selector
    const focusSelector = document.getElementById('focus-selector');
    if (focusSelector) {
      focusSelector.addEventListener('change', (e) => {
        this.GUIParameters.focusBody = e.target.value;
        this.cameraSet = false;
        this.triggerRender();
      });
    }

    document.getElementById('btn-reset')?.addEventListener('click', () => this.resetPosition());
    document.getElementById('btn-fullscreen')?.addEventListener('click', () => this.toggleFullscreen());

    // 2. Maneuver Node Controls (2D)
    document.querySelectorAll('.nav-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const cmd = btn.getAttribute('data-cmd');
        const nodes = this.lastFormattedData?.maneuverNodes || [];
        if (nodes.length === 0) return;

        const node = nodes[0]; // Apply to the first node by default
        let { radial, normal, prograde } = node.deltaV;
        const inc = 1.0;

        if (cmd === 'prograde') prograde += inc;
        if (cmd === 'retrograde') prograde -= inc;
        if (cmd === 'normal-plus') normal += inc;
        if (cmd === 'normal-minus') normal -= inc;
        if (cmd === 'radial-plus') radial += inc;
        if (cmd === 'radial-minus') radial -= inc;

        this.datalink.updateManeuverNode(0, node.ut, radial, normal, prograde);
      });
    });

    document.getElementById('btn-add-node')?.addEventListener('click', () => {
      const ut = (this.lastFormattedData?.currentUniversalTime || 0) + 1000;
      this.datalink.addManeuverNode(ut);
    });

    document.getElementById('btn-del-node')?.addEventListener('click', () => {
      this.datalink.removeManeuverNode(0);
    });

    // 3. Body Toggles
    const toggleContainer = document.getElementById('body-toggles');
    if (toggleContainer) {
      this.bodyNames.forEach(body => {
        if (body === 'current vessel') return;
        this.bodyToggles[body] = true;
        const item = document.createElement('label');
        item.className = 'toggle-item';
        item.innerHTML = `<input type="checkbox" checked data-body="${body}"><span>${body.toUpperCase()}</span>`;
        item.querySelector('input').addEventListener('change', (e) => {
          this.bodyToggles[body] = e.target.checked;
          this.triggerRender();
        });
        toggleContainer.appendChild(item);
      });
    }
  }

  triggerRender() {
    if (this.lastFormattedData) {
      this.render(this.lastFormattedData);
    }
  }

  toggleFullscreen() {
    if (!document.fullscreenEnabled) return;
    if (!document.fullscreenElement) this.container.requestFullscreen();
    else document.exitFullscreen();
  }

  buildSceneCameraAndRenderer() {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
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
    this.controls.zoomSpeed = 0.7;

    this.scene.add(new THREE.AmbientLight(0x404040));
    this.sunLight = new THREE.PointLight(0xffffff, 2, 0);
    this.scene.add(this.sunLight);

    const resizeObserver = new ResizeObserver(() => {
      this.camera.aspect = this.container.clientWidth / this.container.clientHeight;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(this.container.clientWidth, this.container.clientHeight);
    });
    resizeObserver.observe(this.container);

    const animate = () => {
      requestAnimationFrame(animate);
      this.controls.update();
      Object.keys(this.bodyMeshes).forEach(name => { this.bodyMeshes[name].rotation.y += 0.001; });
      this.renderer.render(this.scene, this.camera);
    };
    animate();
  }

  render(formattedData) {
    this.lastFormattedData = formattedData;
    this.clearGroup();
    
    this.group = new THREE.Group();
    this.scene.add(this.group);

    this.buildReferenceBodyGeometry(formattedData);
    this.buildVesselGeometry(formattedData);
    this.buildOrbitPathGeometry(formattedData);
    this.buildManeuverNodeGeometry(formattedData);
    this.buildReferenceBodyOrbitPaths(formattedData);

    this.updateCamera(formattedData);
    this.updateHUD(formattedData);
  }

  updateHUD(formattedData) {
    // 1. Time Format
    const ut = formattedData.currentUniversalTime;
    const timeElem = document.getElementById('time-readout');
    if (timeElem) timeElem.innerText = `UT: ${ut.toFixed(0)}`;

    // 2. Vessel Stats
    const statsElem = document.getElementById('vessel-stats');
    if (statsElem && this.datalink.lastData) {
      const d = this.datalink.lastData;
      const ap = (d['o.ApA'] / 1000).toFixed(1);
      const pe = (d['o.PeA'] / 1000).toFixed(1);
      const inc = (d['o.inclination'] || 0).toFixed(2);
      statsElem.innerText = `AP: ${ap}km | PE: ${pe}km | INC: ${inc}°`;

      // 3. Update Navball orientation
      if (this.navball) {
        this.navball.updateOrientation(d['n.pitch'], d['n.roll'], d['n.heading']);
      }
    }

    // 4. Astrogator/Transfer Info
    const transElem = document.getElementById('transfer-info');
    if (transElem && this.datalink.lastData) {
      const d = this.datalink.lastData;
      const dest = d['a.nextTransfer.destination'] || 'NONE';
      const burn = d['a.nextTransfer.burnUT'] ? (d['a.nextTransfer.burnUT'] - ut).toFixed(0) : '--';
      const dv = d['a.nextTransfer.dv'] ? d['a.nextTransfer.dv'].toFixed(0) : '0';
      transElem.innerText = `DEST: ${dest.toUpperCase()} | BURN: T-${burn}s | dV: ${dv} m/s`;
    }
  }

  clearGroup() {
    if (this.group) {
      this.scene.remove(this.group);
      this.group.traverse(child => {
        if (child.geometry) child.geometry.dispose();
      });
    }
  }

  buildReferenceBodyGeometry(formattedData) {
    formattedData.referenceBodies.forEach((info, i) => {
      if (this.bodyToggles[info.name] === false && info.name !== "Sun") return;
      const color = info.name === "Sun" ? 'yellow' : (info.color || this.colors[i % this.colors.length]);
      let radius = info.radius * this.referenceBodyScaleFactor;
      if (info.name === "Sun") radius *= this.sunBodyScaleFactor;

      const material = new THREE.MeshStandardMaterial({ 
        color: info.type === "targetBodyCurrentPosition" ? this.targetColor : color,
        emissive: info.name === "Sun" ? 'yellow' : 'black',
        emissiveIntensity: info.name === "Sun" ? 1 : 0
      });

      if (info.name === "Sun") this.sunLight.position.set(...info.truePosition);

      const sphere = new THREE.Mesh(new THREE.SphereGeometry(radius, 32, 32), material);
      sphere.position.set(...info.truePosition);
      this.group.add(sphere);
      this.bodyMeshes[info.name] = sphere;
    });
  }

  buildVesselGeometry(formattedData) {
    formattedData.vessels.forEach(info => {
      const color = info.type === "currentVessel" ? 'white' : this.targetColor;
      const cube = new THREE.Mesh(new THREE.BoxGeometry(this.vehicleLength, this.vehicleLength, this.vehicleLength), new THREE.MeshBasicMaterial({ color: color }));
      cube.position.set(...info.truePosition);
      this.group.add(cube);
      if (info.type === "currentVessel") this.currentVesselMesh = cube;
    });
  }

  /**
   * HIGH-PRECISION SPLINE ORBITS
   * Uses CatmullRomCurve3 to interpolate telemetry points into buttery smooth lines.
   */
  buildOrbitPathGeometry(formattedData) {
    if (!formattedData.orbitPatches) return;
    formattedData.orbitPatches.forEach((patch, i) => {
      const color = patch.parentType === "targetVessel" ? this.targetColor : this.orbitPathColors[i % this.orbitPathColors.length];
      const points = patch.truePositions.map(p => new THREE.Vector3(...p));
      if (points.length < 2) return;

      const curve = new THREE.CatmullRomCurve3(points);
      const splinePoints = curve.getPoints(2048); // High density for smoothness
      const geometry = this.createBufferGeometryFromPoints(splinePoints);
      this.group.add(new THREE.Line(geometry, new THREE.LineBasicMaterial({ color: color, linewidth: 2 })));
    });
  }

  buildManeuverNodeGeometry(formattedData) {
    if (!formattedData.maneuverNodes) return;
    formattedData.maneuverNodes.forEach(node => {
      if (node.truePosition) {
        const marker = new THREE.Mesh(new THREE.SphereGeometry(this.vehicleLength * 0.5, 16, 16), new THREE.MeshBasicMaterial({ color: 0xffcc00 }));
        marker.position.set(...node.truePosition);
        this.group.add(marker);
      }

      node.orbitPatches?.forEach((patch, i) => {
        const points = patch.truePositions.map(p => new THREE.Vector3(...p));
        if (points.length < 2) return;
        const curve = new THREE.CatmullRomCurve3(points);
        const splinePoints = curve.getPoints(1024);
        const geometry = this.createBufferGeometryFromPoints(splinePoints);
        const material = new THREE.LineDashedMaterial({ color: this.orbitPathColors[i % this.orbitPathColors.length], dashSize: this.dashedLineLength/10, gapSize: this.dashedLineLength/10 });
        const line = new THREE.Line(geometry, material);
        line.computeLineDistances();
        this.group.add(line);
      });
    });
  }

  buildReferenceBodyOrbitPaths(formattedData) {
    formattedData.referenceBodyPaths?.forEach((path, i) => {
      if (this.bodyToggles[path.referenceBodyName] === false) return;
      const points = path.truePositions.map(p => new THREE.Vector3(...p));
      if (points.length < 2) return;
      const curve = new THREE.CatmullRomCurve3(points);
      const splinePoints = curve.getPoints(4096); // Maximum fidelity for celestial rings
      const geometry = this.createBufferGeometryFromPoints(splinePoints);
      this.group.add(new THREE.Line(geometry, new THREE.LineBasicMaterial({ color: this.orbitPathColors[i % this.orbitPathColors.length], transparent: true, opacity: 0.5 })));
    });
  }

  createBufferGeometryFromPoints(points) {
    const positions = new Float32Array(points.length * 3);
    points.forEach((p, i) => { positions[i*3] = p.x; positions[i*3+1] = p.y; positions[i*3+2] = p.z; });
    const geometry = new THREE.BufferGeometry();
    geometry.addAttribute('position', new THREE.BufferAttribute(positions, 3));
    return geometry;
  }

  updateCamera(formattedData) {
    const boundingBox = new THREE.Box3().setFromObject(this.group);
    if (boundingBox.isEmpty()) return;
    const size = boundingBox.size(new THREE.Vector3());
    const scaleFactor = this.maxLengthInThreeJS / (Math.max(size.x, size.y, size.z) || 1);
    this.group.scale.set(scaleFactor, scaleFactor, scaleFactor);

    let focusPos = new THREE.Vector3();
    let focusRadius = this.vehicleLength;

    if (this.GUIParameters.focusBody === 'current vessel' && this.currentVesselMesh) focusPos.copy(this.currentVesselMesh.position);
    else {
      const mesh = this.bodyMeshes[this.GUIParameters.focusBody];
      if (mesh) {
        focusPos.copy(mesh.position);
        const bodyInfo = formattedData.referenceBodies.find(b => b.name === this.GUIParameters.focusBody);
        if (bodyInfo) focusRadius = bodyInfo.radius;
      }
    }
    
    this.controls.target.copy(focusPos.multiplyScalar(scaleFactor));
    if (!this.cameraSet) {
      const offset = Math.max(focusRadius * scaleFactor * 5, this.vehicleLength * scaleFactor * 20);
      this.camera.position.set(this.controls.target.x + offset, this.controls.target.y + offset, this.controls.target.z + offset);
      this.cameraSet = true;
    }
  }

  resetPosition() { this.cameraSet = false; }
}

window.SystemOrbitalMap = SystemOrbitalMap;
走
