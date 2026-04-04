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
        
        const savedVol = localStorage.getItem('music-volume');
        this.audio.volume = savedVol !== null ? parseFloat(savedVol) : 0.5;
        if (this.elements.volume) this.elements.volume.value = this.audio.volume;

        window.addEventListener('click', () => {
            if (this.audio.paused && this.isPlaying && !this.isMuted) {
                this.audio.play().catch(e => console.warn("[MusicSync] Manual Activation failed:", e));
            }
        }, { once: true });

        this.audio.oncanplay = () => {
            if (this.pendingSeekTime >= 0) {
                console.log(`[MusicSync] Seeking to ${this.pendingSeekTime.toFixed(2)}s`);
                this.audio.currentTime = this.pendingSeekTime;
                
                const target = this.pendingSeekTime;
                setTimeout(() => {
                    if (Math.abs(this.audio.currentTime - target) > 1.0) {
                        this.audio.currentTime = target;
                    }
                    this.pendingSeekTime = -1;
                }, 200);
            }
        };

        this.audio.onerror = (e) => {
            // v16.105: Log the specific error and target URL
            console.error(`[MusicSync] Playback Error for: ${this.audio.src}`, e);
            
            // Only show MISSING AUDIO if we actually have a track name (ignore aborts)
            if (this.currentTrack) {
                this.showError('MISSING AUDIO');
            }
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
                if (this.currentTrack === 'SIGNAL LOST') {
                    this.elements.name.textContent = 'SILENCE';
                    this.elements.name.style.color = '';
                }
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
        this.elements.volume = this.widget.querySelector('#music-volume');
        this.elements.icon = this.elements.toggle.querySelector('.icon');
        
        if (this.elements.toggle) {
            this.elements.toggle.onclick = () => this.toggleMute();
        }

        if (this.elements.volume) {
            this.elements.volume.oninput = (e) => {
                const vol = parseFloat(e.target.value);
                this.audio.volume = vol;
                localStorage.setItem('music-volume', vol);
            };
        }
    }

    showError(text) {
        if (this.elements.name) {
            this.elements.name.textContent = text;
            this.elements.name.style.color = '#ff4c4c';
            this.elements.name.style.textShadow = '0 0 5px rgba(255,76,76,0.5)';
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

        // Normalize name
        const normalizedName = (name || "").toLowerCase();

        if (normalizedName === 'radiosilence' || normalizedName === 'none' || !name) {
            this.stopPlayback();
            return;
        }

        // v16.106: Only reset and load if the track has ACTUALLY changed
        if (name !== this.currentTrack) {
            console.log(`[MusicSync] Switching from ${this.currentTrack} to ${name}`);
            this.currentTrack = name;
            let display = name.split('/').pop().replace('.mp3', '').toUpperCase();
            this.elements.name.textContent = display;
            this.elements.name.style.color = '';
            this.elements.name.style.textShadow = '';
            this.loadTrack(name, time);
        }

        this.isPlaying = isPlaying;

        if (!this.isMuted) {
            if (this.isPlaying) {
                if (this.audio.paused && this.audio.src) {
                    this.audio.play().then(() => this.widget.classList.add('playing')).catch(() => {});
                }
            } else if (!this.audio.paused) {
                this.audio.pause();
                this.widget.classList.remove('playing');
            }

            if (this.isPlaying && this.audio.readyState >= 2) {
                const diff = Math.abs(this.audio.currentTime - time);
                if (diff > this.syncThreshold) {
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
        // v16.107: Robust filename building
        let filename = name.split('/').pop();
        if (!filename.toLowerCase().endsWith('.mp3')) {
            filename += '.mp3';
        }
        
        // Use encodeURIComponent for the filename part to handle spaces and brackets safely
        const finalUrl = `${this.audioPath}${encodeURIComponent(filename)}`;
        console.log(`[MusicSync] Loading Track: ${finalUrl}`);
        
        this.audio.src = finalUrl;
        this.pendingSeekTime = startTime + 0.2;
        this.audio.load();
        
        if (!this.isMuted && this.isPlaying) {
            this.audio.play().catch(() => {});
        }
    }
}

window.MusicSync = new MusicSync();
