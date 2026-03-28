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
        this.lastFovUpdateTick = 0;
        this.fovUpdateTimeout = null;
        this.isUpdatingFov = false;
        this.fovAbortController = null;

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
        this.rulerScale = document.getElementById('ruler-scale');

        // Telemetry elements
        this.telAlt = document.getElementById('tel-alt');
        this.telVel = document.getElementById('tel-vel');
        this.telMet = document.getElementById('tel-met');
        this.statusOverlay = document.getElementById('viewport-overlay');
        this.statusText = document.getElementById('status-text');
        this.statusSpinner = document.getElementById('status-spinner');

        this.telSignal = document.getElementById('tel-signal');
        this.signalBars = document.querySelector('.signal-bars');
        this.glitchOverlay = document.getElementById('glitch-overlay');

        this.lastFrameTime = 0;
        this.signalWatchdog = null;

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
        } else {
            this.updateStatus('error', 'NO CAMERAS DETECTED');
        }

        // Start signal watchdog
        this.startSignalWatchdog();
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
                const step = 5;

                // Snap to 5 degree increments
                val = Math.round(val / step) * step;
                val = Math.max(min, Math.min(max, val));

                this.currentFov = val;
                this.fovInput.value = val;
                // Update slider using inverse mapping
                this.fovSlider.value = (max + min) - val;
                this.forceImmediateUpdate();
            }
        });

        this.resetZoomBtn.addEventListener('click', () => {
            if (this.selectedCamera) {
                const min = parseFloat(this.fovSlider.min);
                const max = parseFloat(this.fovSlider.max);
                const step = 5;
                
                let def = this.selectedCamera.currentFov || 60;
                // Snap default to grid
                def = Math.round(def / step) * step;

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

    async selectCamera(cam) {
        if (this.cameraStream) {
            this.cameraStream.stop();
        }

        // Fresh Fetch: Get the absolute latest metadata for THIS specific camera
        // before initializing the slider to prevent any "fov jump" due to stale data.
        try {
            const response = await fetch(`${this.baseUrl}/telemachus/cameras`);
            const allCameras = await response.json();
            const freshCam = allCameras.find(c => c.name === cam.name);
            if (freshCam) {
                cam = freshCam; // Use updated metadata (especially currentFov)
            }
        } catch (err) {
            console.warn("Failed to perform fresh metadata fetch, falling back to cached state.", err);
        }

        this.selectedCamera = cam;
        this.updateStatus('loading', `CONNECTING: ${cam.name}...`);
        this.currentFov = null; // Reset zoom state when switching

        // Update UI limits
        const min = cam.fovMin || 1;
        const max = cam.fovMax || 120;
        const current = cam.currentFov || 60;

        this.currentFov = current; // Sincronizza lo stato logico con quello reale del sensore
        
        this.fovSlider.min = min;
        this.fovSlider.max = max;
        // Set slider position using inverted mapping
        this.fovSlider.value = (max + min) - current;
        this.fovInput.value = Math.round(current);

        // Regerate the ruler markers based on sensor limits
        this.generateRuler(min, max);

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
    syncFromStream(ut, warp, delay, fov, signal) {
        // Only update if we see a significant jump or a warp change
        const currentPredicted = this.get('t.universalTime');
        // If warp or delay changed, update telemetry data immediately
        if (warp !== this.telemetryData.warp || delay !== this.telemetryData.delay) {
            if (warp !== undefined) this.telemetryData.warp = warp;
            if (delay !== undefined) this.telemetryData.delay = delay;
        }

        // Update FOV metadata with real-time value from stream (includes decimals for "wow" effect)
        if (fov !== null && fov > 0 && this.metaFov) {
            this.metaFov.innerText = `FOV: ${fov.toFixed(1)}°`;
        }

        // Update Signal UI
        if (signal !== undefined) {
            this.updateSignalUI(signal);
        }

        // Signal received: Hide overlay
        this.lastFrameTime = Date.now();
        if (this.statusOverlay.style.display !== 'none') {
            this.updateStatus('online');
        }
    }

    updateSignalUI(signal) {
        if (this.telSignal) this.telSignal.innerText = `${signal}%`;
        
        // Update bars
        const numBars = Math.ceil(signal / 25);
        for (let i = 1; i <= 4; i++) {
            const bar = document.getElementById(`signal-bar-${i}`);
            if (bar) {
                if (i <= numBars) bar.classList.add('active');
                else bar.classList.remove('active');
            }
        }

        // Update bar colors and glitch
        if (this.signalBars) {
            this.signalBars.classList.toggle('low', signal < 40 && signal >= 15);
            this.signalBars.classList.toggle('critical', signal < 15);
        }

        if (this.glitchOverlay) {
            // Activate glitch if signal is very low
            this.glitchOverlay.classList.toggle('active', signal < 15);
        }

        // Update resolution metadata based on scaling
        if (this.metaRes) {
            let res = 300;
            if (signal < 8) res = 75;
            else if (signal < 25) res = 150;
            this.metaRes.innerText = `RES: ${res}x${res}px`;
        }
    }

    updateStatus(type, message) {
        if (!this.statusOverlay) return;

        if (type === 'online') {
            this.statusOverlay.style.display = 'none';
            return;
        }

        this.statusOverlay.style.display = 'flex';
        this.statusText.innerText = (message || '').toUpperCase();
        
        if (type === 'loading') {
            this.statusSpinner.style.display = 'block';
            this.statusText.classList.remove('error');
        } else if (type === 'error') {
            this.statusSpinner.style.display = 'none';
            this.statusText.classList.add('error');
        }
    }

    startSignalWatchdog() {
        if (this.signalWatchdog) clearInterval(this.signalWatchdog);
        this.signalWatchdog = setInterval(() => {
            if (!this.selectedCamera) return;
            
            const now = Date.now();
            if (now - this.lastFrameTime > 2500) {
                this.updateStatus('error', 'NO SIGNAL');
            }

            // High-frequency UI update for MET clock smoothness
            this.updateTelemetryUI();
        }, 100); // 10Hz UI refresh for clock smoothness
    }

    updateTelemetryUI() {
        const ut = this.get('t.universalTime');
        if (ut && this.telMet && this.telemetryData.met) {
            // Calculate current MET based on UT drift from the first poll
            const metOffset = ut - (this.telemetryData.ut || ut);
            const currentMet = this.telemetryData.met + metOffset;
            this.telMet.innerText = `T+ ${this.formatMET(currentMet)}`;
        }
    }

    forceImmediateUpdate() {
        if (!this.selectedCamera) return;

        const now = performance.now();
        const minInterval = 33; // 30 FPS ceiling

        // If we are moving too fast, schedule a single update for the "cooldown"
        if (now - this.lastFovUpdateTick < minInterval) {
            if (!this.fovUpdateTimeout) {
                this.fovUpdateTimeout = setTimeout(() => {
                    this.fovUpdateTimeout = null;
                    this.forceImmediateUpdate();
                }, minInterval);
            }
            return;
        }

        // Abort the previous request if it's still hanging in the network queue
        if (this.fovAbortController) {
            this.fovAbortController.abort();
        }

        this.fovAbortController = new AbortController();
        this.lastFovUpdateTick = now;
        
        const payload = { fov: this.currentFov };
        
        fetch(this.selectedCamera.url, { 
            method: 'POST', 
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
            signal: this.fovAbortController.signal
        })
        .then(() => {
            this.fovAbortController = null;
        })
        .catch(err => {
            if (err.name === 'AbortError') return; // Expected
            console.error("Failed to sync FOV via POST:", err);
            this.fovAbortController = null;
        });
    }

    generateRuler(min, max) {
        if (!this.rulerScale) return;
        
        this.rulerScale.innerHTML = '';
        const step = 5;
        
        // Collect all values to mark: min, max, and multiples of 5 in between
        let values = [min];
        
        // Find first multiple of 5 > min
        let firstStep = Math.ceil((min + 0.1) / step) * step;
        for (let v = firstStep; v < max; v += step) {
            values.push(v);
        }
        
        // Only push max if it's not already added (e.g. max is multiple of 5)
        if (max > values[values.length - 1]) {
            values.push(max);
        }

        values.forEach(val => {
            const span = document.createElement('span');
            // Calculate exact percentage position on the track
            const percent = ((val - min) / (max - min)) * 100;
            span.style.left = `${percent}%`;

            // Check if it's a "major" tick (every 15 degrees)
            if (val % 15 === 0) {
                span.classList.add('major');
            }
            this.rulerScale.appendChild(span);
        });
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

                // Display data update
                if (data.alt) {
                    const altKm = (data.alt / 1000).toFixed(2);
                    this.telAlt.innerText = `${altKm} KM`;
                }
                if (data.vel) {
                    this.telVel.innerText = `${Math.round(data.vel)} M/S`;
                }

                // Note: telMet is now updated in a high-frequency loop elsewhere (updateTelemetryUI)
                // for absolute smoothness.


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
