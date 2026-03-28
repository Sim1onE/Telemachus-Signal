class AdvancedCameraFeed {
    constructor() {
        this.selectedCamera = null;
        this.currentFov = null;
        this.cameras = [];
        this.baseUrl = window.location.origin;
        this.cameraStream = null;
        this.telemetryData = {};
        this.lastUtPollTime = null;
        this.lastRemoteUt = 0;

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
        if (this.cameraStream) {
            this.cameraStream.stop();
        }

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

        // Initialize and start the stream
        // Construct the stream URL from the metadata URL
        const streamUrl = `${this.baseUrl}/telemachus/cameras/stream/${cam.name}`;
        this.cameraStream = new TelemachusCameraStream(streamUrl, this.cameraFeed, this);
        this.cameraStream.start();

        // Highlight active
        document.querySelectorAll('.camera-item').forEach(el => el.classList.remove('active'));
        this.renderCameraList();
    }

    startImageLoop() {
        // We no longer need a manual setInterval loop. 
        // Rendering is handled by the TelemachusCameraStream library.
    }

    // Proxy for the stream library to read latest telemetry
    get(key) {
        if (key === 't.universalTime') {
            if (!this.lastUtPollTime) return this.lastRemoteUt;
            const elapsedSeconds = (performance.now() - this.lastUtPollTime) / 1000;
            const warpRate = this.telemetryData.warp || 1;
            return this.lastRemoteUt + (elapsedSeconds * warpRate);
        }
        if (key === 'comm.signalDelay') return this.telemetryData.delay || 0;
        return this.telemetryData[key];
    }

    // Precise sync callback from the video stream metadata
    syncFromStream(ut, warp, delay) {
        // Only update if we see a significant jump or a warp change
        const currentPredicted = this.get('t.universalTime');
        const jump = Math.abs(ut - currentPredicted);
        
        // If we jump more than 0.5s or if warp changed, resync the local clocks
        if (jump > 0.5 || warp !== this.telemetryData.warp || delay !== this.telemetryData.delay) {
            this.lastRemoteUt = ut;
            this.lastUtPollTime = performance.now();
            if (warp !== undefined) this.telemetryData.warp = warp;
            if (delay !== undefined) this.telemetryData.delay = delay;
        }
    }

    forceImmediateUpdate() {
        if (!this.selectedCamera) return;
        // In the new stream architecture, we send a lightweight HEAD or GET request
        // to the regular camera endpoint just to push the new FOV to the server.
        // The active MJPEG stream will then automatically reflect the new FOV.
        const fovParam = (this.currentFov !== null) ? `?fov=${this.currentFov}` : "";
        fetch(`${this.selectedCamera.url}${fovParam}`, { method: 'GET', cache: 'no-cache' })
            .catch(err => console.error("Failed to sync FOV to server:", err));
    }

    async startTelemetryLoop() {
        const fetchTelemetry = async () => {
            try {
                const response = await fetch(`${this.baseUrl}/telemachus/datalink?alt=v.altitude&vel=v.orbitalVelocity&met=v.missionTime&ut=t.universalTime&delay=comm.signalDelay&warp=t.currentRate`);
                const data = await response.json();
                
                // Anti-Time-Travel: only update if data is more recent than what we have
                // This prevents the 1Hz telemetry from overriding the 30Hz video sync
                if (data.ut > this.lastRemoteUt) {
                    this.lastRemoteUt = data.ut;
                    this.lastUtPollTime = performance.now();
                }

                // Merge telemetry data instead of overwriting everything
                this.telemetryData = { ...this.telemetryData, ...data };

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

                // Update FOV metadata based on UI input (since stream doesn't push this back)
                this.metaFov.innerText = `FOV: ${this.fovInput.value}°`;
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
