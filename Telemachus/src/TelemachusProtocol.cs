using System;
using UnityEngine;

namespace Telemachus
{
    public enum PacketType : byte
    {
        VideoDownlink = 0, VideoUplink = 1, AudioDownlink = 2, AudioUplink = 3
    }

    /// <summary>
    /// Utility class for the Telemachus WebSocket binary protocol.
    /// Handles packet headers and data constants.
    /// </summary>
    public static class TelemachusProtocol
    {
        public const int HEADER_SIZE = 35; // v16.01: Increased to 35 for CameraID

        /// <summary>
        /// Fills the standard 35-byte binary packet header with game state.
        /// </summary>
        public static void FillHeader(byte[] packet, byte type, double ut, double fov, byte cameraID)
        {
            packet[0] = type;
            Vessel v = FlightGlobals.ActiveVessel;
            double warp = TimeWarp.fetch != null ? TimeWarp.CurrentRate : 1.0;
            double delay = (v != null ? TelemachusSignalManager.GetSignalDelay(v) : null) ?? -1.0;
            byte quality = (byte)(v != null ? (TelemachusSignalManager.GetSignalQuality(v) * 100) : 100);
            
            Buffer.BlockCopy(BitConverter.GetBytes(ut), 0, packet, 1, 8);
            Buffer.BlockCopy(BitConverter.GetBytes(warp), 0, packet, 9, 8);
            Buffer.BlockCopy(BitConverter.GetBytes(delay), 0, packet, 17, 8);
            Buffer.BlockCopy(BitConverter.GetBytes(fov), 0, packet, 25, 8);
            packet[33] = quality;
            packet[34] = cameraID; 
        }
    }
}
