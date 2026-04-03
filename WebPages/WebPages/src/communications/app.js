class CommunicationsConsole {
    constructor() {
        this.cameras = [];
        this.baseUrl = window.location.origin;
        this.signalLink = null;
        this.radioReceiver = null;
        this.audioCtx = null;
        this.telemetryData = {};
        this.activeWidgets = new Map(); // v16.08: Multiplexed widgets map
        this.nextCameraId = 1;

        // UI Elements
        this.cameraList = document.getElementById('camera-list');
        this.radioBtn = document.getElementById('radio-ptt-btn');
        this.speakerBtn = document.getElementById('radio-speaker-btn');
        this.radioStatusUI = document.getElementById('radio-status');
        this.radioStatusText = this.radioStatusUI?.querySelector('.status-text');

        // Telemetry elements
        this.telAlt = document.getElementById('tel-alt');
        this.telVel = document.getElementById('tel-vel');
        this.telMet = document.getElementById('tel-met');
        this.telDelay = document.getElementById('tel-delay');
        this.telSignal = document.getElementById('tel-signal');

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
                this.cameras = msg.cameras || [];
                this.renderCameraList();
                
                if (this.cameras.length === 0) {
                     setTimeout(() => this.signalLink.requestCameraList(), 2000);
                     return;
                }

                // Auto-recovery after restart (Keep existing widgets alive)
                this.activeWidgets.forEach((widget, name) => {
                    const match = this.cameras.find(c => c.name === name);
                    if (match) {
                        widget.camInfo = match;
                        widget.start();
                    }
                });

                if (this.activeWidgets.size === 0 && this.cameras.length > 0) {
                    this.toggleCamera(this.cameras[0]);
                }
            });

            // Connection Re-established (v15.07)
            this.signalLink.on('open', () => {
                this.activeWidgets.forEach(widget => {
                    widget.receiver.sync.clear();
                    widget.start();
                });
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
        // FOV events moved to CameraWidget class
        
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
            const isActive = this.activeWidgets.has(cam.name);
            const li = document.createElement('li');
            li.className = `camera-item ${isActive ? 'in-grid' : ''}`;
            li.innerHTML = `<span>${cam.name}</span> <small style="opacity: 0.5;">${cam.type}</small>`;
            li.addEventListener('click', () => this.toggleCamera(cam));
            this.cameraList.appendChild(li);
        });
    }

    toggleCamera(cam) {
        if (this.activeWidgets.has(cam.name)) {
            const widget = this.activeWidgets.get(cam.name);
            widget.destroy();
            this.activeWidgets.delete(cam.name);
        } else {
            // Maximum cameras check
            if (this.activeWidgets.size >= 6) return;

            const grid = document.getElementById('camera-grid');
            const widget = new CameraWidget(grid, this.signalLink, cam, this.nextCameraId++);
            widget.onClose = (w) => this.toggleCamera(w.camInfo);
            this.activeWidgets.set(cam.name, widget);
        }
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

    syncFromStream(ut, warp, delay, fov, signal, id) {
        // Individual widgets handle their own syncFromStream calls directly from CameraReceiver
        this.lastFrameTime = Date.now();
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
            this.activeWidgets.forEach(widget => {
                widget.updateWatchdog();
            });
            
            // Check overall connection
            const now = Date.now();
            const isDead = !this.signalLink.ws || this.signalLink.ws.readyState !== WebSocket.OPEN;
            if (isDead) {
                if (this.cameras.length > 0) {
                    this.cameras = [];
                    this.renderCameraList();
                }
            }
        }, 500);
    }


    updateStatus(type, msg) {
        // Global status updates (rarely used now, delegated to widgets)
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
