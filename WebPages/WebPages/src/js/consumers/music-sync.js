/**
 * Soundtrack Synchronization Module
 * Synchronizes local MP3 playback with KSP in-game music metadata.
 */
class MusicSync {
    constructor() {
        this.audioPath = '../audio/';
        this.currentTrack = null;
        this.audio = new Audio();
        this.isPlaying = false;
        this.isMuted = true;
        this.syncThreshold = 10.0; 
        
        this.widget = null;
        this.elements = {};
        this.pendingSeekTime = -1;

        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', () => this.init());
        } else {
            this.init();
        }
    }

    init() {
        this.bindElements();
        this.audio.loop = false; 
        this.audio.volume = 0.5;

        window.addEventListener('click', () => {
            if (this.audio.paused && this.isPlaying && !this.isMuted) {
                console.log("[MusicSync] Manual Activation: Playback started.");
                this.audio.play().catch(e => console.warn("[MusicSync] Activation failed:", e));
            }
        }, { once: true });

        // v16.71: Handle deferred seeking when metadata is loaded
        this.audio.oncanplay = () => {
            if (this.pendingSeekTime >= 0) {
                console.log(`[MusicSync] oncanplay: Attempting seek to: ${this.pendingSeekTime.toFixed(2)}s`);
                
                // Try to set current time
                this.audio.currentTime = this.pendingSeekTime;
                
                // Verify seek in next tick (v16.100)
                const target = this.pendingSeekTime;
                setTimeout(() => {
                    console.log(`[MusicSync] Seek Verify: Current Time is ${this.audio.currentTime.toFixed(2)}s (Target was ${target.toFixed(2)}s)`);
                    if (Math.abs(this.audio.currentTime - target) > 1.0) {
                        console.warn("[MusicSync] Seek failed or ignored. Forcing again...");
                        this.audio.currentTime = target;
                    }
                    this.pendingSeekTime = -1;
                }, 200);
            }
        };

        this.audio.onerror = (e) => {
            console.error(`[MusicSync] Failed to load track: ${this.audio.src}`);
            this.showError('MISSING AUDIO');
        };

        this.waitForSignalLink();
    }

    waitForSignalLink() {
        if (window.app && window.app.signalLink) {
            window.app.signalLink.on('soundtrack', (msg) => {
                this.handleMetadata(msg);
            });
            window.app.signalLink.on('close', () => {
                this.stopPlayback();
                this.showError('SIGNAL LOST');
            });
            window.app.signalLink.on('open', () => {
                this.elements.name.style.color = '';
                window.app.signalLink.sendSystemCommand({ type: "request-soundtrack" });
            });
            window.app.signalLink.sendSystemCommand({ type: "request-soundtrack" });
        } else {
            setTimeout(() => this.waitForSignalLink(), 100);
        }
    }

    bindElements() {
        this.widget = document.getElementById('music-player-widget');
        if (!this.widget) return;
        this.elements.name = this.widget.querySelector('#music-name');
        this.elements.toggle = this.widget.querySelector('#music-toggle');
        this.elements.icon = this.elements.toggle.querySelector('.icon');
        if (this.elements.toggle) {
            this.elements.toggle.onclick = () => this.toggleMute();
        }
    }

    showError(text) {
        if (this.elements.name) {
            this.elements.name.textContent = text;
            this.elements.name.style.color = '#ff4c4c';
        }
        this.widget.classList.remove('playing');
    }

    toggleMute() {
        this.isMuted = !this.isMuted;
        if (this.isMuted) {
            this.audio.pause();
            this.elements.icon.textContent = '🔇';
            this.elements.toggle.classList.add('muted');
            this.widget.classList.remove('playing');
        } else {
            this.elements.icon.textContent = '🔊';
            this.elements.toggle.classList.remove('muted');
            if (this.isPlaying) {
                this.audio.play().catch(() => {});
                this.widget.classList.add('playing');
            }
        }
    }

    handleMetadata(msg) {
        const { name, time, isPlaying } = msg;
        console.log(`[MusicSync] Metadata: ${name} at ${time.toFixed(2)}s (Playing: ${isPlaying})`);

        if (name && (name.toLowerCase() === 'radiosilence' || name.toLowerCase() === 'none')) {
            this.stopPlayback();
            return;
        }

        if (name && name !== this.currentTrack) {
            this.currentTrack = name;
            let display = name.split('/').pop().replace('.mp3', '').toUpperCase();
            this.elements.name.textContent = display;
            this.elements.name.style.color = '';
            this.loadTrack(name, time);
        } else if (!name) {
            this.stopPlayback();
            return;
        }

        this.isPlaying = isPlaying;

        if (!this.isMuted) {
            if (this.isPlaying && this.audio.paused && this.audio.src) {
                this.audio.play().then(() => this.widget.classList.add('playing')).catch(() => {});
            } else if (!this.isPlaying && !this.audio.paused) {
                this.audio.pause();
                this.widget.classList.remove('playing');
            }

            if (this.isPlaying && this.audio.readyState >= 2) {
                const diff = Math.abs(this.audio.currentTime - time);
                if (diff > this.syncThreshold) {
                    console.log(`[MusicSync] Manual Resync requested: Offset ${diff.toFixed(2)}s`);
                    this.audio.currentTime = time + 0.2;
                }
            }
        }
    }

    stopPlayback() {
        if (this.elements.name && !this.elements.name.style.color) {
            this.elements.name.textContent = 'SILENCE';
        }
        this.currentTrack = null;
        this.audio.pause();
        this.audio.src = '';
        this.widget.classList.remove('playing');
    }

    loadTrack(name, startTime) {
        let filename = name.split('/').pop();
        if (!filename.toLowerCase().endsWith('.mp3')) filename += '.mp3';
        
        console.log(`[MusicSync] Loading: ${this.audioPath}${filename}`);
        this.audio.src = `${this.audioPath}${filename}`;
        this.pendingSeekTime = startTime + 0.2;
        this.audio.load();
        
        if (!this.isMuted && this.isPlaying) {
            this.audio.play().catch(() => {});
        }
    }
}

window.MusicSync = new MusicSync();
