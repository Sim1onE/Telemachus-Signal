class CommunicationsConsole {
    constructor() {
        this.selectedCamera = null;
        this.currentFov = null;
        this.cameras = [];
        this.baseUrl = window.location.origin;
        this.signalLink = null;
        this.cameraReceiver = null;
        this.radioReceiver = null;
        this.audioCtx = null;
        this.telemetryData = {};
        this.lastFovUpdateTick = 0;
        this.fovUpdateTimeout = null;
        this.needsFovSync = false;

        // UI Elements
        this.cameraList = document.getElementById('camera-list');
        this.cameraFeed = document.getElementById('camera-feed');
        this.fovSlider = document.getElementById('fov-slider');
        this.fovInput = document.getElementById('fov-input');
        this.resetZoomBtn = document.getElementById('reset-zoom-btn');
        this.radioBtn = document.getElementById('radio-ptt-btn');
        this.speakerBtn = document.getElementById('radio-speaker-btn');
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

        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const streamUrl = `${protocol}//${window.location.host}/stream`;
        
        if (!this.signalLink) {
            this.signalLink = new TelemachusSignalLink(streamUrl, this);
            
            // Listen for high-frequency status heartbeats (JSON)
            this.signalLink.on('status', (status) => {
                this.handleSignalStatus(status);
            });

            // Camera List Response (JSON)
            this.signalLink.on('cameraList', (msg) => {
                this.cameras = msg.cameras;
                this.renderCameraList();
                
                if (!this.selectedCamera && this.cameras.length > 0) {
                    this.selectCamera(this.cameras[0]);
                }
            });

            this.signalLink.connect();
        }

        this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        
        this.radioTransmitter = new RadioTransmitter(this.signalLink, this.audioCtx);
        this.radioReceiver = new RadioReceiver(this.signalLink, this.audioCtx);
        this.radioReceiver.start(); // Start background preparation immediately
        
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
                const def = this.selectedCamera.currentFov || 60;
                this.currentFov = def;
                this.fovInput.value = Math.round(this.currentFov);
                this.forceFovUpdate();
            }
        });

        if (this.radioBtn) {
            this.radioBtn.oncontextmenu = (e) => { e.preventDefault(); return false; };
            this.radioBtn.addEventListener('pointerdown', async (e) => {
                e.preventDefault();
                this.radioBtn.classList.add('active');
                if (this.radioStatusUI) this.radioStatusUI.classList.add('transmitting');
                try {
                    // v14.35: NO Await for receiver. Instant transmission.
                    if (this.audioCtx.state === 'suspended') await this.audioCtx.resume();
                    await this.radioTransmitter.startTransmission();
                } catch(err) {
                    this.stopRadioUI();
                }
            });
            this.radioBtn.addEventListener('pointerup', (e) => { this.stopRadioUI(); });
            this.radioBtn.addEventListener('pointercancel', (e) => { this.stopRadioUI(); });
        }

        if (this.speakerBtn) {
            this.speakerBtn.addEventListener('click', async () => {
                // Autoplay Bypass: Resuming context on user gesture
                if (this.audioCtx.state === 'suspended') await this.audioCtx.resume();
                
                const nextMuteState = !this.radioReceiver.isMuted;
                this.radioReceiver.setMuted(nextMuteState);
                
                // Toggle UI state
                this.speakerBtn.classList.toggle('muted', nextMuteState);
                this.speakerBtn.classList.toggle('unmuted', !nextMuteState);
                
                const icon = this.speakerBtn.querySelector('.icon');
                if (icon) icon.innerText = nextMuteState ? '🔇' : '🔊';
            });
        }
    }

    stopRadioUI() {
        if (this.radioTransmitter) this.radioTransmitter.stopTransmission();
        if (this.radioBtn) this.radioBtn.classList.remove('active');
        if (this.radioStatusUI) this.radioStatusUI.classList.remove('transmitting');
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
        if (this.cameraReceiver) this.cameraReceiver.stop();
        this.selectedCamera = cam;
        this.updateStatus('loading', `CONNECTING: ${cam.name.toUpperCase()}...`);

        this.fovSlider.min = cam.fovMin || 1;
        this.fovSlider.max = cam.fovMax || 120;
        
        // v15.01 Fix: Update BOTH input and slider to match the camera's initial state
        const initialFov = cam.currentFov || 60;
        this.fovInput.value = Math.round(initialFov);
        this.fovSlider.value = (parseFloat(this.fovSlider.max) + parseFloat(this.fovSlider.min)) - initialFov;
        this.currentFov = initialFov;

        this.metaName.innerText = `SENSOR: ${cam.name.toUpperCase()}`;
        this.needsFovSync = true; // Wait for the first real packet from KSP to snap the UI

        this.cameraReceiver = new CameraReceiver(this.signalLink, this.cameraFeed, this);
        this.cameraReceiver.start(cam.name);
        this.renderCameraList();
    }

    handleSignalStatus(status) {
        this.telemetryData.ut = status.ut;
        this.telemetryData.warp = status.warp;
        this.telemetryData.delay = status.delay;
        this.telemetryData.quality = status.quality;

        // Main UI updates directly from Heartbeat
        if (this.telDelay && status.delay !== undefined) this.telDelay.innerText = `${status.delay.toFixed(1)}S`;
        if (this.telSignal && status.quality !== undefined) this.telSignal.innerText = `${status.quality}%`;
        if (this.telAlt && status.alt !== undefined) this.telAlt.innerText = `${(status.alt / 1000).toFixed(2)} KM`;
        if (this.telVel && status.vel !== undefined) this.telVel.innerText = `${Math.round(status.vel)} M/S`;
        if (this.telMet && status.met !== undefined) this.telMet.innerText = `T+ ${this.formatMET(status.met)}`;

        this.updateSignalUI(status.quality);
    }

    syncFromStream(ut, warp, delay, fov, signal) {
        if (fov && this.metaFov) this.metaFov.innerText = `FOV: ${fov.toFixed(1)}°`;
        
        // v15.02: Snap the UI controls to the actual live state on the first frame received
        if (this.needsFovSync && fov) {
            this.fovInput.value = Math.round(fov);
            this.fovSlider.value = (parseFloat(this.fovSlider.max) + parseFloat(this.fovSlider.min)) - fov;
            this.currentFov = fov;
            this.needsFovSync = false;
        }

        // v15.03: Update resolution info from the actual canvas if available
        if (this.cameraFeed && this.metaRes) {
            this.metaRes.innerText = `RES: ${this.cameraFeed.width}x${this.cameraFeed.height}`;
        }

        this.lastFrameTime = Date.now();
        if (this.statusOverlay.style.display !== 'none') this.updateStatus('online');
    }

    updateSignalUI(signal) {
        const numBars = Math.ceil(signal / 25);
        for (let i = 1; i <= 4; i++) {
            const bar = document.getElementById(`signal-bar-${i}`);
            if (bar) bar.classList.toggle('active', i <= numBars);
        }
        if (this.glitchOverlay) this.glitchOverlay.classList.toggle('active', signal < 15);
    }

    startSignalWatchdog() {
        setInterval(() => {
            if (!this.selectedCamera) return;
            const now = Date.now();
            if (now - this.lastFrameTime > 2500) {
                if (this.cameraReceiver && this.cameraReceiver.sync.queue.length > 5) {
                    this.updateStatus('loading', 'BUFFERING/SYNCING...');
                } else {
                    this.updateStatus('error', 'NO SIGNAL');
                }
            }
        }, 500);
    }

    forceFovUpdate() {
        if (!this.selectedCamera || !this.signalLink) return;
        const now = performance.now();
        const minInterval = 50;

        if (now - this.lastFovUpdateTick < minInterval) {
            if (this.fovUpdateTimeout) clearTimeout(this.fovUpdateTimeout);
            this.fovUpdateTimeout = setTimeout(() => {
                this.fovUpdateTimeout = null;
                this.forceFovUpdate();
            }, minInterval);
            return;
        }

        this.lastFovUpdateTick = now;
        this.signalLink.queueCommand({ 
            camera: this.selectedCamera.name, 
            action: "fov", 
            fov: this.currentFov 
        });
    }

    updateStatus(type, msg) {
        if (!this.statusOverlay) return;
        if (type === 'online') { this.statusOverlay.style.display = 'none'; return; }
        this.statusOverlay.style.display = 'flex';
        this.statusText.innerText = (msg || '').toUpperCase();
        this.statusSpinner.style.display = type === 'loading' ? 'block' : 'none';
        this.statusText.classList.toggle('error', type === 'error');
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
document.addEventListener('DOMContentLoaded', () => { window.app = new CommunicationsConsole(); });
