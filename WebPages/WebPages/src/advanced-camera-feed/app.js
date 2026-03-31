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

        // Radio/Audio state
        this.audioCtx = null;
        this.micStream = null;
        this.micProcessor = null;
        this.isTransmitting = false;

        // UI Elements
        this.cameraList = document.getElementById('camera-list');
        this.cameraFeed = document.getElementById('camera-feed');
        this.fovSlider = document.getElementById('fov-slider');
        this.fovInput = document.getElementById('fov-input');
        this.resetZoomBtn = document.getElementById('reset-zoom-btn');
        this.radioBtn = document.getElementById('radio-ptt-btn');
        this.radioStatusUI = document.getElementById('radio-status');
        this.radioStatusText = this.radioStatusUI?.querySelector('.status-text');

        // Metadata elements
        this.metaName = document.getElementById('metadata-camera-name');
        this.metaRes = document.getElementById('metadata-resolution');
        this.metaFov = document.getElementById('metadata-fov');

        // Telemetry elements
        this.telAlt = document.getElementById('tel-alt');
        this.telVel = document.getElementById('tel-vel');
        this.telMet = document.getElementById('tel-met');
        this.telDelay = document.getElementById('tel-delay');
        this.telSignal = document.getElementById('tel-signal');
        
        this.statusOverlay = document.getElementById('viewport-overlay');
        this.statusText = document.getElementById('status-text');
        this.statusSpinner = document.getElementById('status-spinner');
        this.glitchOverlay = document.getElementById('glitch-overlay');

        this.lastFrameTime = 0;
        this.signalWatchdog = null;

        this.init();
    }

    async init() {
        this.bindEvents();
        await this.refreshCameraList();
        this.startTelemetryLoop();

        // Select first camera if available
        if (this.cameras.length > 0) {
            this.selectCamera(this.cameras[0]);
        } else {
            this.updateStatus('error', 'NO CAMERAS DETECTED');
        }

        // Start signal watchdog (10Hz)
        this.startSignalWatchdog();
    }

    bindEvents() {
        this.fovSlider.addEventListener('input', (e) => {
            const min = parseFloat(this.fovSlider.min);
            const max = parseFloat(this.fovSlider.max);
            const sliderVal = parseFloat(e.target.value);
            this.currentFov = (max + min) - sliderVal;
            this.fovInput.value = Math.round(this.currentFov);
            this.forceFovUpdate();
        });

        this.resetZoomBtn.addEventListener('click', () => {
            if (this.selectedCamera) {
                const min = parseFloat(this.fovSlider.min);
                const max = parseFloat(this.fovSlider.max);
                const def = this.selectedCamera.currentFov || 60;
                this.currentFov = def;
                this.fovSlider.value = (max + min) - def;
                this.fovInput.value = Math.round(this.currentFov);
                this.forceFovUpdate();
            }
        });

        if (this.radioBtn) {
            this.radioBtn.addEventListener('mousedown', () => this.startTransmission());
            this.radioBtn.addEventListener('mouseup', () => this.stopTransmission());
            this.radioBtn.addEventListener('mouseleave', () => this.stopTransmission());
        }
    }

    async refreshCameraList() {
        try {
            const response = await fetch(`${this.baseUrl}/telemachus/cameras`);
            this.cameras = await response.json();
            this.renderCameraList();
        } catch (err) { console.error('Failed to fetch cameras:', err); }
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
        if (this.cameraStream) this.cameraStream.stop();
        this.selectedCamera = cam;
        this.updateStatus('loading', `CONNECTING: ${cam.name}...`);
        
        // UI Defaults
        this.fovSlider.min = cam.fovMin || 1;
        this.fovSlider.max = cam.fovMax || 120;
        this.fovInput.value = Math.round(cam.currentFov || 60);
        this.metaName.innerText = `SENSOR: ${cam.name.toUpperCase()}`;

        // Initialize Specialized WebSocket Stream Library
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const streamUrl = `${protocol}//${window.location.host}/stream`;
        
        this.cameraStream = new TelemachusCameraStream(streamUrl, cam.name, this.cameraFeed, this);
        this.cameraStream.start();

        this.renderCameraList();
    }

    // Proxy for the stream library to read latest telemetry (Original Logic)
    get(key) {
        if (key === 't.universalTime') {
            if (!this.lastUtPollTime) return this.lastRemoteUt;
            // Interpolazione basata sul tempo locale trascorso dal poll e il warp rate
            const elapsedSeconds = (performance.now() - this.lastUtPollTime) / 1000;
            const warpRate = this.telemetryData.warp || 1;
            return this.lastRemoteUt + (elapsedSeconds * warpRate);
        }
        if (key === 'comm.signalDelay') return this.telemetryData.delay || 0;
        return this.telemetryData[key];
    }

    // Precise sync callback from the video stream metadata
    syncFromStream(ut, warp, delay, fov, signal) {
        // We NO LONGER update lastRemoteUt here. 
        // The master clock must only be driven by the 1Hz telemetry poll
        // to avoid double-delay and clock jitter.
        
        if (warp !== undefined) this.telemetryData.warp = warp;

        // Metadata UI updates (Instant)
        if (fov && this.metaFov) this.metaFov.innerText = `FOV: ${fov.toFixed(1)}°`;
        if (signal !== undefined) this.updateSignalUI(signal);

        this.lastFrameTime = Date.now();
        if (this.statusOverlay.style.display !== 'none') this.updateStatus('online');
    }

    updateSignalUI(signal) {
        if (this.telSignal) this.telSignal.innerText = `${signal}%`;
        const numBars = Math.ceil(signal / 25);
        for (let i = 1; i <= 4; i++) {
            const bar = document.getElementById(`signal-bar-${i}`);
            if (bar) bar.classList.toggle('active', i <= numBars);
        }
        if (this.glitchOverlay) this.glitchOverlay.classList.toggle('active', signal < 15);
        
        // Resolution label logic
        if (this.metaRes) {
            let res = 300;
            if (signal < 8) res = 75;
            else if (signal < 25) res = 150;
            this.metaRes.innerText = `RES: ${res}x${res}px`;
        }
    }

    startSignalWatchdog() {
        if (this.signalWatchdog) clearInterval(this.signalWatchdog);
        this.signalWatchdog = setInterval(() => {
            if (!this.selectedCamera) return;

            const now = Date.now();
            // Signal Loss Check
            if (now - this.lastFrameTime > 2500) {
                if (this.cameraStream && this.cameraStream.frameBuffer.length > 5) {
                    this.updateStatus('loading', 'BUFFERING/SYNCING...');
                } else {
                    this.updateStatus('error', 'NO SIGNAL');
                }
            }
            this.updateTelemetryUI();
        }, 100);
    }

    updateTelemetryUI() {
        const ut = this.get('t.universalTime');
        const delay = this.get('comm.signalDelay');

        if (this.telDelay) this.telDelay.innerText = `${delay.toFixed(1)}S`;
        
        if (ut && this.telMet && this.telemetryData.met) {
            // Sincronizzazione dell'orologio MET basata sull'UT interpolato
            const metOffset = ut - (this.telemetryData.ut || ut);
            const currentMet = this.telemetryData.met + metOffset;
            this.telMet.innerText = `T+ ${this.formatMET(currentMet)}`;
        }
    }

    async startTelemetryLoop() {
        const fetchTelemetry = async () => {
            try {
                const response = await fetch(`${this.baseUrl}/telemachus/datalink?alt=v.altitude&vel=v.orbitalVelocity&met=v.missionTime&ut=t.universalTime&delay=comm.signalDelay&warp=t.currentRate`);
                const data = await response.json();
                
                // Anti-Time-Travel & Restart Detection:
                // If the remote UT is much lower than our last recorded UT, 
                // it means the game was restarted or a save was loaded.
                if (data.ut > this.lastRemoteUt || (this.lastRemoteUt - data.ut) > 1.0) {
                    this.lastRemoteUt = data.ut;
                    this.lastUtPollTime = performance.now();
                }
                this.telemetryData = { ...this.telemetryData, ...data };

                if (data.alt) this.telAlt.innerText = `${(data.alt / 1000).toFixed(2)} KM`;
                if (data.vel) this.telVel.innerText = `${Math.round(data.vel)} M/S`;
            } catch (err) { }
        };
        setInterval(fetchTelemetry, 1000);
        fetchTelemetry();
    }

    forceFovUpdate() {
        if (!this.selectedCamera) return;
        const now = performance.now();
        if (now - this.lastFovUpdateTick < 100) return; // Debounce
        this.lastFovUpdateTick = now;

        fetch(this.selectedCamera.url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ fov: this.currentFov })
        }).catch(e => console.error("FOV Update Error", e));
    }

    updateStatus(type, msg) {
        if (!this.statusOverlay) return;
        if (type === 'online') { this.statusOverlay.style.display = 'none'; return; }
        this.statusOverlay.style.display = 'flex';
        this.statusText.innerText = (msg || '').toUpperCase();
        this.statusSpinner.style.display = type === 'loading' ? 'block' : 'none';
        this.statusText.classList.toggle('error', type === 'error');
    }

    // --- RADIO TRANSMISSION (Simplified and Integrated) ---
    async startTransmission() {
        if (!this.cameraStream?.ws || this.cameraStream.ws.readyState !== WebSocket.OPEN) return;
        try {
            this.isTransmitting = true;
            this.radioBtn.classList.add('active');
            if (this.radioStatusUI) {
                this.radioStatusUI.classList.add('transmitting');
                this.radioStatusText.innerText = 'TRANSMITTING...';
            }

            this.audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 22050 });
            this.micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
            const source = this.audioCtx.createMediaStreamSource(this.micStream);
            this.micProcessor = this.audioCtx.createScriptProcessor(2048, 1, 1);

            source.connect(this.micProcessor);
            this.micProcessor.connect(this.audioCtx.destination);

            this.micProcessor.onaudioprocess = (e) => {
                if (!this.isTransmitting) return;
                const input = e.inputBuffer.getChannelData(0);
                const pcm = new Int16Array(input.length);
                for (let i = 0; i < input.length; i++) {
                    const s = Math.max(-1, Math.min(1, input[i]));
                    pcm[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
                }
                const packet = new Uint8Array(1 + pcm.buffer.byteLength);
                packet[0] = 1; // Type 1: Audio Uplink
                packet.set(new Uint8Array(pcm.buffer), 1);
                this.cameraStream.ws.send(packet);
            };
        } catch (err) { console.error("Mic error:", err); this.stopTransmission(); }
    }

    stopTransmission() {
        this.isTransmitting = false;
        if (this.radioBtn) this.radioBtn.classList.remove('active');
        if (this.radioStatusUI) {
            this.radioStatusUI.classList.remove('transmitting');
            this.radioStatusText.innerText = 'STANDBY';
        }
        if (this.micProcessor) this.micProcessor.disconnect();
        if (this.micStream) this.micStream.getTracks().forEach(t => t.stop());
        if (this.audioCtx) this.audioCtx.close();
        this.micProcessor = null;
    }

    formatMET(seconds) {
        const d = Math.floor(seconds / (3600 * 24));
        seconds -= d * (3600 * 24);
        const h = Math.floor(seconds / 3600);
        seconds -= h * 3600;
        const m = Math.floor(seconds / 60);
        const sec = Math.floor(seconds % 60);
        return `${d}D ${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}`;
    }
}
document.addEventListener('DOMContentLoaded', () => { window.app = new AdvancedCameraFeed(); });
