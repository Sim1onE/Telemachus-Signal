/**
 * Navball (ES6)
 * A standalone 3D attitude indicator for the Telemachus 3D Map.
 * Renders a sphere that rotates in sync with KSP vessel orientation.
 * Houston Parity: Euler Order ZXY.
 */
function Navball(containerID) {
  this.container = document.getElementById(containerID);
  if (!this.container) return;

  this.scene = new THREE.Scene();

  // Adjusted FOV and distance to match Houston's clarity
  this.camera = new THREE.PerspectiveCamera(32, 1, 0.1, 1000);
  this.camera.position.z = 190; // Houston distance

  this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  this.renderer.setSize(this.container.clientWidth, this.container.clientHeight);
  this.container.appendChild(this.renderer.domElement);

  this.pitch = 0;
  this.roll = 0;
  this.heading = 0;

  this.createSphere();
  this.addLights();
  this.animate();
}

Navball.prototype.createSphere = function() {
  // Generate a procedural Navball texture (Blue for Sky, Brown for Ground)
  var canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 256;
  var ctx = canvas.getContext('2d');

  // Sky (Top half)
  ctx.fillStyle = '#0066cc';
  ctx.fillRect(0, 0, 512, 128);
  // Ground (Bottom half)
  ctx.fillStyle = '#663300';
  ctx.fillRect(0, 128, 512, 128);

  // Horizon line
  ctx.strokeStyle = 'white';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(0, 128);
  ctx.lineTo(512, 128);
  ctx.stroke();

  // Pitch lines & Numbers
  ctx.textAlign = 'center';
  ctx.font = 'bold 14px Roboto Mono';
  ctx.fillStyle = 'white';
  for (var i = -8; i <= 8; i++) {
    if (i === 0) continue;
    var y = 128 - (i * 12.8);
    ctx.beginPath();
    ctx.moveTo(230, y);
    ctx.lineTo(282, y);
    ctx.stroke();
    ctx.fillText(i * 10, 215, y + 5);
    ctx.fillText(i * 10, 297, y + 5);
  }

  var texture = new THREE.CanvasTexture(canvas);
  var geometry = new THREE.SphereGeometry(50, 48, 48); // Radius 50 like Houston
  var material = new THREE.MeshPhongMaterial({
    map: texture,
    shininess: 80,
    specular: 0x222222
  });

  this.sphere = new THREE.Mesh(geometry, material);
  this.scene.add(this.sphere);
};

Navball.prototype.addLights = function() {
  this.scene.add(new THREE.AmbientLight(0xaaaaaa));
  var light1 = new THREE.DirectionalLight(0xffffff, 1);
  light1.position.set(1500, 1500, 500);
  var light2 = new THREE.DirectionalLight(0xffffff, 0.5);
  light2.position.set(-1500, -1500, 500);
  this.scene.add(light1);
  this.scene.add(light2);
};

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
