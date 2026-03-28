class AdvancedCameraFeed {
    constructor() {
        this.selectedCamera = null;
        this.currentFov = null;
        this.cameras = [];
        this.baseUrl = window.location.origin;

        // UI Elements
        this.cameraList = document.getElementById('camera-list');
        this.cameraFeed = document.getElementById('camera-feed');
        this.fovSlider = document.getElementById('fov-slider');
        this.fovInput = document.getElementById('fov-input');
        this.resetZoomBtn = document.getElementById('reset-zoom-btn');

        // Metadata elements
        this.metaName = document.getElementById('metadata-camera-name');
        this.metaRes = document.getElementById('metadata-resolution');
        this.metaFov = document.getElementById('metadata-fov');

        // Telemetry elements
        this.telAlt = document.getElementById('tel-alt');
        this.telVel = document.getElementById('tel-vel');
        this.telMet = document.getElementById('tel-met');

        this.init();
    }

    async init() {
        this.bindEvents();
        await this.refreshCameraList();
        this.startTelemetryLoop();
        this.startImageLoop();

        // Select first camera if available
        if (this.cameras.length > 0) {
            this.selectCamera(this.cameras[0]);
        }
    }

    bindEvents() {
        this.fovSlider.addEventListener('input', (e) => {
            const min = parseFloat(this.fovSlider.min);
            const max = parseFloat(this.fovSlider.max);
            const sliderVal = parseFloat(e.target.value);
            
            // Invert the mapping: Max Slider = Min FOV (Zoom In)
            this.currentFov = (max + min) - sliderVal;
            this.fovInput.value = Math.round(this.currentFov);
            
            this.forceImmediateUpdate();
        });

        this.fovInput.addEventListener('change', (e) => {
            let val = parseFloat(e.target.value);
            if (!isNaN(val)) {
                const min = parseFloat(this.fovSlider.min);
                const max = parseFloat(this.fovSlider.max);
                
                this.currentFov = val;
                // Update slider using inverse mapping
                this.fovSlider.value = (max + min) - val;
                this.forceImmediateUpdate();
            }
        });

        this.resetZoomBtn.addEventListener('click', () => {
            if (this.selectedCamera) {
                const def = this.selectedCamera.fovDefault || 60;
                const min = parseFloat(this.fovSlider.min);
                const max = parseFloat(this.fovSlider.max);

                this.currentFov = def;
                this.fovSlider.value = (max + min) - def; // Inverted mapping
                this.fovInput.value = def;
                this.forceImmediateUpdate();
            }
        });
    }

    async refreshCameraList() {
        try {
            const response = await fetch(`${this.baseUrl}/telemachus/cameras`);
            const data = await response.json();
            this.cameras = data;
            this.renderCameraList();
        } catch (err) {
            console.error('Failed to fetch camera list:', err);
        }

        // Refresh list every 5 seconds to detect new cameras
        setTimeout(() => this.refreshCameraList(), 5000);
    }

    renderCameraList() {
        this.cameraList.innerHTML = '';
        this.cameras.forEach(cam => {
            const li = document.createElement('li');
            li.className = `camera-item ${this.selectedCamera?.name === cam.name ? 'active' : ''}`;
            li.innerHTML = `<span>${cam.name}</span> <small style="opacity: 0.5;">${cam.type}</small>`;
            li.addEventListener('click', () => this.selectCamera(cam));
            this.cameraList.appendChild(li);
        });
    }

    selectCamera(cam) {
        this.selectedCamera = cam;
        this.currentFov = null; // Reset zoom state when switching

        // Update UI limits
        const min = cam.fovMin || 1;
        const max = cam.fovMax || 120;
        const def = cam.fovDefault || 60;

        this.fovSlider.min = min;
        this.fovSlider.max = max;
        // Set slider position using inverted mapping
        this.fovSlider.value = (max + min) - def;
        this.fovInput.value = def;

        this.metaName.innerText = `SENSOR: ${cam.name.toUpperCase()}`;

        // Highlight active
        document.querySelectorAll('.camera-item').forEach(el => el.classList.remove('active'));
        this.renderCameraList();
    }

    startImageLoop() {
        setInterval(() => {
            if (!this.selectedCamera) return;

            const cacheBuster = Date.now();
            const fovParam = (this.currentFov !== null && this.currentFov !== undefined) ? `&fov=${this.currentFov}` : "";

            // Generate full URL
            const url = `${this.selectedCamera.url}?cb=${cacheBuster}${fovParam}`;

            // Visual feedback: brief metadata update
            this.metaFov.innerText = `FOV: ${this.fovInput.value}°`;

            // To prevent flickering, we could use an Image object buffer, but for 4FPS simple src swap is usually okay with cache-control headers.
            this.cameraFeed.src = url;

            // Update resolution metadata once image loads
            if (this.cameraFeed.naturalWidth) {
                this.metaRes.innerText = `RES: ${this.cameraFeed.naturalWidth}x${this.cameraFeed.naturalHeight}`;
            }
        }, 100); // 10 FPS
    }

    forceImmediateUpdate() {
        // Force a single tick now
        const cacheBuster = Date.now();
        const fovParam = `&fov=${this.currentFov}`;
        this.cameraFeed.src = `${this.selectedCamera.url}?cb=${cacheBuster}${fovParam}`;
    }

    async startTelemetryLoop() {
        const fetchTelemetry = async () => {
            try {
                // Fetch basic ship stats
                const response = await fetch(`${this.baseUrl}/telemachus/datalink?alt=v.altitude&vel=v.orbitalVelocity&met=v.missionTime`);
                const data = await response.json();

                if (data.alt) {
                    const altKm = (data.alt / 1000).toFixed(2);
                    this.telAlt.innerText = `${altKm} KM`;
                }
                if (data.vel) {
                    this.telVel.innerText = `${Math.round(data.vel)} M/S`;
                }
                if (data.met) {
                    this.telMet.innerText = `T+ ${this.formatMET(data.met)}`;
                }
            } catch (err) {
                // Silently fail telemetry if not in flight
            }
        };

        setInterval(fetchTelemetry, 1000);
        fetchTelemetry(); // Initial fetch
    }

    formatMET(seconds) {
        const days = Math.floor(seconds / (3600 * 24));
        seconds -= days * (3600 * 24);
        const hrs = Math.floor(seconds / 3600);
        seconds -= hrs * 3600;
        const mins = Math.floor(seconds / 60);
        const secs = Math.floor(seconds % 60);

        return `${days}D ${hrs.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    }
}

// Initialize on Load
document.addEventListener('DOMContentLoaded', () => {
    window.app = new AdvancedCameraFeed();
});
