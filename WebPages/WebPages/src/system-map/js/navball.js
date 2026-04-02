/**
 * Navball (ES6)
 * A standalone 3D attitude indicator for the Telemachus 3D Map.
 * Renders a sphere that rotates in sync with KSP vessel orientation.
 * Houston Parity: Euler Order ZXY.
 */
function Navball(containerID) {
  this.container = document.getElementById(containerID);
  if (!this.container) return;

  const w = this.container.clientWidth;
  const h = this.container.clientHeight;

  this.scene = new THREE.Scene();
  this.camera = new THREE.PerspectiveCamera(32, w / h, 0.1, 1000);
  this.camera.position.z = 190; 

  // Lighting with enhanced instrument visibility
  this.addLights();

  this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  this.renderer.setSize(w, h);
  this.container.appendChild(this.renderer.domElement);

  this.pitch = 0;
  this.roll = 0;
  this.heading = 0;

  this.createSphere();
  this.animate();
}

Navball.prototype.createSphere = function() {
  const canvas = document.createElement('canvas');
  canvas.width = 2048;
  canvas.height = 1024;
  const ctx = canvas.getContext('2d');

  // Brighter Sky: Horizon to Zenith
  const skyGrad = ctx.createLinearGradient(0, 0, 0, 512);
  skyGrad.addColorStop(0, '#00264d'); 
  skyGrad.addColorStop(0.5, '#004d99');
  skyGrad.addColorStop(1, '#00b3ff'); 
  ctx.fillStyle = skyGrad;
  ctx.fillRect(0, 0, 2048, 512);

  // Brighter Ground: Horizon to Nadir
  const gndGrad = ctx.createLinearGradient(0, 512, 0, 1024);
  gndGrad.addColorStop(0, '#663300'); 
  gndGrad.addColorStop(1, '#331a00'); 
  ctx.fillStyle = gndGrad;
  ctx.fillRect(0, 512, 2048, 512);

  // Glowing Horizon Line
  ctx.shadowBlur = 15;
  ctx.shadowColor = 'rgba(255,255,255,0.5)';
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 6;
  ctx.beginPath(); ctx.moveTo(0, 512); ctx.lineTo(2048, 512); ctx.stroke();
  ctx.shadowBlur = 0;

  // Precision Pitch and Ticks
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  
  for (let p = -80; p <= 80; p += 5) { // 5 degree increments
    if (p === 0) continue;
    const y = 512 - (p * 5.68); // Rescaled for 1024 height
    const pRad = p * (Math.PI / 180);
    const isMajor = (p % 10 === 0);
    
    // Proportional Length
    const lineHalfWidth = Math.cos(pRad) * (isMajor ? 80 : 40);
    
    ctx.strokeStyle = isMajor ? 'rgba(255,255,255,0.8)' : 'rgba(255,255,255,0.4)';
    ctx.lineWidth = isMajor ? 4 : 2;
    
    ctx.beginPath();
    ctx.moveTo(1024 - lineHalfWidth, y);
    ctx.lineTo(1024 + lineHalfWidth, y);
    ctx.stroke();

    if (isMajor && Math.abs(p) <= 70) {
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 36px Orbitron, sans-serif';
      // Offset text slightly more for readability
      const textOffset = lineHalfWidth + 60;
      ctx.fillText(Math.abs(p), 1024 - textOffset, y);
      ctx.fillText(Math.abs(p), 1024 + textOffset, y);
    }
  }

  // Stylish Cardinal Headings & North Marker
  const labels = [['N', 0, '#ff3333'], ['E', 512, '#ffffff'], ['S', 1024, '#ffffff'], ['W', 1536, '#ffffff']];
  labels.forEach(l => {
    ctx.fillStyle = l[2];
    ctx.font = 'bold 60px Orbitron';
    ctx.fillText(l[0], l[1], 505);
    
    if (l[0] === 'N') {
      // Draw Red North Triangle
      ctx.beginPath();
      ctx.moveTo(l[1], 440);
      ctx.lineTo(l[1]-20, 480);
      ctx.lineTo(l[1]+20, 480);
      ctx.closePath();
      ctx.fill();
    }
  });

  // Use high-fidelity texture if available, fallback to procedural
  const loader = new THREE.TextureLoader();
  const texture = loader.load('assets/images/navball.png', function() {
    // Loaded successfully
    material.map = texture;
    material.needsUpdate = true;
  }, undefined, function() {
    // Error loading, keep procedural canvas texture
  });

  const canvasTexture = new THREE.CanvasTexture(canvas);
  canvasTexture.anisotropy = 16;
  canvasTexture.minFilter = THREE.LinearMipMapLinearFilter;

  const geometry = new THREE.SphereGeometry(50, 128, 128);
  const material = new THREE.MeshLambertMaterial({
    map: canvasTexture,
    shading: THREE.SmoothShading
  });

  // Global High-Fidelity Lighting
  this.scene.add(new THREE.AmbientLight(0xffffff, 1.1)); 
  const hemiLight = new THREE.HemisphereLight(0xffffff, 0x444444, 0.6);
  hemiLight.position.set(0, 500, 0);
  this.scene.add(hemiLight);

  this.sphere = new THREE.Mesh(geometry, material);
  this.scene.add(this.sphere);
};

// Navball lighting is now handled during sphere creation
Navball.prototype.addLights = function() {};

/**
 * Update orientation from Telemachus data.
 * Houston Logic: Order ZXY.
 * z: -roll, x: pitch, y: 270 - heading
 */
Navball.prototype.updateOrientation = function(pitch, roll, heading) {
  if (!this.sphere) return;

  // Direct mapping with Houston offsets
  this.sphere.rotation.order = "ZXY";
  this.sphere.rotation.z = THREE.Math.degToRad(-roll);
  this.sphere.rotation.x = THREE.Math.degToRad(pitch);
  this.sphere.rotation.y = THREE.Math.degToRad(270 - heading);

  this.pitch = pitch;
  this.roll = roll;
  this.heading = heading;
};

Navball.prototype.animate = function() {
  requestAnimationFrame(function() { this.animate(); }.bind(this));
  this.renderer.render(this.scene, this.camera);
};

window.Navball = Navball;
