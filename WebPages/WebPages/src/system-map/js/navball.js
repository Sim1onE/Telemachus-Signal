/**
 * Navball (ES6)
 * A standalone 3D attitude indicator for the Telemachus 3D Map.
 * Renders a sphere that rotates in sync with KSP vessel orientation.
 */
class Navball {
  constructor(containerID) {
    this.container = document.getElementById(containerID);
    if (!this.container) return;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
    this.camera.position.z = 2.5;

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setSize(this.container.clientWidth, this.container.clientHeight);
    this.container.appendChild(this.renderer.domElement);

    this.createSphere();
    this.createMarkers();
    this.addLights();

    this.animate();
  }

  createSphere() {
    // Generate a procedural Navball texture (Blue for Sky, Brown for Ground)
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 256;
    const ctx = canvas.getContext('2d');

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

    // Pitch lines
    ctx.textAlign = 'center';
    ctx.font = '12px Orbitron';
    for (let i = 1; i < 9; i++) {
        const yTop = 128 - (i * 12.8);
        const yBot = 128 + (i * 12.8);
        ctx.strokeRect(240, yTop, 32, 1);
        ctx.strokeRect(240, yBot, 32, 1);
        ctx.fillStyle = 'white';
        ctx.fillText(i * 10, 230, yTop + 5);
        ctx.fillText(-(i * 10), 230, yBot + 5);
    }

    const texture = new THREE.CanvasTexture(canvas);
    const geometry = new THREE.SphereGeometry(1, 32, 32);
    const material = new THREE.MeshPhongMaterial({ 
        map: texture,
        shininess: 30,
        specular: 0x222222
    });

    this.sphere = new THREE.Mesh(geometry, material);
    this.scene.add(this.sphere);
  }

  createMarkers() {
    this.markerGroup = new THREE.Group();
    this.scene.add(this.markerGroup);

    // Placeholder for Prograde/Retrograde
    // In a real KSP context, these rotate RELATIVE to the navball based on velocity vector
    // We'll expose a method to set their relative orientation
  }

  addLights() {
    const light = new THREE.PointLight(0xffffff, 1, 10);
    light.position.set(2, 2, 5);
    this.scene.add(light);
    this.scene.add(new THREE.AmbientLight(0x404040));
  }

  /**
   * Update orientation from Telemachus data.
   * KSP Convention: Heading (0-360), Pitch (-90 to 90), Roll (-180 to 180)
   */
  updateOrientation(pitch, roll, heading) {
    if (!this.sphere) return;

    // Convert to Radians
    const p = (pitch || 0) * Math.PI / 180;
    const r = (roll || 0) * Math.PI / 180;
    const h = (heading || 0) * Math.PI / 180;

    // Apply rotation order ZXY as used in Houston/KeRD
    this.sphere.rotation.order = "ZXY";
    this.sphere.rotation.z = -r;
    this.sphere.rotation.x = p;
    this.sphere.rotation.y = (270 * Math.PI / 180) - h;
  }

  animate() {
    requestAnimationFrame(() => this.animate());
    this.renderer.render(this.scene, this.camera);
  }
}

window.Navball = Navball;
走
