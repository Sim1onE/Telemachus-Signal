/**
 * SystemOrbitalMap (ES6)
 * A modern, independent Three.js renderer for the Telemachus 3D Map.
 * Decoupled from Houston and modernized with a premium custom HUD.
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
    this.sunBodyScaleFactor = 1; // Slightly larger Sun
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
    this.bodyToggles = {}; // Stores which bodies are visible

    this.buildSceneCameraAndRenderer();
    this.setupCustomUI();

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

    // 2. Buttons
    const btnReset = document.getElementById('btn-reset');
    if (btnReset) btnReset.addEventListener('click', () => this.resetPosition());

    const btnFullscreen = document.getElementById('btn-fullscreen');
    if (btnFullscreen) btnFullscreen.addEventListener('click', () => this.toggleFullscreen());

    // 3. Body Toggles
    const toggleContainer = document.getElementById('body-toggles');
    if (toggleContainer) {
      this.bodyNames.forEach(body => {
        if (body === 'current vessel') return;

        // Initial state
        this.bodyToggles[body] = true;

        const item = document.createElement('label');
        item.className = 'toggle-item';
        item.innerHTML = `
          <input type="checkbox" checked data-body="${body}">
          <span>${body.toUpperCase()}</span>
        `;

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
    if (!document.fullscreenElement) {
      this.container.requestFullscreen().catch(err => {
        console.error(`Error attempting to enable full-screen mode: ${err.message}`);
      });
    } else {
      document.exitFullscreen();
    }
  }

  buildSceneCameraAndRenderer() {
    // Use Alpha: true to let the CSS starfield show through
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setSize(this.container.clientWidth, this.container.clientHeight);
    this.renderer.setClearColor(0x000000, 0); // Transparent background
    this.container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();

    this.camera = new THREE.PerspectiveCamera(75, this.container.clientWidth / this.container.clientHeight, 0.1, 10000000);
    this.camera.up.set(0, -1, 0); // Important for vertical orientation

    this.controls = new THREE.OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.05;
    this.controls.rotateSpeed = 0.3;
    this.controls.zoomSpeed = 0.7;

    const ambientLight = new THREE.AmbientLight(0x404040);
    this.scene.add(ambientLight);

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

      // Subtle rotation for bodies
      Object.keys(this.bodyMeshes).forEach(name => {
        this.bodyMeshes[name].rotation.y += 0.001;
      });

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

    // Update HUD readouts
    const ut = formattedData.currentUniversalTime;
    const timeElem = document.getElementById('time-readout');
    if (timeElem) {
      const timeStr = window.TimeFormatters ? window.TimeFormatters.formatUT(ut) : ut.toFixed(0);
      timeElem.innerText = `UT: ${timeStr}`;
    }
  }

  clearGroup() {
    if (this.group) {
      this.scene.remove(this.group);
      this.group.traverse(child => {
        if (child.geometry) child.geometry.dispose();
        if (child.material) {
          if (Array.isArray(child.material)) child.material.forEach(m => m.dispose());
          else child.material.dispose();
        }
      });
    }
  }

  buildReferenceBodyGeometry(formattedData) {
    formattedData.referenceBodies.forEach((info, i) => {
      // Visibility Filter
      if (this.bodyToggles[info.name] === false && info.name !== "Sun") return;

      const color = info.name === "Sun" ? 'yellow' : (info.color || this.colors[i % this.colors.length]);
      let radius = info.radius * this.referenceBodyScaleFactor;
      if (info.name === "Sun") radius *= this.sunBodyScaleFactor;

      let material;
      if (info.type === "currentPosition" || info.type === "targetBodyCurrentPosition") {
        material = new THREE.MeshStandardMaterial({
          color: info.type === "targetBodyCurrentPosition" ? this.targetColor : color,
          roughness: 0.5,
          metalness: 0.1,
          emissive: info.name === "Sun" ? 'yellow' : 'black',
          emissiveIntensity: info.name === "Sun" ? 1 : 0
        });
      } else {
        material = new THREE.MeshBasicMaterial({ color: color, wireframe: true, transparent: true, opacity: 0.3 });
      }

      if (info.name === "Sun") {
        this.sunLight.position.set(...info.truePosition);
      }

      const geometry = new THREE.SphereGeometry(radius, 32, 32);
      const sphere = new THREE.Mesh(geometry, material);
      sphere.position.set(...info.truePosition);
      this.group.add(sphere);
      this.bodyMeshes[info.name] = sphere;

      if (info.atmosphericRadius > 0 && this.bodyToggles[info.name]) {
        this.addAtmosphere(sphere, info.radius, info.atmosphericRadius);
      }
    });
  }

  addAtmosphere(parent, radius, atmoRadius) {
    const atmoGeom = new THREE.SphereGeometry((radius + atmoRadius), 32, 32);
    const atmoMat = new THREE.MeshBasicMaterial({
      color: 0x88ccff,
      transparent: true,
      opacity: 0.2,
      side: THREE.BackSide
    });
    const atmo = new THREE.Mesh(atmoGeom, atmoMat);
    atmo.position.copy(parent.position);
    this.group.add(atmo);
  }

  buildVesselGeometry(formattedData) {
    formattedData.vessels.forEach(info => {
      const color = info.type === "currentVessel" ? 'white' : this.targetColor;
      const geometry = new THREE.BoxGeometry(this.vehicleLength, this.vehicleLength, this.vehicleLength);
      const material = new THREE.MeshBasicMaterial({ color: color });
      const cube = new THREE.Mesh(geometry, material);
      cube.position.set(...info.truePosition);
      this.group.add(cube);

      if (info.type === "currentVessel") this.currentVesselMesh = cube;
    });
  }

  buildOrbitPathGeometry(formattedData) {
    if (!formattedData.orbitPatches) return;
    formattedData.orbitPatches.forEach((patch, i) => {
      const color = patch.parentType === "targetVessel" ? this.targetColor : this.orbitPathColors[i % this.orbitPathColors.length];
      const points = patch.truePositions.map(p => new THREE.Vector3(...p));

      if (points.length < 2) return;
      const geometry = this.createBufferGeometryFromPoints(points);
      const material = new THREE.LineBasicMaterial({ color: color, linewidth: 2 });
      const line = new THREE.Line(geometry, material);
      this.group.add(line);
    });
  }

  buildManeuverNodeGeometry(formattedData) {
    if (!formattedData.maneuverNodes) return;
    formattedData.maneuverNodes.forEach(node => {
      if (node.truePosition) {
        const geom = new THREE.SphereGeometry(this.vehicleLength * 0.5, 16, 16);
        const mat = new THREE.MeshBasicMaterial({ color: 0xffcc00 });
        const marker = new THREE.Mesh(geom, mat);
        marker.position.set(...node.truePosition);
        this.group.add(marker);
      }

      if (node.orbitPatches) {
        node.orbitPatches.forEach((patch, i) => {
          const points = patch.truePositions.map(p => new THREE.Vector3(...p));
          if (points.length < 2) return;
          const geometry = this.createBufferGeometryFromPoints(points);
          const material = new THREE.LineDashedMaterial({
            color: this.orbitPathColors[i % this.orbitPathColors.length],
            dashSize: this.dashedLineLength / 10,
            gapSize: this.dashedLineLength / 10
          });
          const line = new THREE.Line(geometry, material);
          if (line.computeLineDistances) line.computeLineDistances();
          this.group.add(line);
        });
      }
    });
  }

  buildReferenceBodyOrbitPaths(formattedData) {
    if (!formattedData.referenceBodyPaths) return;
    formattedData.referenceBodyPaths.forEach((path, i) => {
      if (this.bodyToggles[path.referenceBodyName] === false) return;

      const points = path.truePositions.map(p => new THREE.Vector3(...p));
      if (points.length < 2) return;
      const geometry = this.createBufferGeometryFromPoints(points);
      const material = new THREE.LineBasicMaterial({
        color: this.orbitPathColors[i % this.orbitPathColors.length],
        transparent: true,
        opacity: 0.5
      });
      const line = new THREE.Line(geometry, material);
      this.group.add(line);
    });
  }

  createBufferGeometryFromPoints(points) {
    const positions = new Float32Array(points.length * 3);
    for (let i = 0; i < points.length; i++) {
      positions[i * 3] = points[i].x;
      positions[i * 3 + 1] = points[i].y;
      positions[i * 3 + 2] = points[i].z;
    }
    const geometry = new THREE.BufferGeometry();
    geometry.addAttribute('position', new THREE.BufferAttribute(positions, 3));
    return geometry;
  }

  updateCamera(formattedData) {
    const boundingBox = new THREE.Box3().setFromObject(this.group);
    if (boundingBox.isEmpty()) return;

    const size = boundingBox.size(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z);
    const scaleFactor = this.maxLengthInThreeJS / (maxDim || 1);
    this.group.scale.set(scaleFactor, scaleFactor, scaleFactor);

    let focusPos = new THREE.Vector3();
    let focusRadius = this.vehicleLength;

    if (this.GUIParameters.focusBody === 'current vessel' && this.currentVesselMesh) {
      focusPos.copy(this.currentVesselMesh.position);
    } else {
      const mesh = this.bodyMeshes[this.GUIParameters.focusBody];
      if (mesh) {
        focusPos.copy(mesh.position);
        const bodyInfo = formattedData.referenceBodies.find(b => b.name === this.GUIParameters.focusBody);
        if (bodyInfo) focusRadius = bodyInfo.radius;
      }
    }

    const scaledFocusPos = focusPos.clone().multiplyScalar(scaleFactor);
    this.controls.target.copy(scaledFocusPos);

    if (!this.cameraSet) {
      const offset = Math.max(focusRadius * scaleFactor * 5, this.vehicleLength * scaleFactor * 20);
      this.camera.position.set(
        scaledFocusPos.x + offset,
        scaledFocusPos.y + offset,
        scaledFocusPos.z + offset
      );
      this.cameraSet = true;
    }
  }

  resetPosition() {
    this.cameraSet = false;
  }
}

window.SystemOrbitalMap = SystemOrbitalMap;
