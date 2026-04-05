/**
 * CameraWidget Component
 * Encapsulates a single camera feed with its own controls, metadata and receiver.
 * Supports multiplexed streaming via CameraID.
 */
class CameraWidget {
    constructor(parentContainer, signalLink, camInfo, cameraId) {
        this.parent = parentContainer;
        this.signalLink = signalLink;
        this.camInfo = camInfo;
        this.cameraId = cameraId;
        
        this.needsFovSync = true;
        this.currentFov = camInfo.currentFov || 60;
        this.lastFrameTime = Date.now();
        
        this.dom = this.setupUI();
        this.receiver = new CameraReceiver(this.signalLink, this.canvas, this, this.cameraId);
        
        this.start();
    }

    setupUI() {
        const template = document.getElementById('camera-widget-template');
        const clone = template.content.cloneNode(true);
        const container = clone.querySelector('.camera-widget');
        
        // Element references
        this.canvas = container.querySelector('.camera-viewport');
        this.metaName = container.querySelector('.metadata-camera-name');
        this.metaRes = container.querySelector('.metadata-resolution');
        this.metaFov = container.querySelector('.metadata-fov');
        this.fovSlider = container.querySelector('.fov-slider');
        this.fovInput = container.querySelector('.fov-input');
        this.resetBtn = container.querySelector('.reset-zoom-btn');
        this.closeBtn = container.querySelector('.close-widget-btn');
        this.statusOverlay = container.querySelector('.viewport-overlay');
        this.statusText = container.querySelector('.status-text');
        this.glitchOverlay = container.querySelector('.glitch-overlay');
        this.rulerScale = container.querySelector('.ruler-scale');

        // Initial values
        this.metaName.innerText = `SENSOR: ${this.camInfo.name.toUpperCase()}`;
        this.fovSlider.min = this.camInfo.fovMin || 5;
        this.fovSlider.max = this.camInfo.fovMax || 120;
        this.updateUIFromFov(this.currentFov);
        
        this.generateRulerTicks();

        // Events
        this.fovSlider.addEventListener('input', (e) => {
            const min = parseFloat(this.fovSlider.min);
            const max = parseFloat(this.fovSlider.max);
            const sliderVal = parseFloat(e.target.value);
            this.currentFov = (max + min) - sliderVal;
            this.fovInput.value = Math.round(this.currentFov);
            this.sendFovCommand();
        });

        this.resetBtn.addEventListener('click', () => {
            this.currentFov = this.camInfo.currentFov || 60;
            this.updateUIFromFov(this.currentFov);
            this.sendFovCommand();
        });

        this.closeBtn.addEventListener('click', () => {
            if (this.onClose) this.onClose(this);
        });

        this.parent.appendChild(container);
        return container;
    }

    generateRulerTicks() {
        if (!this.rulerScale) return;
        const count = 10;
        for (let i = 0; i <= count; i++) {
            const span = document.createElement('span');
            span.style.left = `${(i / count) * 100}%`;
            if (i % 5 === 0) span.classList.add('major');
            this.rulerScale.appendChild(span);
        }
    }

    updateUIFromFov(fov) {
        this.fovInput.value = Math.round(fov);
        const min = parseFloat(this.fovSlider.min);
        const max = parseFloat(this.fovSlider.max);
        this.fovSlider.value = (max + min) - fov;
    }

    start() {
        // v18.14: Standardized camera subscription API (30 FPS default)
        this.signalLink.subscribeCamera(this.cameraId, this.camInfo.name, { rate: 33 });
        
        this.receiver.start(this.camInfo.name);
        this.lastFrameTime = Date.now();
    }

    syncFromStream(ut, warp, delay, fov, signal) {
        this.lastFrameTime = Date.now();
        
        if (this.metaFov) this.metaFov.innerText = `FOV: ${fov.toFixed(1)}°`;
        
        // One-shot snap on first frame
        if (this.needsFovSync && fov) {
            this.currentFov = fov;
            this.updateUIFromFov(fov);
            this.needsFovSync = false;
        }

        if (this.canvas && this.metaRes) {
            this.metaRes.innerText = `RES: ${this.canvas.width}x${this.canvas.height}`;
        }

        if (this.statusOverlay.style.display !== 'none') {
            this.statusOverlay.style.display = 'none';
        }

        if (this.glitchOverlay) {
            this.glitchOverlay.classList.toggle('active', signal < 15);
        }
    }

    sendFovCommand() {
        this.signalLink.queueCommand({ 
            op: "command",
            target: "camera",
            camera: this.camInfo.name, 
            id: this.cameraId,
            action: "fov", 
            fov: this.currentFov 
        });
    }

    updateWatchdog() {
        const now = Date.now();
        const diff = now - this.lastFrameTime;
        
        if (diff > 2500) {
            this.statusOverlay.style.display = 'flex';
            if (this.receiver.sync.queue.length > 5) {
                this.statusText.innerText = 'BUFFERING...';
                this.statusText.classList.remove('error');
            } else {
                this.statusText.innerText = 'NO SIGNAL';
                this.statusText.classList.add('error');
            }
        }
    }

    destroy() {
        this.receiver.stop();
        this.dom.remove();
        // v18.14: Standardized unsubscribe API
        this.signalLink.unsubscribeCamera(this.cameraId);
    }
}

if (typeof window !== 'undefined') {
    window.CameraWidget = CameraWidget;
}
