/**
 * OrbitalPhysics (ES6)
 * A lightweight physics engine for KSP orbital maneuvers.
 * Specializing in Hohmann Transfers and Rendezvous nodes.
 */
class OrbitalPhysics {

    /**
     * Calculates a simple Hohmann transfer to intercept a target.
     * Assumes near-circular orbits for the initial approximation.
     * @param {Object} v Active vessel elements (sma, period, meanAnomalyAtEpoch, epoch, trueAnomaly)
     * @param {Object} t Target vessel elements (sma, period, meanAnomalyAtEpoch, epoch, trueAnomaly)
     * @param {number} mu Gravitational parameter of the main body
     * @param {number} currentUT Current Universal Time
     * @returns {Object|null} { ut, dv } or null if invalid
     */
    static calculateRendezvous(v, t, mu, currentUT) {
        if (!v || !t || !mu) return null;

        const r1 = v.sma;
        const r2 = t.sma;
        
        // 1. Calculate transfer orbit properties
        const a_trans = (r1 + r2) / 2;
        const t_trans = Math.PI * Math.sqrt(Math.pow(a_trans, 3) / mu);

        // 2. Angular velocities
        const omega1 = (2 * Math.PI) / v.period;
        const omega2 = (2 * Math.PI) / t.period;

        // 3. Current Phase Angle (rad)
        // Convert to absolute Mean Longitude to eliminate eccentricity timing drift
        const lan1 = (v.lan || 0) * Math.PI / 180;
        const argPe1 = (v.argumentOfPeriapsis || 0) * Math.PI / 180;
        const M1 = this.getMeanAnomaly(v.trueAnomaly, v.eccentricity);
        
        const lan2 = (t.lan || 0) * Math.PI / 180;
        const argPe2 = (t.argumentOfPeriapsis || 0) * Math.PI / 180;
        const M2 = this.getMeanAnomaly(t.trueAnomaly, t.eccentricity);

        const L1 = lan1 + argPe1 + M1;
        const L2 = lan2 + argPe2 + M2;
        // Relative Mean Longitude: Target - Vessel
        let currentPhase = L2 - L1;
        while (currentPhase < 0) currentPhase += 2 * Math.PI;
        while (currentPhase >= 2 * Math.PI) currentPhase -= 2 * Math.PI;

        // 4. Required Phase Angle for rendezvous (rad)
        // The angle the target should have relative to us at the MOMENT OF BURN
        // for us to meet it at the 180-degree point of our transfer.
        let requiredPhase;
        if (r1 < r2) {
            // Catching up from inner orbit
            requiredPhase = Math.PI - (omega2 * t_trans);
        } else {
            // Dropping down from outer orbit
            requiredPhase = Math.PI - (omega2 * t_trans);
        }

        // Normalize required phase
        while (requiredPhase < 0) requiredPhase += 2 * Math.PI;
        while (requiredPhase > 2 * Math.PI) requiredPhase -= 2 * Math.PI;

        // 5. Time to wait for phase alignment
        // relative_omega = omega1 - omega2
        let relativeOmega = omega1 - omega2;
        let angleToWait = (currentPhase - requiredPhase);
        
        // If we are slower (outer orbit), we wait for target to catch up
        if (relativeOmega < 0) {
           while (angleToWait > 0) angleToWait -= 2 * Math.PI;
           while (angleToWait < -2 * Math.PI) angleToWait += 2 * Math.PI;
        } else {
           while (angleToWait < 0) angleToWait += 2 * Math.PI;
           while (angleToWait > 2 * Math.PI) angleToWait -= 2 * Math.PI;
        }

        const waitTime = angleToWait / relativeOmega;
        const burnUT = currentUT + waitTime;

        // 6. Delta-V (Prograde component only)
        // v_start = sqrt(mu/r1)
        // v_trans_at_r1 = sqrt(mu * (2/r1 - 1/a_trans))
        const v_start = Math.sqrt(mu / r1);
        const v_trans = Math.sqrt(mu * (2/r1 - 1/a_trans));
        const dv = v_trans - v_start;

        return {
            ut: burnUT,
            dv: dv,
            transferTime: t_trans,
            waitTime: waitTime
        };
    }

    /**
     * Finds the best rendezvous window out of the next N synodic periods.
     */
    static calculateBestRendezvous(v, t, mu, currentUT, maxWindows = 5) {
        const synodicPeriod = Math.abs((v.period * t.period) / (v.period - t.period));
        let bestResult = null;
        let minSep = Infinity;

        for (let i = 0; i < maxWindows; i++) {
            const res = this.calculateRendezvous(v, t, mu, currentUT + (i * synodicPeriod));
            if (!res) continue;

            // Estimate separation at intercept
            // 1. Target's Mean Anomaly at arrival
            const M_arrival = this.getMeanAnomaly(t.trueAnomaly, t.eccentricity) + (2 * Math.PI / t.period) * (res.waitTime + res.transferTime);
            
            // 2. Target's Radius at arrival
            // r = a(1 - e cos E) -> approximate as r(1 + e cos M)
            const target_r_arrival = t.sma * (1 - t.eccentricity * Math.cos(M_arrival));
            
            // 3. Our Transfer Apoapsis (or Periapsis if dropping)
            const vessel_r_at_burn = v.sma * (1 - v.eccentricity * Math.cos(this.getMeanAnomaly(v.trueAnomaly, v.eccentricity) + (2 * Math.PI / v.period) * res.waitTime));
            const a_trans = (vessel_r_at_burn + target_r_arrival) / 2;
            const arrival_r = 2 * a_trans - vessel_r_at_burn;

            const sep = Math.abs(arrival_r - target_r_arrival);

            if (sep < minSep) {
                minSep = sep;
                bestResult = Object.assign({}, res, { window: i, separation: sep });
            }
        }
        return bestResult;
    }

    /**
     * Converts True Anomaly (degrees) and Eccentricity into Mean Anomaly (radians)
     */
    static getMeanAnomaly(taDeg, e) {
        if (e >= 1) return taDeg * Math.PI / 180; // Not valid for hyperbola/parabola using this solver
        const ta = taDeg * Math.PI / 180;
        const E = Math.atan2(Math.sqrt(1 - e * e) * Math.sin(ta), e + Math.cos(ta));
        let M = E - e * Math.sin(E);
        while (M < 0) M += 2 * Math.PI;
        return M % (2 * Math.PI);
    }

    /**
     * Calculates the phase angle between two bodies in degrees.
     */
    static getPhaseAngle(v, t) {
        const lan1 = (v.lan || 0) * Math.PI / 180;
        const argPe1 = (v.argumentOfPeriapsis || 0) * Math.PI / 180;
        const M1 = this.getMeanAnomaly(v.trueAnomaly, v.eccentricity);
        
        const lan2 = (t.lan || 0) * Math.PI / 180;
        const argPe2 = (t.argumentOfPeriapsis || 0) * Math.PI / 180;
        const M2 = this.getMeanAnomaly(t.trueAnomaly, t.eccentricity);

        let phase = ((lan2 + argPe2 + M2) - (lan1 + argPe1 + M1)) * 180 / Math.PI;
        while (phase < 0) phase += 360;
        return phase % 360;
    }
}

window.OrbitalPhysics = OrbitalPhysics;
